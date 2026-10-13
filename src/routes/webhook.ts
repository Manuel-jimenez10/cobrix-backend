/**
 * Webhook de WhatsApp Cloud API.
 *   GET  → verificación de Meta (hub.challenge)
 *   POST → mensajes entrantes. Se responde 200 de inmediato y se procesa en segundo plano
 *          (Meta reintenta si tardamos).
 */
import { Hono } from 'hono';
import { firmaValida, soloDigitos, variantesMx } from '../channels/whatsapp.js';
import { env } from '../env.js';
import { supabase } from '../lib/supabase.js';
import { procesarRespuesta } from '../services/cobranza.js';

export const webhook = new Hono();

webhook.get('/', (c) => {
  const modo = c.req.query('hub.mode');
  const token = c.req.query('hub.verify_token');
  const reto = c.req.query('hub.challenge');
  if (modo === 'subscribe' && token && token === env.whatsapp.verifyToken) return c.text(reto ?? '');
  return c.text('Token de verificación inválido', 403);
});

interface MensajeEntrante {
  from: string;
  id: string;
  type: string;
  text?: { body: string };
  button?: { text: string };
  interactive?: { button_reply?: { title: string }; list_reply?: { title: string } };
}

const procesados = new Set<string>();

/**
 * ¿De qué usuario y cliente es este número?
 * 1) Modo demo: el número coincide con el "teléfono de prueba" de un administrador →
 *    se asigna al cliente al que ese administrador le escribió por WhatsApp más recientemente.
 * 2) Caso real: el número coincide con el teléfono de un cliente.
 */
async function ubicarCliente(digitos: string): Promise<{ userId: string; clienteId: string } | null> {
  const variantes = variantesMx(digitos);

  const { data: perfiles } = await supabase.from('perfiles').select('user_id').in('telefono_prueba_digitos', variantes);
  for (const p of perfiles ?? []) {
    const { data: ultimo } = await supabase
      .from('mensajes')
      .select('cliente_id, fecha')
      .eq('user_id', p.user_id)
      .eq('rol', 'agente')
      .eq('canal', 'whatsapp')
      .order('fecha', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (ultimo) return { userId: p.user_id, clienteId: ultimo.cliente_id };
  }

  const { data: clientes } = await supabase.from('clientes').select('id, user_id').in('telefono_digitos', variantes);
  if (!clientes?.length) return null;
  if (clientes.length === 1) return { userId: clientes[0].user_id, clienteId: clientes[0].id };
  // Mismo número en varias cuentas: el que recibió el último mensaje por WhatsApp.
  const { data: ultimo } = await supabase
    .from('mensajes')
    .select('cliente_id, user_id')
    .in('cliente_id', clientes.map((x) => x.id))
    .eq('canal', 'whatsapp')
    .order('fecha', { ascending: false })
    .limit(1)
    .maybeSingle();
  return ultimo ? { userId: ultimo.user_id, clienteId: ultimo.cliente_id } : { userId: clientes[0].user_id, clienteId: clientes[0].id };
}

async function atender(m: MensajeEntrante) {
  if (procesados.has(m.id)) return; // Meta puede reenviar el mismo evento
  procesados.add(m.id);
  if (procesados.size > 2000) procesados.clear();

  const texto = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title;
  if (!texto) return; // audios, imágenes, etc. no se procesan en la demo

  const destino = await ubicarCliente(soloDigitos(m.from));
  if (!destino) {
    console.warn(`[webhook] Mensaje de un número desconocido (${m.from.slice(0, 5)}…), se ignora.`);
    return;
  }
  await procesarRespuesta(destino.userId, destino.clienteId, texto, 'whatsapp', undefined, m.id);
}

webhook.post('/', async (c) => {
  const crudo = await c.req.text();
  if (!firmaValida(crudo, c.req.header('x-hub-signature-256'))) return c.text('Firma inválida', 401);

  let cuerpo: { entry?: { changes?: { value?: { messages?: MensajeEntrante[] } }[] }[] };
  try {
    cuerpo = JSON.parse(crudo);
  } catch {
    return c.text('JSON inválido', 400);
  }
  const mensajes = cuerpo.entry?.flatMap((e) => e.changes?.flatMap((ch) => ch.value?.messages ?? []) ?? []) ?? [];
  for (const m of mensajes) {
    void atender(m).catch((error) => console.error('[webhook] Error al procesar mensaje:', error));
  }
  return c.text('OK');
});
