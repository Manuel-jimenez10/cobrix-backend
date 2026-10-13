/**
 * Políticas de negociación configurables por empresa.
 * Las reglas se le explican al modelo en el prompt, pero el backend las HACE CUMPLIR
 * en código: si el agente intenta algo fuera de política, la herramienta lo rechaza.
 * (Archivo compartido: hay una copia idéntica en el frontend, src/types/politicas.ts)
 */
import { formatMXN } from './format.js';
import type { Tono } from './types.js';

export type MotivoEscalamiento = 'disputa' | 'productoDefectuoso' | 'legal' | 'pideHumano';

export interface Politicas {
  /** Número máximo de pagos en que se puede dividir el saldo (1 = solo pago total). */
  maxPagos: number;
  /** Días máximos desde hoy para el primer pago comprometido. */
  plazoMaxDias: number;
  /** Porcentaje mínimo del saldo que debe cubrir el primer pago parcial (0 = sin mínimo). */
  pagoInicialMinPct: number;
  /** Descuento máximo por liquidar el total (0 = no se ofrecen descuentos). */
  descuentoMaxPct: number;
  /** Tono más fuerte que puede usar el Redactor. */
  tonoMaximo: Tono;
  escalar: Record<MotivoEscalamiento, boolean> & {
    /** Saldos mayores a este monto los atiende siempre un humano (null = sin límite). */
    montoMayorA: number | null;
  };
  /** Horario permitido para INICIAR cobranza. Las respuestas a mensajes del cliente se atienden siempre. */
  horario: {
    activo: boolean;
    /** 0 = domingo … 6 = sábado */
    dias: number[];
    desde: string; // "HH:MM"
    hasta: string; // "HH:MM"
  };
}

export const POLITICAS_DEFAULT: Politicas = {
  maxPagos: 2,
  plazoMaxDias: 30,
  pagoInicialMinPct: 0,
  descuentoMaxPct: 0,
  tonoMaximo: 'final',
  escalar: { disputa: true, productoDefectuoso: true, legal: true, pideHumano: true, montoMayorA: null },
  horario: { activo: false, dias: [1, 2, 3, 4, 5, 6], desde: '09:00', hasta: '20:00' }
};

export const ETIQUETAS_MOTIVO: Record<MotivoEscalamiento, string> = {
  disputa: 'Disputa o no reconoce el cargo',
  productoDefectuoso: 'Producto o servicio defectuoso',
  legal: 'Menciona abogados, PROFECO o demandas',
  pideHumano: 'Pide hablar con una persona'
};

const DIAS_CORTOS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

/** Completa una política parcial (por ejemplo, guardada antes de agregar un campo) con los valores por defecto. */
export function conDefaults(parcial: unknown): Politicas {
  const p = (parcial && typeof parcial === 'object' ? parcial : {}) as Partial<Politicas>;
  return {
    ...POLITICAS_DEFAULT,
    ...p,
    escalar: { ...POLITICAS_DEFAULT.escalar, ...(p.escalar ?? {}) },
    horario: { ...POLITICAS_DEFAULT.horario, ...(p.horario ?? {}) }
  };
}

const ORDEN_TONO: Tono[] = ['amable', 'firme', 'final'];

/** Limita el tono al máximo permitido por la empresa. */
export function limitarTono(tono: Tono, p: Politicas): Tono {
  return ORDEN_TONO.indexOf(tono) > ORDEN_TONO.indexOf(p.tonoMaximo) ? p.tonoMaximo : tono;
}

const aMinutos = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

export function dentroDeHorario(p: Politicas, fecha = new Date()): boolean {
  if (!p.horario.activo) return true;
  if (!p.horario.dias.includes(fecha.getDay())) return false;
  const ahora = fecha.getHours() * 60 + fecha.getMinutes();
  return ahora >= aMinutos(p.horario.desde) && ahora <= aMinutos(p.horario.hasta);
}

export function describirHorario(p: Politicas): string {
  if (!p.horario.activo) return 'Sin restricción de horario';
  const dias = [...p.horario.dias].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DIAS_CORTOS[d]);
  return `${dias.join(', ')} · ${p.horario.desde}–${p.horario.hasta}`;
}

export type ResultadoValidacion = { ok: true } | { ok: false; motivo: string };

/**
 * Valida una promesa de pago contra la política. La usa la herramienta registrar_promesa del Negociador:
 * si no cumple, el agente recibe el motivo y debe reformular su propuesta.
 */
export function validarPromesa(
  p: Politicas,
  saldo: number,
  propuesta: { monto: number; dias: number; pagos: number; liquidaTotal: boolean }
): ResultadoValidacion {
  if (propuesta.dias > p.plazoMaxDias) {
    return { ok: false, motivo: `El primer pago no puede ser a más de ${p.plazoMaxDias} días. Propón una fecha más cercana.` };
  }
  if (propuesta.liquidaTotal) {
    const descuento = saldo > 0 ? ((saldo - propuesta.monto) / saldo) * 100 : 0;
    if (descuento > p.descuentoMaxPct + 0.01) {
      return {
        ok: false,
        motivo: p.descuentoMaxPct > 0
          ? `El descuento máximo permitido es ${p.descuentoMaxPct}%: el monto mínimo para liquidar es ${formatMXN(Math.ceil(saldo * (1 - p.descuentoMaxPct / 100)))}.`
          : 'No se permiten descuentos: para liquidar se debe pagar el saldo completo.'
      };
    }
    return { ok: true };
  }
  if (propuesta.pagos > p.maxPagos) {
    return {
      ok: false,
      motivo: p.maxPagos === 1 ? 'No se permite pagar en partes: el cliente debe cubrir el saldo en un solo pago.' : `Se permite dividir en máximo ${p.maxPagos} pagos.`
    };
  }
  const minimo = (saldo * p.pagoInicialMinPct) / 100;
  if (propuesta.monto + 0.01 < minimo) {
    return { ok: false, motivo: `El primer pago debe ser de al menos ${p.pagoInicialMinPct}% del saldo (${formatMXN(Math.ceil(minimo))}).` };
  }
  return { ok: true };
}

/** Explica la política al modelo, en lenguaje natural. */
export function describirParaAgente(p: Politicas): string {
  const lineas = [
    p.maxPagos > 1
      ? `- Puedes ofrecer dividir el saldo en hasta ${p.maxPagos} pagos, con 15 días entre cada uno.`
      : '- NO ofrezcas pagos en partes: el saldo se cubre en un solo pago.',
    `- El primer pago debe ser en máximo ${p.plazoMaxDias} días a partir de hoy.`,
    p.pagoInicialMinPct > 0 ? `- Si paga en partes, el primer pago debe ser de al menos ${p.pagoInicialMinPct}% del saldo.` : '',
    p.descuentoMaxPct > 0
      ? `- Si liquida el total en un solo pago, puedes ofrecer hasta ${p.descuentoMaxPct}% de descuento (solo si ayuda a cerrar).`
      : '- No ofrezcas descuentos ni condonaciones.'
  ];
  const escalables = (Object.keys(ETIQUETAS_MOTIVO) as MotivoEscalamiento[]).filter((m) => p.escalar[m]);
  const noEscalables = (Object.keys(ETIQUETAS_MOTIVO) as MotivoEscalamiento[]).filter((m) => !p.escalar[m]);
  if (escalables.length) lineas.push(`- Escala a un humano si: ${escalables.map((m) => ETIQUETAS_MOTIVO[m].toLowerCase()).join('; ')}.`);
  if (noEscalables.length) lineas.push(`- NO escales por: ${noEscalables.map((m) => ETIQUETAS_MOTIVO[m].toLowerCase()).join('; ')}. Atiéndelo tú con empatía.`);
  return lineas.filter(Boolean).join('\n');
}
