/**
 * Endpoints de cobranza, conversación con clientes y la Guía (IA).
 * El envío de recordatorios y la Guía responden en streaming NDJSON (una línea JSON por evento).
 */
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { stream } from 'hono/streaming';
import { z } from 'zod';
import { guiar } from '../agents/guia.js';
import { cargarDb, obtenerPerfil } from '../domain/db.js';
import { limiteIA, type AppEnv } from '../middleware/auth.js';
import { iniciarCobranza, recibirRespuesta, registrarPromesa, responderComoEquipo } from '../services/cobranza.js';
import { describirHorario, dentroDeHorario } from '../shared/politicas.js';
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

agentes.post('/cobranza/iniciar', limiteIA, async (c) => {
  const { clienteIds, tono } = z
    .object({ clienteIds: z.array(z.string()).min(1).max(50), tono: z.enum(['amable', 'firme', 'final']).optional() })
    .parse(await c.req.json());
  const userId = c.get('userId');
  // Validamos el horario antes de abrir el stream para responder con un error HTTP claro.
  const perfil = await obtenerPerfil(userId);
  if (perfil && !dentroDeHorario(perfil.politicas)) {
    throw new HTTPException(409, { message: `Fuera del horario de cobranza (${describirHorario(perfil.politicas)}). Puedes cambiarlo en Ajustes → Reglas de cobranza.` });
  }
  return ndjson(c, async (enviar) => {
    const resultado = await iniciarCobranza(userId, clienteIds, { tono, onProgreso: (progreso) => enviar({ tipo: 'progreso', progreso }) });
    enviar({ tipo: 'resultado', resultado });
  });
});

const texto = z.string().trim().min(1).max(1000);

/** Simulador: el administrador escribe como si fuera el cliente. */
agentes.post('/cobranza/responder', async (c) => {
  const { clienteId, mensaje } = z.object({ clienteId: z.string(), mensaje: texto }).parse(await c.req.json());
  return c.json({ mensaje: await recibirRespuesta(c.get('userId'), clienteId, mensaje, 'simulador') });
});

/** Una persona del equipo responde al cliente. */
agentes.post('/clientes/:id/responder', async (c) => {
  const { texto: t } = z.object({ texto }).parse(await c.req.json());
  return c.json({ mensaje: await responderComoEquipo(c.get('userId'), c.req.param('id'), t) });
});

/** Registra la promesa de pago acordada por el equipo. */
agentes.post('/clientes/:id/promesa', async (c) => {
  const datos = z
    .object({ monto: z.number().positive().max(100_000_000), fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD') })
    .parse(await c.req.json());
  return c.json({ promesa: await registrarPromesa(c.get('userId'), c.req.param('id'), datos) });
});

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
