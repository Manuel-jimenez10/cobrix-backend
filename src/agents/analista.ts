/**
 * Analista: decide a quién cobrar primero y explica por qué.
 *
 * Es 100 % reglas (sin IA): monto, días de atraso, mensajes sin respuesta y
 * promesas. Es instantáneo, gratis y siempre explicable: el equipo puede ver
 * exactamente por qué un cliente va primero.
 */
import type { Db } from '../domain/db.js';
import { nivelDeScore, porFecha } from '../domain/logic.js';
import { formatMXN } from '../shared/format.js';
import type { ClienteResumen, Prioridad } from '../shared/types.js';

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
  requiereAtencion: boolean;
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
    requiereAtencion: c.requiereAtencion,
    scoreBase
  };
}

function razonPorReglas(h: Hechos): string {
  const partes = [`${h.diasAtraso} días de atraso y ${formatMXN(h.deuda)} pendientes.`];
  if (h.requiereAtencion) partes.push('Respondió y espera que alguien del equipo le conteste.');
  else if (h.escalado) partes.push('Caso en revisión del equipo: no conviene enviar recordatorios automáticos.');
  else if (h.promesaActiva) partes.push('Tiene una promesa de pago activa: vigilar que cumpla.');
  else if (h.mensajesSinRespuesta >= 2) partes.push(`${h.mensajesSinRespuesta} mensajes sin respuesta: el riesgo crece cada semana.`);
  else if (h.respondioAlgunaVez) partes.push('Ha respondido antes: buena probabilidad de acordar una fecha.');
  if (h.promesasIncumplidas) partes.push(`Incumplió ${h.promesasIncumplidas} promesa(s).`);
  return partes.join(' ');
}

/** Priorización por reglas: instantánea y determinista. */
export function priorizar(db: Db, clientes: ClienteResumen[]): Prioridad[] {
  const maxDeuda = Math.max(0, ...clientes.map((c) => c.deuda));
  return clientes.map((c) => {
    const h = hechosDe(db, c, maxDeuda);
    return { clienteId: h.clienteId, score: h.scoreBase, nivel: nivelDeScore(h.scoreBase), razon: razonPorReglas(h) };
  });
}
