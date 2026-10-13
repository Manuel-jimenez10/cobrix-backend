/**
 * Asistente de cobranza SIN IA: reglas que se usan cuando el modelo no está
 * disponible (o se agotó la cuota). El frontend tiene una copia en utils/asistente.ts
 * para la demo sin servidor; si cambias algo aquí, cámbialo allá también.
 */
import { formatFecha, formatMXN, normalizar } from './format.js';

export interface Sugerencia {
  /** Texto corto del botón, p. ej. "Confirmar fecha". */
  etiqueta: string;
  /** Mensaje completo listo para revisar y enviar. */
  texto: string;
}

export interface PromesaDetectada {
  monto: number;
  /** AAAA-MM-DD */
  fecha: string;
  /** Fragmento del mensaje del cliente en que se basa. */
  cita: string;
}

export interface ContextoRespuesta {
  nombre: string;
  deuda: number;
  folios: string;
}

export interface DatosResumen {
  esperan: { id: string; empresa: string }[];
  top: { id: string; empresa: string; deuda: number; diasAtraso: number; razon: string }[];
  promesasHoy: { n: number; monto: number };
  promesasVencidas: { n: number; monto: number };
  listosParaRecordatorio: number;
  vencido: number;
}

const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

export const aISO = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const sumarDias = (base: Date, n: number) => {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d;
};

/** Busca una fecha en lenguaje natural ("el viernes", "mañana", "el 15", "fin de mes"…). */
export function detectarFecha(texto: string, hoy = new Date()): Date | null {
  const q = normalizar(texto);
  const base = new Date(hoy);
  base.setHours(12, 0, 0, 0);

  if (/\bpasado manana\b/.test(q)) return sumarDias(base, 2);
  // "mañana" como día, no "en la mañana".
  if (/(?:^|[^a])(?<!la )manana\b/.test(q)) return sumarDias(base, 1);
  if (/\b(hoy|ahorita|al rato|en un rato)\b/.test(q)) return base;

  const enDias = q.match(/\ben (\d{1,2}) dias?\b/);
  if (enDias) return sumarDias(base, Number(enDias[1]));
  if (/\b(proxima semana|semana que viene|siguiente semana)\b/.test(q)) return sumarDias(base, ((8 - base.getDay()) % 7) || 7);
  if (/\bfin de mes\b|\bfinal de mes\b/.test(q)) return new Date(base.getFullYear(), base.getMonth() + 1, 0, 12);
  if (/\bquincena\b/.test(q)) {
    const q15 = new Date(base.getFullYear(), base.getMonth(), 15, 12);
    return q15 > base ? q15 : new Date(base.getFullYear(), base.getMonth() + 1, 0, 12);
  }

  for (let i = 0; i < 7; i++) {
    if (new RegExp(`\\b${DIAS[i]}\\b`).test(q)) {
      const delta = (i - base.getDay() + 7) % 7 || 7;
      return sumarDias(base, delta);
    }
  }

  const conMes = q.match(new RegExp(`\\b(\\d{1,2}) de (${MESES.join('|')})\\b`));
  if (conMes) {
    const d = new Date(base.getFullYear(), MESES.indexOf(conMes[2]), Number(conMes[1]), 12);
    if (d < base) d.setFullYear(d.getFullYear() + 1);
    return d;
  }
  const barra = q.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (barra) {
    const d = new Date(base.getFullYear(), Number(barra[2]) - 1, Number(barra[1]), 12);
    if (!Number.isNaN(d.getTime())) {
      if (d < base) d.setFullYear(d.getFullYear() + 1);
      return d;
    }
  }
  const diaSuelto = q.match(/\b(?:el|el dia|dia)\s+(\d{1,2})\b/);
  if (diaSuelto) {
    const n = Number(diaSuelto[1]);
    if (n >= 1 && n <= 31) {
      const d = new Date(base.getFullYear(), base.getMonth(), n, 12);
      if (d < base) d.setMonth(d.getMonth() + 1);
      return d;
    }
  }
  return null;
}

/** Busca un monto ("$5,000", "5 mil", "la mitad", "todo"). */
export function detectarMonto(texto: string, deuda: number): number | null {
  const q = normalizar(texto);
  const mil = q.match(/\b(\d+(?:[.,]\d+)?)\s*(mil|k)\b/);
  if (mil) return Number(mil[1].replace(',', '.')) * 1000;
  const pesos = q.match(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?|\b(\d{1,3}(?:,\d{3})+|\d{3,})(?:\.(\d{1,2}))?\s*(pesos|mxn)\b/);
  if (pesos) {
    const entero = (pesos[1] ?? pesos[3]).replace(/,/g, '');
    const dec = pesos[2] ?? pesos[4] ?? '0';
    return Number(`${entero}.${dec}`);
  }
  if (/\b(la mitad|mitad|dos partes|2 partes|dos pagos|2 pagos)\b/.test(q)) return Math.round((deuda / 2) * 100) / 100;
  return null;
}

const VERBO_PAGO = /\b(pag|deposit|transfier|transfer|liquid|abon|cubr|mand|envi|hago el pago|te lo paso|sin falta|seguro)/;

/** Promesa de pago escrita por el cliente, o null si no hay una clara. */
export function detectarPromesa(texto: string, deuda: number, hoy = new Date()): PromesaDetectada | null {
  if (deuda <= 0) return null;
  const q = normalizar(texto);
  if (/\b(no (te |les |le )?(puedo|podre|voy a poder)|no tengo)\b/.test(q) && !/\bpero\b/.test(q)) return null;
  const fecha = detectarFecha(texto, hoy);
  if (!fecha || !VERBO_PAGO.test(q)) return null;
  const monto = Math.min(detectarMonto(texto, deuda) ?? deuda, deuda);
  return { monto: Math.round(monto * 100) / 100, fecha: aISO(fecha), cita: texto.length > 90 ? `${texto.slice(0, 87)}…` : texto };
}

const fechaLarga = (iso: string) => {
  const d = new Date(`${iso}T12:00:00`);
  return `el ${DIAS[d.getDay()].replace('miercoles', 'miércoles').replace('sabado', 'sábado')} ${formatFecha(d.toISOString())}`;
};

/** 3 respuestas sugeridas según lo que escribió el cliente. */
export function sugerirPorReglas(textoCliente: string, ctx: ContextoRespuesta, hoy = new Date()): { sugerencias: Sugerencia[]; promesa: PromesaDetectada | null } {
  const q = normalizar(textoCliente);
  const n = ctx.nombre;
  const monto = formatMXN(ctx.deuda);
  const mitad = formatMXN(Math.round((ctx.deuda / 2) * 100) / 100);
  const promesa = detectarPromesa(textoCliente, ctx.deuda, hoy);

  let sugerencias: Sugerencia[];
  if (promesa) {
    sugerencias = [
      { etiqueta: 'Confirmar la promesa', texto: `Perfecto, ${n}. Quedamos en que ${fechaLarga(promesa.fecha)} nos cubres ${formatMXN(promesa.monto)}. ¡Muchas gracias!` },
      { etiqueta: 'Pedir comprobante', texto: `Gracias, ${n}. Cuando hagas el pago, ¿nos compartes el comprobante por aquí para registrarlo?` },
      { etiqueta: 'Recordar el total', texto: `Gracias por avisar, ${n}. Te recuerdo que el saldo total es de ${monto}${ctx.folios ? ` (${ctx.folios})` : ''}. Quedamos atentos.` }
    ];
  } else if (/\b(ya (te |les |le )?(pague|pagamos|deposite|transferi)|ya quedo|ya esta pagad)/.test(q)) {
    sugerencias = [
      { etiqueta: 'Pedir comprobante', texto: `¡Gracias, ${n}! ¿Nos compartes el comprobante? Aún no lo vemos reflejado y queremos registrarlo cuanto antes.` },
      { etiqueta: 'Confirmar revisión', texto: `Gracias por avisar, ${n}. Lo revisamos con administración hoy mismo y te confirmamos por aquí.` },
      { etiqueta: 'Agradecer', texto: `¡Muchas gracias, ${n}! En cuanto se refleje te mando la confirmación.` }
    ];
  } else if (/\b(partes|abonos?|plazos|parcialidades|mitad|dividir)\b/.test(q)) {
    sugerencias = [
      { etiqueta: 'Aceptar dos pagos', texto: `Claro, ${n}. Podemos dividir ${monto} en dos pagos de ${mitad}. ¿Qué fechas te funcionan para cada uno?` },
      { etiqueta: 'Pedir propuesta', texto: `Sí lo podemos ver, ${n}. ¿Cuánto podrías abonar esta semana y en qué fecha cubrirías el resto?` },
      { etiqueta: 'Proponer fechas', texto: `Va, ${n}. Te propongo ${mitad} este viernes y el resto en 15 días. ¿Te funciona?` }
    ];
  } else if (/\b(no tengo|sin dinero|no me alcanza|dificil|complicad|no puedo|crisis|mala racha)\b/.test(q)) {
    sugerencias = [
      { etiqueta: 'Empatizar y pedir fecha', texto: `Entiendo, ${n}, gracias por decírmelo. ¿Para qué fecha crees que podrías cubrir aunque sea una parte?` },
      { etiqueta: 'Ofrecer abonos', texto: `Te entiendo, ${n}. Para facilitarlo podemos dividirlo en pagos más pequeños. ¿Cuánto podrías abonar esta semana?` },
      { etiqueta: 'Agendar llamada', texto: `Gracias por la confianza, ${n}. ¿Te parece si te llamo mañana y buscamos juntos una forma de pago?` }
    ];
  } else if (/\b(no reconozco|no es mio|no es nuestro|error|equivoc|no corresponde|no sabia|cual factura|que factura)\b/.test(q)) {
    sugerencias = [
      { etiqueta: 'Enviar detalle', texto: `Claro, ${n}. Es la factura ${ctx.folios || 'pendiente'} por ${monto}. Te la comparto para que la revisemos juntos.` },
      { etiqueta: 'Revisar el caso', texto: `Gracias por avisar, ${n}. Lo reviso con administración y te confirmo hoy mismo.` },
      { etiqueta: 'Pedir datos', texto: `Para revisarlo bien, ${n}, ¿me confirmas con quién lo podemos validar en tu empresa?` }
    ];
  } else if (/\b(factura|cuenta|clabe|banco|datos|transferencia|referencia)\b/.test(q)) {
    sugerencias = [
      { etiqueta: 'Enviar factura', texto: `Claro, ${n}. Te comparto la factura ${ctx.folios || ''} por ${monto} y los datos para el pago.` },
      { etiqueta: 'Pedir fecha', texto: `Con gusto, ${n}. Ya con los datos, ¿para qué fecha agendamos el pago?` },
      { etiqueta: 'Ofrecer ayuda', texto: `Cualquier duda con el pago me dices, ${n}. Aquí estoy.` }
    ];
  } else {
    sugerencias = [
      { etiqueta: 'Pedir fecha', texto: `Gracias por responder, ${n}. ¿Qué fecha te funciona para cubrir ${monto}?` },
      { etiqueta: 'Ofrecer opciones', texto: `Gracias, ${n}. Si te ayuda, podemos dividirlo en dos pagos de ${mitad}. ¿Qué prefieres?` },
      { etiqueta: 'Agradecer', texto: `Muchas gracias por tu respuesta, ${n}. Quedo atento.` }
    ];
  }
  return { sugerencias, promesa };
}

/** Resumen del día en 2–3 frases, sin IA. */
export function resumenPorReglas(d: DatosResumen): string {
  const partes: string[] = [];
  if (d.esperan.length) {
    const nombres = d.esperan.slice(0, 2).map((e) => e.empresa).join(' y ');
    partes.push(`Primero contesta a ${nombres}${d.esperan.length > 2 ? ` y ${d.esperan.length - 2} más` : ''}: ${d.esperan.length === 1 ? 'te escribió y espera' : 'te escribieron y esperan'} tu respuesta.`);
  }
  if (d.promesasVencidas.n) partes.push(`${d.promesasVencidas.n === 1 ? 'Hay 1 promesa vencida' : `Hay ${d.promesasVencidas.n} promesas vencidas`} por ${formatMXN(d.promesasVencidas.monto)}: conviene preguntar qué pasó.`);
  if (d.promesasHoy.n) partes.push(`Hoy ${d.promesasHoy.n === 1 ? 'vence 1 promesa' : `vencen ${d.promesasHoy.n} promesas`} por ${formatMXN(d.promesasHoy.monto)}.`);
  const top = d.top[0];
  if (top) partes.push(`Después, el cobro más urgente es ${top.empresa}: ${formatMXN(top.deuda)} con ${top.diasAtraso} días de atraso.`);
  if (d.listosParaRecordatorio > 1) partes.push(`Tienes ${d.listosParaRecordatorio} clientes listos para recordatorio.`);
  if (!partes.length) return d.vencido > 0 ? 'Todo en orden por ahora: no hay respuestas pendientes ni promesas por vencer.' : 'Tu cartera está al día. Buen momento para cargar clientes nuevos.';
  return partes.slice(0, 3).join(' ');
}
