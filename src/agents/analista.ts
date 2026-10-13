/**
 * Analista: decide a quién cobrar primero y explica por qué.
 *
 * Diseño: un score base determinista (monto, atraso, respuestas, promesas)
 * y la IA lo ajusta ±15 puntos con contexto cualitativo y redacta la razón.
 * Así los números nunca dependen de que el modelo "haga cuentas", y si la IA
 * falla, el score base sigue siendo útil.
 */
import { generateObject } from 'ai';
import { z } from 'zod';
import type { Db } from '../domain/db.js';
import { nivelDeScore, porFecha } from '../domain/logic.js';
import { formatMXN } from '../shared/format.js';
import type { ClienteResumen, Prioridad } from '../shared/types.js';
import { conLimite, hoyTexto, iaDisponible, modelo, opcionesRapidas, registrarErrorIA } from './modelo.js';

interface Hechos {
  clienteId: string;
  empresa: string;
  deuda: number;
  diasAtraso: number;
  facturasAbiertas: number;
  mensajesSinRespuesta: number;
  respondioAlgunaVez: boolean;
  promesaActiva: boolean;
  promesasIncumplidas: number;
  escalado: boolean;
  ultimoMensajeCliente: string | null;
  scoreBase: number;
}

function hechosDe(db: Db, c: ClienteResumen, maxDeuda: number): Hechos {
  const msgs = db.mensajes.filter((m) => m.clienteId === c.id).sort(porFecha);
  let sinRespuesta = 0;
  for (let i = msgs.length - 1; i >= 0 && msgs[i].rol === 'agente'; i--) sinRespuesta++;
  const delCliente = msgs.filter((m) => m.rol === 'cliente');
  const promesas = db.promesas.filter((p) => p.clienteId === c.id);
  const promesaActiva = promesas.some((p) => p.estado === 'pendiente');
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const incumplidas = promesas.filter((p) => p.estado === 'incumplida' || (p.estado === 'pendiente' && new Date(p.fechaCompromiso) < hoy)).length;

  // Score base: 0-100
  const atraso = Math.min(c.diasAtraso / 120, 1) * 45;
  const monto = (maxDeuda > 0 ? c.deuda / maxDeuda : 0) * 35;
  const silencio = Math.min(sinRespuesta, 3) * 5;
  const ajustePromesa = promesaActiva ? -15 : 0;
  const scoreBase = Math.max(0, Math.min(100, Math.round(atraso + monto + silencio + incumplidas * 8 + ajustePromesa)));

  return {
    clienteId: c.id,
    empresa: c.empresa,
    deuda: c.deuda,
    diasAtraso: c.diasAtraso,
    facturasAbiertas: c.facturasAbiertas,
    mensajesSinRespuesta: sinRespuesta,
    respondioAlgunaVez: delCliente.length > 0,
    promesaActiva,
    promesasIncumplidas: incumplidas,
    escalado: c.escalado,
    ultimoMensajeCliente: delCliente.at(-1)?.contenido ?? null,
    scoreBase
  };
}

function razonPorReglas(h: Hechos): string {
  const partes = [`${h.diasAtraso} días de atraso y ${formatMXN(h.deuda)} pendientes.`];
  if (h.escalado) partes.push('Caso escalado a humano: no conviene enviar mensajes automáticos.');
  else if (h.promesaActiva) partes.push('Tiene una promesa de pago activa: vigilar que cumpla.');
  else if (h.mensajesSinRespuesta >= 2) partes.push(`${h.mensajesSinRespuesta} mensajes sin respuesta: el riesgo crece cada semana.`);
  else if (h.respondioAlgunaVez) partes.push('Ha respondido antes: buena probabilidad de acordar una fecha.');
  if (h.promesasIncumplidas) partes.push(`Incumplió ${h.promesasIncumplidas} promesa(s).`);
  return partes.join(' ');
}

const esquema = z.object({
  prioridades: z.array(
    z.object({
      clienteId: z.string(),
      score: z.number().int().min(0).max(100),
      razon: z.string().describe('1 o 2 frases en español de México, concretas, citando datos del cliente')
    })
  )
});

/**
 * Priorización instantánea (reglas): no bloquea el envío de mensajes.
 */
export function priorizarRapido(db: Db, clientes: ClienteResumen[]): Prioridad[] {
  const maxDeuda = Math.max(0, ...clientes.map((c) => c.deuda));
  return clientes.map((c) => {
    const h = hechosDe(db, c, maxDeuda);
    return { clienteId: h.clienteId, score: h.scoreBase, nivel: nivelDeScore(h.scoreBase), razon: razonPorReglas(h) };
  });
}

/**
 * La IA afina el score (±15) y redacta la razón. Se ejecuta en segundo plano después
 * de la priorización rápida, así la cobranza arranca al instante.
 */
export async function afinarConIA(db: Db, clientes: ClienteResumen[]): Promise<Prioridad[] | null> {
  if (!iaDisponible || !clientes.length) return null;
  const maxDeuda = Math.max(0, ...clientes.map((c) => c.deuda));
  const hechos = clientes.map((c) => hechosDe(db, c, maxDeuda));
  try {
    const { object } = await generateObject({
      model: modelo(),
      schema: esquema,
      temperature: 0.3,
      providerOptions: opcionesRapidas,
      abortSignal: conLimite(25_000),
      system:
        'Eres el Analista de cobranza de una PyME mexicana. Recibes hechos de cada cliente con un scoreBase calculado por reglas. ' +
        'Ajusta cada score como máximo ±15 puntos solo si hay contexto cualitativo que lo justifique (por ejemplo: reconoció la deuda y pidió opciones, ' +
        'disputa el cargo, historial de buen pago, promesa activa). Escribe una razón breve (máximo 25 palabras) y accionable para el equipo. ' +
        'No inventes datos que no estén en los hechos. Devuelve todos los clientes recibidos.',
      prompt: `Hoy es ${hoyTexto()}.\n\nClientes:\n${JSON.stringify(hechos)}`
    });
    const porId = new Map(object.prioridades.map((p) => [p.clienteId, p]));
    return hechos
      .filter((h) => porId.has(h.clienteId))
      .map((h) => {
        const ia = porId.get(h.clienteId)!;
        const score = Math.max(0, Math.min(100, Math.max(h.scoreBase - 15, Math.min(h.scoreBase + 15, ia.score))));
        return { clienteId: h.clienteId, score, nivel: nivelDeScore(score), razon: ia.razon.trim() || razonPorReglas(h) };
      });
  } catch (error) {
    registrarErrorIA('Analista', error);
    return null;
  }
}
