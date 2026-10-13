/**
 * Reglas de respaldo (sin IA). Se usan cuando no hay API key de Gemini,
 * se agota la capa gratuita o el modelo falla: la demo nunca se rompe.
 */
import type { AgenteId, Tono } from '../shared/types.js';
import type { BloqueDirector } from '../shared/director-types.js';
import { formatFecha, formatMXN, normalizar, primerNombre, tiempoRelativo } from '../shared/format.js';
import { randomUUID } from 'node:crypto';
import type { Db } from '../domain/db.js';
import { POLITICAS_DEFAULT, type MotivoEscalamiento, type Politicas } from '../shared/politicas.js';
import { porFecha, recuperacionSemanal, resumir, variacion, variacionesSemana } from '../domain/logic.js';

const crearId = (prefijo: string) => `${prefijo}_${randomUUID().slice(0, 8)}`;

export interface RespuestaNegociador {
  texto: string;
  tono: Tono;
  resultado: 'promesa' | 'escalar' | 'negociar';
  diasCompromiso?: number;
  montoCompromiso?: number;
  motivo?: string;
}

const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

function detectarDias(t: string): number | null {
  const hoy = new Date();
  if (/\bhoy\b/.test(t)) return 0;
  if (/pasado manana/.test(t)) return 2;
  if (/\bmanana\b/.test(t)) return 1;
  const n = t.match(/(\d{1,2})\s*dias/);
  if (n) return Number(n[1]);
  for (let i = 0; i < DIAS_SEMANA.length; i++) {
    if (t.includes(DIAS_SEMANA[i])) {
      const diff = (i - hoy.getDay() + 7) % 7;
      return diff === 0 ? 7 : diff;
    }
  }
  if (/quincena/.test(t)) {
    const fin = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).getDate();
    return hoy.getDate() < 15 ? 15 - hoy.getDate() : fin - hoy.getDate();
  }
  if (/fin de mes/.test(t)) {
    const fin = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).getDate();
    return Math.max(1, fin - hoy.getDate());
  }
  if (/(proxima semana|semana que entra)/.test(t)) return 7;
  return null;
}

const fechaEn = (dias: number) => formatFecha(new Date(Date.now() + dias * 86_400_000).toISOString());

export function responderNegociador(db: Db, clienteId: string, textoCliente: string, politicas: Politicas = POLITICAS_DEFAULT): RespuestaNegociador {
  const cliente = db.clientes.find((c) => c.id === clienteId);
  if (!cliente) return { resultado: 'negociar', tono: 'amable', texto: 'Gracias por tu mensaje.' };
  const r = resumir(db, cliente);
  const t = normalizar(textoCliente);
  const nombre = primerNombre(cliente.nombre);
  const p = politicas;
  const ofrecePartes = p.maxPagos > 1;
  const sugerenciaPartes = ofrecePartes ? ` Si te ayuda, podemos dividirlo en hasta ${p.maxPagos} pagos.` : '';

  // Escalamiento según la política de la empresa (las negativas rotundas siempre escalan).
  const categoria: MotivoEscalamiento | 'otro' | null =
  /(no reconozco|cobro indebido|error en la factura|no es mi)/.test(t) ? 'disputa' :
  /(defectuos)/.test(t) ? 'productoDefectuoso' :
  /(abogad|demanda|fraude|queja|profeco)/.test(t) ? 'legal' :
  /(hablar con (una persona|alguien|un humano)|quiero un humano|asesor)/.test(t) ? 'pideHumano' :
  /(no voy a pagar|no pienso pagar)/.test(t) ? 'otro' :
  null;
  if (categoria && (categoria === 'otro' || p.escalar[categoria])) {
    const motivo =
    categoria === 'disputa' ? 'El cliente no reconoce el cargo.' :
    categoria === 'productoDefectuoso' ? 'Reporta mercancía defectuosa.' :
    categoria === 'legal' ? 'El cliente menciona acciones legales.' :
    categoria === 'pideHumano' ? 'El cliente pidió hablar con una persona.' :
    'El cliente se niega a pagar.';
    return {
      resultado: 'escalar',
      tono: 'amable',
      motivo,
      texto: `Entiendo, ${nombre}. Para revisarlo con el cuidado que merece, voy a pasar tu caso a una persona de nuestro equipo. Te contactarán hoy mismo y mientras tanto pausamos los recordatorios.`
    };
  }

  if (r.deuda <= 0) {
    return { resultado: 'negociar', tono: 'amable', texto: `¡Gracias, ${nombre}! Tu cuenta está al corriente. Cualquier duda, aquí estamos.` };
  }

  const dias = detectarDias(t);
  const enPartes = /(dos partes|parcialidad|pagos|abonos|abono|mitad|plazos)/.test(t);
  const sinDinero = /(no (puedo|tengo)|sin dinero|dificil|flojo|no me alcanza|ahorita no)/.test(t);
  const compromiso = /(pago|deposito|transfiero|liquido|pagare|les pago|te pago|deposite|cubro)/.test(t);

  // Fecha fuera de política: contraoferta con el plazo máximo.
  if (dias !== null && dias > p.plazoMaxDias) {
    return {
      resultado: 'negociar',
      tono: 'amable',
      texto: `Gracias, ${nombre}. El plazo máximo que podemos darte para el pago es el ${fechaEn(p.plazoMaxDias)}. ¿Te funciona esa fecha o una anterior?${sugerenciaPartes}`
    };
  }

  if (enPartes) {
    if (!ofrecePartes) {
      return {
        resultado: 'negociar',
        tono: 'amable',
        texto: `Te entiendo, ${nombre}. Por política no podemos dividir el saldo de ${formatMXN(r.deuda)}, pero sí podemos acordar una fecha que te acomode (hasta el ${fechaEn(p.plazoMaxDias)}). ¿Cuál te funciona?`
      };
    }
    const partes = Math.min(2, p.maxPagos);
    const primero = Math.round(Math.max(r.deuda / partes, r.deuda * p.pagoInicialMinPct / 100) * 100) / 100;
    const d = Math.min(dias ?? 5, p.plazoMaxDias);
    const resto = Math.round((r.deuda - primero) * 100) / 100;
    return {
      resultado: 'promesa',
      tono: 'amable',
      diasCompromiso: d,
      montoCompromiso: primero,
      texto: `Claro, ${nombre}. Podemos dividirlo en dos pagos: ${formatMXN(primero)} el ${fechaEn(d)} y ${formatMXN(resto)} 15 días después. Ya registré el primer compromiso; te enviaré los datos bancarios por aquí.`
    };
  }

  if (sinDinero) {
    return {
      resultado: 'negociar',
      tono: 'amable',
      texto: ofrecePartes ?
      `Te entiendo, ${nombre}. Para ayudarte podemos dividir el saldo de ${formatMXN(r.deuda)} en hasta ${p.maxPagos} pagos. ¿Qué fecha te funcionaría para el primero?` :
      `Te entiendo, ${nombre}. ¿Qué fecha te funcionaría para cubrir el saldo de ${formatMXN(r.deuda)}? Podemos esperarte hasta el ${fechaEn(p.plazoMaxDias)}.`
    };
  }

  if (dias !== null && (compromiso || dias <= 14)) {
    return {
      resultado: 'promesa',
      tono: 'amable',
      diasCompromiso: dias,
      montoCompromiso: r.deuda,
      texto: `Perfecto, ${nombre}. Registré tu compromiso de pago por ${formatMXN(r.deuda)} para el ${fechaEn(dias)}. Te confirmamos en cuanto lo recibamos. ¡Gracias!`
    };
  }

  if (compromiso) {
    return {
      resultado: 'negociar',
      tono: 'amable',
      texto: `Gracias, ${nombre}. ¿Qué fecha te queda mejor para el pago de ${formatMXN(r.deuda)}?${sugerenciaPartes}`
    };
  }

  return {
    resultado: 'negociar',
    tono: r.diasAtraso > 60 ? 'firme' : 'amable',
    texto: `Gracias por responder, ${nombre}. El saldo pendiente es de ${formatMXN(r.deuda)}. ¿Podrías confirmarnos una fecha de pago?${sugerenciaPartes}`
  };
}

export type PasoDirector =
{tipo: 'delegando';agente: AgenteId;texto: string;} |
{tipo: 'texto';texto: string;} |
{tipo: 'bloque';bloque: BloqueDirector;};

export function planDirector(db: Db, pregunta: string): PasoDirector[] {
  const q = normalizar(pregunta);
  const rs = db.clientes.map((c) => resumir(db, c));
  if (!rs.length) {
    return [{ tipo: 'texto', texto: 'Todavía no hay clientes en la cartera. Carga los datos de ejemplo desde Cartera o Ajustes y te doy el panorama completo.' }];
  }

  const conSaldo = rs.filter((r) => r.deuda > 0);
  const porCobrar = conSaldo.reduce((s, r) => s + r.deuda, 0);
  const vencido = db.facturas.filter((f) => f.estado === 'vencida').reduce((s, f) => s + f.monto, 0);
  const vencidos = rs.filter((r) => r.estado === 'vencido');
  const serie = recuperacionSemanal(db);
  const grafica: BloqueDirector = { tipo: 'grafica', titulo: 'Recuperado por semana', total: serie.reduce((s, p) => s + p.valor, 0), puntos: serie };
  const promesasPend = db.promesas.filter((p) => p.estado === 'pendiente');

  if (/(reintent|reenvi|prioridad alta|vuelve a escribir|insist)/.test(q)) {
    const objetivo = rs.
    filter((r) => r.prioridad.nivel === 'alta' && r.deuda > 0 && !r.escalado && r.estado !== 'promesa').
    sort((a, b) => b.prioridad.score - a.prioridad.score);
    const omitidos = rs.filter((r) => r.prioridad.nivel === 'alta' && r.escalado).length;
    if (!objetivo.length) {
      return [{ tipo: 'delegando', agente: 'analista', texto: 'Consultando al Analista…' }, { tipo: 'texto', texto: 'No hay clientes de prioridad alta pendientes de contactar. Todos tienen promesa de pago o están en revisión humana.' }];
    }
    return [
    { tipo: 'delegando', agente: 'analista', texto: 'Consultando al Analista…' },
    { tipo: 'delegando', agente: 'redactor', texto: 'Pidiendo borradores al Redactor…' },
    { tipo: 'texto', texto: `El Analista confirma ${objetivo.length} clientes de prioridad alta sin acuerdo de pago${omitidos ? ` (omití ${omitidos} escalado a humano)` : ''}:` },
    { tipo: 'bloque', bloque: { tipo: 'clientes', titulo: 'Prioridad alta', clientes: objetivo.map((r) => ({ id: r.id, empresa: r.empresa, monto: r.deuda, detalle: `${r.diasAtraso} días de atraso · score ${r.prioridad.score}` })) } },
    { tipo: 'bloque', bloque: { tipo: 'confirmacion', id: crearId('conf'), mensaje: `Voy a reenviar mensajes con tono firme a ${objetivo.length} clientes. ¿Confirmas?`, clienteIds: objetivo.map((r) => r.id), tono: 'firme', estado: 'pendiente' } }];

  }

  if (/(respond|contest|silencio|ignor)/.test(q)) {
    const sinRespuesta = conSaldo.
    map((r) => ({ r, ms: db.mensajes.filter((m) => m.clienteId === r.id).sort(porFecha) })).
    filter(({ ms }) => ms.length > 0 && ms[ms.length - 1].rol === 'agente' && ms[ms.length - 1].agente === 'redactor').
    sort((a, b) => b.r.deuda - a.r.deuda);
    if (!sinRespuesta.length) {
      return [{ tipo: 'delegando', agente: 'negociador', texto: 'Revisando conversaciones con el Negociador…' }, { tipo: 'texto', texto: 'Buenas noticias: todos los clientes contactados han respondido.' }];
    }
    return [
    { tipo: 'delegando', agente: 'negociador', texto: 'Revisando conversaciones con el Negociador…' },
    { tipo: 'texto', texto: `${sinRespuesta.length} clientes no han contestado su último mensaje:` },
    { tipo: 'bloque', bloque: { tipo: 'clientes', titulo: 'Sin respuesta', clientes: sinRespuesta.map(({ r, ms }) => ({ id: r.id, empresa: r.empresa, monto: r.deuda, detalle: `Último mensaje ${tiempoRelativo(ms[ms.length - 1].fecha)}` })) } },
    { tipo: 'texto', texto: 'Si quieres, el Redactor les escribe con un tono más firme. Solo dime "reintentar prioridad alta".' }];

  }

  if (/(resumen|semana|como vamos|como va)/.test(q)) {
    const escalados = rs.filter((r) => r.escalado).length;
    const montoPromesas = promesasPend.reduce((s, p) => s + p.monto, 0);
    return [
    { tipo: 'delegando', agente: 'analista', texto: 'Consultando al Analista…' },
    { tipo: 'delegando', agente: 'negociador', texto: 'Revisando acuerdos con el Negociador…' },
    { tipo: 'texto', texto: 'Así va la semana:' },
    { tipo: 'bloque', bloque: { tipo: 'kpi', etiqueta: 'Recuperado esta semana', valor: serie[serie.length - 1].valor, variacion: variacion(serie[serie.length - 1].valor, serie[serie.length - 2]?.valor ?? 0), detalle: 'vs. semana anterior', mejorSi: 'sube' } },
    { tipo: 'bloque', bloque: grafica },
    { tipo: 'texto', texto: `El Negociador tiene ${promesasPend.length} promesas de pago activas por ${formatMXN(montoPromesas)}.${escalados ? ` Hay ${escalados} caso escalado que necesita tu revisión.` : ''}` }];

  }

  if (/(promesa|compromiso)/.test(q)) {
    const lista = promesasPend.
    map((p) => ({ p, c: db.clientes.find((c) => c.id === p.clienteId) })).
    filter((x) => x.c).
    sort((a, b) => a.p.fechaCompromiso.localeCompare(b.p.fechaCompromiso));
    return [
    { tipo: 'delegando', agente: 'negociador', texto: 'Revisando acuerdos con el Negociador…' },
    { tipo: 'texto', texto: `Hay ${lista.length} promesas de pago activas:` },
    { tipo: 'bloque', bloque: { tipo: 'clientes', titulo: 'Promesas activas', clientes: lista.map(({ p, c }) => ({ id: c!.id, empresa: c!.empresa, monto: p.monto, detalle: `Compromiso ${formatFecha(p.fechaCompromiso)}` })) } }];

  }

  if (/(falta|cobrar|cuanto|debe|adeudo|cartera|vencid)/.test(q)) {
    const top = [...vencidos].sort((a, b) => b.prioridad.score - a.prioridad.score).slice(0, 2);
    return [
    { tipo: 'delegando', agente: 'analista', texto: 'Consultando al Analista…' },
    { tipo: 'texto', texto: `Tienes ${formatMXN(porCobrar)} por cobrar en ${conSaldo.length} clientes. De eso, ${formatMXN(vencido)} ya está vencido.` },
    { tipo: 'bloque', bloque: { tipo: 'kpi', etiqueta: 'Por cobrar', valor: porCobrar, variacion: variacionesSemana(db).porCobrar, detalle: 'vs. semana pasada', mejorSi: 'baja' } },
    { tipo: 'bloque', bloque: grafica },
    ...(top.length ?
    [{ tipo: 'texto' as const, texto: `Lo más urgente: ${top.map((t) => t.empresa).join(' y ')} suman ${formatMXN(top.reduce((s, t) => s + t.deuda, 0))}. ¿Quieres que el Redactor les envíe un mensaje firme?` }] :
    [])];

  }

  return [
  { tipo: 'texto', texto: `Puedo darte el estado de la cartera, decirte quién no ha respondido o coordinar un reintento con el equipo. Ahora mismo hay ${formatMXN(vencido)} vencido en ${vencidos.length} clientes.` },
  { tipo: 'bloque', bloque: { tipo: 'kpi', etiqueta: 'Vencido', valor: vencido, variacion: variacionesSemana(db).vencido, detalle: 'vs. semana pasada', mejorSi: 'baja' } }];

}