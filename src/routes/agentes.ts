/**
 * Endpoints de agentes. Responden en streaming NDJSON (una línea JSON por evento)
 * para que la UI vea el progreso y el texto de la IA mientras se genera.
 */
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { stream } from 'hono/streaming';
import { z } from 'zod';
import { dirigir } from '../agents/director.js';
import { cargarDb, obtenerPerfil } from '../domain/db.js';
import { limiteIA, type AppEnv } from '../middleware/auth.js';
import { iniciarCobranza, procesarRespuesta } from '../services/cobranza.js';
import { describirHorario, dentroDeHorario } from '../shared/politicas.js';
import type { MensajeDirector } from '../shared/director-types.js';

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
    throw new HTTPException(409, { message: `Fuera del horario de cobranza (${describirHorario(perfil.politicas)}). Puedes cambiarlo en Ajustes → Políticas de negociación.` });
  }
  return ndjson(c, async (enviar) => {
    const resultado = await iniciarCobranza(userId, clienteIds, { tono, onProgreso: (progreso) => enviar({ tipo: 'progreso', progreso }) });
    enviar({ tipo: 'resultado', resultado });
  });
});

agentes.post('/cobranza/responder', limiteIA, async (c) => {
  const { clienteId, mensaje } = z.object({ clienteId: z.string(), mensaje: z.string().trim().min(1).max(1000) }).parse(await c.req.json());
  const userId = c.get('userId');
  return ndjson(c, (enviar) => procesarRespuesta(userId, clienteId, mensaje, 'simulador', enviar));
});

const bloque = z.object({ tipo: z.string() }).passthrough();
agentes.post('/director/chat', limiteIA, async (c) => {
  const { mensajes } = z
    .object({
      mensajes: z
        .array(z.object({ id: z.string(), rol: z.enum(['usuario', 'director']), bloques: z.array(bloque), fecha: z.string() }).passthrough())
        .min(1)
        .max(60)
    })
    .parse(await c.req.json());
  const userId = c.get('userId');
  return ndjson(c, async (enviar) => {
    const db = await cargarDb(userId);
    await dirigir(db, mensajes as unknown as MensajeDirector[], enviar);
    enviar({ tipo: 'fin' });
  });
});
