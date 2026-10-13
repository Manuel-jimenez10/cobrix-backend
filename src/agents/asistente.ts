/**
 * Asistente de cobranza (IA). Apoya a la persona que cobra; nunca envía nada por su cuenta:
 *
 *   redactarRecordatorio  escribe el recordatorio personalizado (tono, atraso e historial del cliente).
 *   sugerirRespuestas     propone 3 respuestas a lo que escribió el cliente y detecta si prometió pagar.
 *   resumenDelDia         explica en 2–3 frases a quién cobrar hoy y por qué.
 *
 * Todo pasa por una persona: el mensaje se revisa, se edita y se envía desde su WhatsApp.
 * Si la IA no está disponible (o se agotó la cuota), cada función responde con reglas.
 */
import { generateObject, generateText } from 'ai';
import { z } from 'zod';
import type { Db } from '../domain/db.js';
import { facturasAbiertas, resumenes } from '../domain/logic.js';
import { formatFecha, formatMXN, partesMonto, primerNombre } from '../shared/format.js';
import { limitarTono } from '../shared/politicas.js';
import { aISO, resumenPorReglas, sugerirPorReglas, type DatosResumen, type PromesaDetectada, type Sugerencia } from '../shared/asistente-reglas.js';
import type { ClienteResumen, Tono } from '../shared/types.js';
import { redactar } from './redactor.js';
import { conLimite, hoyTexto, iaDisponible, modelo, opcionesRapidas, registrarErrorIA } from './modelo.js';

export type Origen = 'ia' | 'plantilla';

const TONOS: Record<Tono, string> = {
  amable: 'Amable: primer contacto, cordial, asume que fue un olvido.',
  firme: 'Firme: segundo intento, directo y respetuoso, menciona los días de atraso y pide una fecha concreta esta semana.',
  final: 'Aviso final: serio y respetuoso. Indica que es el último aviso, que sin respuesta en 48 horas el caso pasará a jurídico, y ofrece acordar un plan de pagos hoy.'
};

function historial(db: Db, clienteId: string, n = 6) {
  return db.mensajes
    .filter((m) => m.clienteId === clienteId)
    .slice(-n)
    .map((m) => `${m.rol === 'cliente' ? 'Cliente' : 'Nosotros'} (${formatFecha(m.fecha)}): ${m.contenido}`)
    .join('\n');
}

function contexto(db: Db, c: ClienteResumen) {
  const abiertas = facturasAbiertas(db, c.id);
  const incumplidas = db.promesas.filter((p) => p.clienteId === c.id && p.estado === 'incumplida').length;
  return [
    `Nuestra empresa: ${db.perfil.empresa}`,
    `Cliente: ${primerNombre(c.nombre)} de ${c.empresa}`,
    `Saldo pendiente: ${formatMXN(c.deuda)}`,
    `Facturas: ${abiertas.map((f) => `${f.folio} (${formatMXN(f.monto)}, ${f.diasAtraso} días de atraso)`).join('; ') || 'ninguna'}`,
    `Días de atraso (máximo): ${c.diasAtraso}`,
    `Promesas de pago incumplidas: ${incumplidas}`,
    `Hoy es ${hoyTexto()}.`
  ].join('\n');
}

/* ───────────── Redactar recordatorio ───────────── */

export async function redactarRecordatorio(db: Db, c: ClienteResumen, tono: Tono, usarIA: boolean): Promise<{ texto: string; tono: Tono; origen: Origen }> {
  const t = limitarTono(tono, db.perfil.politicas);
  const plantilla = redactar(db, c, t).contenido;
  if (!usarIA || !iaDisponible) return { texto: plantilla, tono: t, origen: 'plantilla' };
  try {
    const { text } = await generateText({
      model: modelo(),
      providerOptions: opcionesRapidas,
      abortSignal: conLimite(15_000),
      temperature: 0.6,
      system: [
        'Escribes recordatorios de cobranza por WhatsApp para una PyME mexicana. Una persona del equipo lo revisará y lo enviará desde su propio WhatsApp.',
        'Reglas: español de México, trato de tú, máximo 420 caracteres, sin emojis excesivos (máximo 1), sin saludos genéricos de robot.',
        'Incluye el nombre del cliente, el o los folios y el saldo EXACTO tal como aparece. Termina pidiendo una fecha de pago o una respuesta.',
        'No inventes datos: nada de cuentas bancarias, descuentos, recargos con cifras, ni fechas que no estén en los datos. No amenaces salvo lo que permita el tono.',
        'Si hay historial, tómalo en cuenta (por ejemplo, si prometió pagar y no lo hizo, menciónalo con respeto). Devuelve solo el mensaje, sin comillas.'
      ].join('\n'),
      prompt: `${contexto(db, c)}\n\nTono: ${TONOS[t]}\n\nHistorial reciente:\n${historial(db, c.id) || '(sin mensajes previos)'}\n\nPlantilla de referencia (mejórala y personalízala):\n${plantilla}`
    });
    const texto = text.trim().replace(/^["“]|["”]$/g, '');
    // El monto exacto es obligatorio: si la IA lo cambió u omitió, usamos la plantilla.
    const cifra = partesMonto(c.deuda).entero;
    if (texto.length < 40 || texto.length > 700 || !texto.includes(cifra)) return { texto: plantilla, tono: t, origen: 'plantilla' };
    return { texto, tono: t, origen: 'ia' };
  } catch (error) {
    registrarErrorIA('Asistente/redactar', error);
    return { texto: plantilla, tono: t, origen: 'plantilla' };
  }
}

/* ───────────── Sugerir respuestas + detectar promesa ───────────── */

export interface ResultadoSugerencias {
  sugerencias: Sugerencia[];
  promesa: PromesaDetectada | null;
  origen: Origen;
}

const esquemaSugerencias = z.object({
  sugerencias: z
    .array(z.object({ etiqueta: z.string().describe('2 a 4 palabras, p. ej. "Confirmar fecha"'), texto: z.string().describe('Respuesta completa, máximo 300 caracteres') }))
    .min(2)
    .max(3),
  promesa: z.object({
    hay: z.boolean().describe('true solo si el cliente se comprometió a pagar en una fecha concreta'),
    monto: z.number().nullable().describe('Monto prometido en pesos; si no dice cuánto, el saldo total'),
    fecha: z.string().nullable().describe('Fecha prometida en formato AAAA-MM-DD'),
    cita: z.string().nullable().describe('Fragmento literal del mensaje del cliente')
  })
});

export async function sugerirRespuestas(db: Db, c: ClienteResumen, usarIA: boolean): Promise<ResultadoSugerencias> {
  const ultimos = db.mensajes.filter((m) => m.clienteId === c.id);
  const ultimoCliente = [...ultimos].reverse().find((m) => m.rol === 'cliente');
  const folios = facturasAbiertas(db, c.id).map((f) => f.folio).join(' y ');
  const reglas = () => ({ ...sugerirPorReglas(ultimoCliente?.contenido ?? '', { nombre: primerNombre(c.nombre), deuda: c.deuda, folios }), origen: 'plantilla' as const });
  if (!ultimoCliente) return { ...reglas(), promesa: null };
  if (!usarIA || !iaDisponible) return reglas();

  try {
    const { object } = await generateObject({
      model: modelo(),
      providerOptions: opcionesRapidas,
      abortSignal: conLimite(15_000),
      temperature: 0.5,
      schema: esquemaSugerencias,
      system: [
        'Ayudas a una persona de cobranza de una PyME mexicana a contestarle a un cliente por WhatsApp. Ella elige, edita y envía la respuesta.',
        'Propón 3 respuestas distintas entre sí (por ejemplo: aceptar, proponer alternativa, pedir información). Español de México, trato de tú, cálidas y concretas, máximo 300 caracteres.',
        'No inventes datos (cuentas bancarias, descuentos, fechas que nadie dijo). Si el cliente pide dividir el pago, puedes proponer dos pagos iguales del saldo.',
        'Detecta si el cliente PROMETIÓ pagar en una fecha concreta. Convierte expresiones como "el viernes", "mañana" o "el 15" a AAAA-MM-DD tomando como referencia la fecha de hoy. Si solo dice que "va a ver" o no da fecha, hay=false.'
      ].join('\n'),
      prompt: `${contexto(db, c)} (${aISO(new Date())})\n\nConversación reciente:\n${historial(db, c.id, 8)}\n\nÚltimo mensaje del cliente: "${ultimoCliente.contenido}"`
    });

    let promesa: PromesaDetectada | null = null;
    const p = object.promesa;
    if (p.hay && p.fecha && /^\d{4}-\d{2}-\d{2}$/.test(p.fecha) && p.fecha >= aISO(new Date())) {
      const monto = p.monto && p.monto > 0 ? Math.min(p.monto, c.deuda) : c.deuda;
      promesa = { monto: Math.round(monto * 100) / 100, fecha: p.fecha, cita: (p.cita || ultimoCliente.contenido).slice(0, 90) };
    }
    const sugerencias = object.sugerencias
      .map((s) => ({ etiqueta: s.etiqueta.trim().slice(0, 32), texto: s.texto.trim().slice(0, 400) }))
      .filter((s) => s.etiqueta && s.texto);
    if (sugerencias.length < 2) return reglas();
    return { sugerencias, promesa, origen: 'ia' };
  } catch (error) {
    registrarErrorIA('Asistente/sugerir', error);
    return reglas();
  }
}

/* ───────────── Resumen del día ───────────── */

export function datosDelDia(db: Db): DatosResumen {
  const rs = resumenes(db);
  const hoy = aISO(new Date());
  const pendientes = db.promesas.filter((p) => p.estado === 'pendiente' || p.estado === 'incumplida');
  const promesasHoy = pendientes.filter((p) => aISO(new Date(p.fechaCompromiso)) === hoy);
  const vencidas = pendientes.filter((p) => aISO(new Date(p.fechaCompromiso)) < hoy);
  const esperan = rs.filter((r) => r.requiereAtencion);
  const listos = rs.filter((r) => r.deuda > 0 && !r.requiereAtencion && !r.escalado && r.estado === 'vencido');
  return {
    esperan: esperan.map((r) => ({ id: r.id, empresa: r.empresa })),
    top: rs
      .filter((r) => r.deuda > 0 && !r.requiereAtencion && r.estado !== 'promesa')
      .sort((a, b) => b.prioridad.score - a.prioridad.score)
      .slice(0, 3)
      .map((r) => ({ id: r.id, empresa: r.empresa, deuda: r.deuda, diasAtraso: r.diasAtraso, razon: r.prioridad.razon })),
    promesasHoy: { n: promesasHoy.length, monto: promesasHoy.reduce((s, p) => s + p.monto, 0) },
    promesasVencidas: { n: vencidas.length, monto: vencidas.reduce((s, p) => s + p.monto, 0) },
    listosParaRecordatorio: listos.length,
    vencido: rs.filter((r) => r.estado === 'vencido').reduce((s, r) => s + r.deuda, 0)
  };
}

export interface ResumenDia {
  texto: string;
  /** Clientes mencionados, en orden, para mostrarlos como accesos directos. */
  clientes: { id: string; empresa: string }[];
  origen: Origen;
}

const cache = new Map<string, { firma: string; valor: ResumenDia }>();

/** pedirCuota se llama solo si hay que generar un resumen nuevo (el cacheado no consume cuota). */
export async function resumenDelDia(userId: string, db: Db, pedirCuota: () => boolean): Promise<ResumenDia> {
  const datos = datosDelDia(db);
  const clientes = [...datos.esperan.slice(0, 2), ...datos.top.slice(0, 2)].filter((c, i, arr) => arr.findIndex((x) => x.id === c.id) === i).slice(0, 3);
  const base: ResumenDia = { texto: resumenPorReglas(datos), clientes, origen: 'plantilla' };
  if (!iaDisponible) return base;

  const firma = `${aISO(new Date())}|${JSON.stringify(datos)}`;
  const previo = cache.get(userId);
  if (previo?.firma === firma) return previo.valor;
  if (!pedirCuota()) return base;

  try {
    const { text } = await generateText({
      model: modelo(),
      providerOptions: opcionesRapidas,
      abortSignal: conLimite(12_000),
      temperature: 0.4,
      system:
        'Eres el asistente de cobranza de una PyME mexicana. Escribe el resumen del día en 2 o 3 frases (máximo 320 caracteres): qué hacer primero y por qué. ' +
        'Orden: 1) clientes que esperan respuesta, 2) promesas vencidas o que vencen hoy, 3) el cobro más urgente. Usa los nombres de empresa y las cifras exactas de los datos; no inventes nada. Español de México, tono cercano, sin listas ni emojis.',
      prompt: `Hoy es ${hoyTexto()}. Datos (montos en pesos):\n${JSON.stringify(datos)}`
    });
    const texto = text.trim();
    const valor: ResumenDia = texto.length >= 30 && texto.length <= 600 ? { texto, clientes, origen: 'ia' } : base;
    cache.set(userId, { firma, valor });
    if (cache.size > 2000) cache.clear();
    return valor;
  } catch (error) {
    registrarErrorIA('Asistente/resumen', error);
    return base;
  }
}
