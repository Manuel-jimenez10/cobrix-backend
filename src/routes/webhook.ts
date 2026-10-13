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
import { recibirRespuesta } from '../services/cobranza.js';

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

/** Cliente de una cuenta cuyo teléfono coincide (o, en demo, el último al que se le escribió). */
async function clienteDeCuenta(userId: string, variantes: string[], telefonoPrueba: string | null): Promise<string | null> {
  const { data: clientes } = await supabase.from('clientes').select('id').eq('user_id', userId).in('telefono_digitos', variantes).limit(1);
  if (clientes?.[0]) return clientes[0].id;
  // Demo: el administrador responde desde su "teléfono de prueba" → el último cliente al que se le escribió por WhatsApp.
  if (telefonoPrueba && variantes.some((v) => variantesMx(soloDigitos(telefonoPrueba)).includes(v))) {
    const { data: ultimo } = await supabase
      .from('mensajes')
      .select('cliente_id')
      .eq('user_id', userId)
      .eq('rol', 'agente')
      .eq('canal', 'whatsapp')
      .order('fecha', { ascending: false })
      .limit(1)
      .maybeSingle();
    return ultimo?.cliente_id ?? null;
  }
  return null;
}

/**
 * ¿De qué cuenta y cliente es este mensaje?
 * 1) El número de Cobrix que lo recibió pertenece a una empresa (WhatsApp propio) → se busca en su cartera.
 * 2) Número compartido de demo → se busca por el teléfono de prueba del administrador o por el teléfono del cliente.
 */
async function ubicarCliente(digitos: string, phoneNumberId: string | undefined): Promise<{ userId: string; clienteId: string } | null> {
  const variantes = variantesMx(digitos);

  if (phoneNumberId) {
    const { data: dueño } = await supabase.from('perfiles').select('user_id, telefono_prueba').eq('wa_phone_number_id', phoneNumberId).maybeSingle();
    if (dueño) {
      const clienteId = await clienteDeCuenta(dueño.user_id, variantes, dueño.telefono_prueba);
      return clienteId ? { userId: dueño.user_id, clienteId } : null;
    }
  }

  const { data: perfiles } = await supabase.from('perfiles').select('user_id, telefono_prueba').in('telefono_prueba_digitos', variantes);
  for (const p of perfiles ?? []) {
    const clienteId = await clienteDeCuenta(p.user_id, variantes, p.telefono_prueba);
    if (clienteId) return { userId: p.user_id, clienteId };
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

async function atender(m: MensajeEntrante, phoneNumberId?: string) {
  if (procesados.has(m.id)) return; // Meta puede reenviar el mismo evento
  procesados.add(m.id);
  if (procesados.size > 2000) procesados.clear();

  const texto = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title;
  if (!texto) return; // audios, imágenes, etc. no se procesan en la demo

  const destino = await ubicarCliente(soloDigitos(m.from), phoneNumberId);
  if (!destino) {
    console.warn(`[webhook] Mensaje de un número desconocido (${m.from.slice(0, 5)}…), se ignora.`);
    return;
  }
  await recibirRespuesta(destino.userId, destino.clienteId, texto, 'whatsapp', m.id);
}

webhook.post('/', async (c) => {
  const crudo = await c.req.text();
  if (!firmaValida(crudo, c.req.header('x-hub-signature-256'))) return c.text('Firma inválida', 401);

  let cuerpo: { entry?: { changes?: { value?: { metadata?: { phone_number_id?: string }; messages?: MensajeEntrante[] } }[] }[] };
  try {
    cuerpo = JSON.parse(crudo);
  } catch {
    return c.text('JSON inválido', 400);
  }
  for (const cambio of cuerpo.entry?.flatMap((e) => e.changes ?? []) ?? []) {
    const numeroCobrix = cambio.value?.metadata?.phone_number_id;
    for (const m of cambio.value?.messages ?? []) {
      void atender(m, numeroCobrix).catch((error) => console.error('[webhook] Error al procesar mensaje:', error));
    }
  }
  return c.text('OK');
});
