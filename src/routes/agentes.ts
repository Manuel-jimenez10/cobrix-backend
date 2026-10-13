/**
 * Endpoints de cobranza, conversación con clientes, asistente de cobranza (IA) y la Guía (IA).
 * La preparación de recordatorios y la Guía responden en streaming NDJSON (una línea JSON por evento).
 *
 * Nada sale solo: Cobrix prepara el mensaje y una persona lo envía desde su WhatsApp
 * (enlace wa.me). Luego la app registra el envío con POST /clientes/:id/envio.
 */
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { stream } from 'hono/streaming';
import { z } from 'zod';
import { redactarRecordatorio, resumenDelDia, sugerirRespuestas } from '../agents/asistente.js';
import { guiar } from '../agents/guia.js';
import { cargarDb, obtenerPerfil } from '../domain/db.js';
import { resumir } from '../domain/logic.js';
import { cuotaIA, limiteIA, type AppEnv } from '../middleware/auth.js';
import { ErrorDeNegocio, prepararCobranza, recibirRespuesta, registrarEnvio, registrarPromesa } from '../services/cobranza.js';
import { describirHorario, dentroDeHorario } from '../shared/politicas.js';
import { siguienteTono } from '../shared/reglas.js';
import type { MensajeGuia } from '../shared/guia-types.js';

export const agentes = new Hono<AppEnv>();

function ndjson(c: Context<AppEnv>, trabajo: (enviar: (ev: unknown) => void) => Promise<void>) {
  c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
  c.header('Cache-Control', 'no-cache, no-transform');
  c.header('X-Accel-Buffering', 'no');
  return stream(c, async (s) => {
    const cola: Promise<unknown>[] = [];
    const enviar = (ev: unknown) => {
      cola.push(s.write(`${JSON.stringify(ev)}\n`));
    };
    try {
      await trabajo(enviar);
    } catch (error) {
      console.error(error);
      enviar({ tipo: 'error', mensaje: error instanceof Error ? error.message : 'Error inesperado' });
    }
    await Promise.all(cola);
  });
}

const tono = z.enum(['amable', 'firme', 'final']);

/** Prioriza y redacta los recordatorios. Devuelve borradores; no envía nada. */
agentes.post('/cobranza/preparar', async (c) => {
  const { clienteIds, tono: t, conIA } = z
    .object({ clienteIds: z.array(z.string()).min(1).max(50), tono: tono.optional(), conIA: z.boolean().default(true) })
    .parse(await c.req.json());
  const userId = c.get('userId');
  // Validamos el horario antes de abrir el stream para responder con un error HTTP claro.
  const perfil = await obtenerPerfil(userId);
  if (perfil && !dentroDeHorario(perfil.politicas)) {
    throw new HTTPException(409, { message: `Fuera del horario de cobranza (${describirHorario(perfil.politicas)}). Puedes cambiarlo en Ajustes → Reglas de cobranza.` });
  }
  // La IA redacta si hay cuota para toda la tanda; si no, se usan plantillas.
  const usarIA = conIA && cuotaIA(userId, Math.min(clienteIds.length, 10));
  return ndjson(c, async (enviar) => {
    const resultado = await prepararCobranza(userId, clienteIds, { tono: t, usarIA, onProgreso: (progreso) => enviar({ tipo: 'progreso', progreso }) });
    enviar({ tipo: 'resultado', resultado });
  });
});

const texto = z.string().trim().min(1).max(1000);

/** La persona envió un mensaje desde su WhatsApp: se registra en la conversación. */
agentes.post('/clientes/:id/envio', async (c) => {
  const datos = z
    .object({ texto: z.string().trim().min(1).max(1500), tono: tono.nullable().default(null), origen: z.enum(['ia', 'plantilla', 'manual']).default('manual') })
    .parse(await c.req.json());
  return c.json({ mensaje: await registrarEnvio(c.get('userId'), c.req.param('id'), datos) });
});

/** Lo que respondió el cliente por WhatsApp (la persona lo pega en la app). */
agentes.post('/clientes/:id/respuesta', async (c) => {
  const { texto: t } = z.object({ texto }).parse(await c.req.json());
  return c.json({ mensaje: await recibirRespuesta(c.get('userId'), c.req.param('id'), t, 'manual') });
});

/** Compatibilidad con versiones anteriores del frontend. */
agentes.post('/cobranza/responder', async (c) => {
  const { clienteId, mensaje } = z.object({ clienteId: z.string(), mensaje: texto }).parse(await c.req.json());
  return c.json({ mensaje: await recibirRespuesta(c.get('userId'), clienteId, mensaje, 'manual') });
});

/** Registra la promesa de pago acordada por el equipo. */
agentes.post('/clientes/:id/promesa', async (c) => {
  const datos = z
    .object({ monto: z.number().positive().max(100_000_000), fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD') })
    .parse(await c.req.json());
  return c.json({ promesa: await registrarPromesa(c.get('userId'), c.req.param('id'), datos) });
});

/* ───────────── Asistente de cobranza (IA con respaldo por reglas) ───────────── */

async function clienteDe(userId: string, id: string) {
  const db = await cargarDb(userId);
  const cliente = db.clientes.find((x) => x.id === id);
  if (!cliente) throw new ErrorDeNegocio('Cliente no encontrado');
  return { db, resumen: resumir(db, cliente) };
}

/** Redacta (o reescribe) el recordatorio de un cliente. */
agentes.post('/clientes/:id/redactar', async (c) => {
  const { tono: t } = z.object({ tono: tono.optional() }).parse(await c.req.json().catch(() => ({})));
  const userId = c.get('userId');
  const { db, resumen } = await clienteDe(userId, c.req.param('id'));
  const elegido = t ?? siguienteTono(db.mensajes.filter((m) => m.clienteId === resumen.id));
  return c.json(await redactarRecordatorio(db, resumen, elegido, cuotaIA(userId)));
});

/** 3 respuestas sugeridas al último mensaje del cliente + promesa de pago detectada. */
agentes.post('/clientes/:id/sugerencias', async (c) => {
  const userId = c.get('userId');
  const { db, resumen } = await clienteDe(userId, c.req.param('id'));
  return c.json(await sugerirRespuestas(db, resumen, cuotaIA(userId)));
});

/** Resumen del día: a quién cobrar hoy y por qué (se cachea mientras los datos no cambien). */
agentes.get('/resumen-diario', async (c) => {
  const userId = c.get('userId');
  const db = await cargarDb(userId);
  return c.json(await resumenDelDia(userId, db, () => cuotaIA(userId)));
});

/* ───────────── Guía ───────────── */

agentes.post('/guia/chat', limiteIA, async (c) => {
  const { mensajes, pantalla } = z
    .object({
      mensajes: z.array(z.object({ rol: z.enum(['usuario', 'guia']), texto: z.string().max(4000) })).min(1).max(40),
      pantalla: z.string().max(120).default('/')
    })
    .parse(await c.req.json());
  const userId = c.get('userId');
  return ndjson(c, async (enviar) => {
    const db = await cargarDb(userId);
    await guiar(db, mensajes as MensajeGuia[], pantalla, enviar);
    enviar({ tipo: 'fin' });
  });
});
