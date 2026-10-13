/** Reglas de negocio puras (sin I/O), compartidas por rutas y agentes. */
import { diasHasta } from '../shared/format.js';
import type {
  AgenteId,
  Cliente,
  ClienteResumen,
  Dashboard,
  EstadoCliente,
  Factura,
  NivelPrioridad,
  PuntoSerie
} from '../shared/types.js';
import type { Db } from './db.js';

export const porFecha = (a: { fecha: string }, b: { fecha: string }) => a.fecha.localeCompare(b.fecha);
export const suma = (xs: { monto: number }[]) => Math.round(xs.reduce((s, x) => s + x.monto, 0) * 100) / 100;

export function facturasAbiertas(db: Db, clienteId: string): Factura[] {
  return db.facturas.filter((f) => f.clienteId === clienteId && f.estado !== 'pagada');
}

export function estadoDeFacturas(abiertas: Factura[]): EstadoCliente {
  if (!abiertas.length) return 'al_dia';
  if (abiertas.some((f) => f.estado === 'vencida')) return 'vencido';
  if (abiertas.some((f) => f.estado === 'promesa')) return 'promesa';
  if (abiertas.some((f) => f.estado === 'pendiente' && diasHasta(f.fechaVencimiento) <= 7)) return 'por_vencer';
  return 'al_dia';
}

export function resumir(db: Db, c: Cliente): ClienteResumen {
  const abiertas = facturasAbiertas(db, c.id);
  const msgs = db.mensajes.filter((m) => m.clienteId === c.id).sort(porFecha);
  const prioridad = db.prioridades.find((p) => p.clienteId === c.id) ?? {
    clienteId: c.id,
    score: 0,
    nivel: 'baja' as const,
    razon: 'El Analista aún no evalúa a este cliente.'
  };
  return {
    ...c,
    deuda: suma(abiertas),
    diasAtraso: abiertas.reduce((m, f) => Math.max(m, f.diasAtraso), 0),
    estado: estadoDeFacturas(abiertas),
    prioridad: abiertas.length ? prioridad : { ...prioridad, score: 0, nivel: 'baja', razon: 'Sin saldo pendiente.' },
    facturasAbiertas: abiertas.length,
    ultimoMensaje: msgs[msgs.length - 1] ?? null,
    escalado: db.escalamientos.some((e) => e.clienteId === c.id && !e.resuelto),
    requiereAtencion: msgs[msgs.length - 1]?.rol === 'cliente'
  };
}

export const resumenes = (db: Db) => db.clientes.map((c) => resumir(db, c));

export const nivelDeScore = (score: number): NivelPrioridad => (score >= 70 ? 'alta' : score >= 40 ? 'media' : 'baja');

/* ───────────── Dashboard ───────────── */

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function inicioDeSemana(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // lunes
  return x;
}

/** Pagos recibidos agrupados por semana (últimas 8). */
export function recuperacionSemanal(db: Db, semanas = 8): PuntoSerie[] {
  const actual = inicioDeSemana(new Date());
  return Array.from({ length: semanas }, (_, i) => {
    const inicio = new Date(actual);
    inicio.setDate(actual.getDate() - (semanas - 1 - i) * 7);
    const fin = new Date(inicio);
    fin.setDate(inicio.getDate() + 7);
    const valor = suma(db.pagos.filter((p) => {
      const t = new Date(p.fecha).getTime();
      return t >= inicio.getTime() && t < fin.getTime();
    }));
    return { etiqueta: `${inicio.getDate()} ${MESES[inicio.getMonth()]}`, valor };
  });
}

function pagosDelMes(db: Db, desplazamiento: number) {
  const hoy = new Date();
  const inicio = new Date(hoy.getFullYear(), hoy.getMonth() + desplazamiento, 1);
  const fin = desplazamiento === 0 ? hoy : new Date(hoy.getFullYear(), hoy.getMonth() + desplazamiento, hoy.getDate(), 23, 59, 59);
  return suma(db.pagos.filter((p) => {
    const t = new Date(p.fecha).getTime();
    return t >= inicio.getTime() && t <= fin.getTime();
  }));
}

export const variacion = (actual: number, anterior: number) =>
  anterior > 0 ? Math.round(((actual - anterior) / anterior) * 1000) / 10 : actual > 0 ? 100 : 0;

export function construirDashboard(db: Db): Dashboard {
  const abiertas = db.facturas.filter((f) => f.estado !== 'pagada');
  const rs = resumenes(db);
  const tramos = [
    { rango: '0–30', min: 0, max: 30 },
    { rango: '31–60', min: 31, max: 60 },
    { rango: '61–90', min: 61, max: 90 },
    { rango: '+90', min: 91, max: Infinity }
  ];
  const pendientes = db.promesas.filter((p) => p.estado === 'pendiente');

  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const tareasHoy: Record<AgenteId, number> = { director: 0, analista: 0, redactor: 0, negociador: 0 };
  db.eventos
    .filter((e) => e.estado !== 'en_progreso' && new Date(e.fecha) >= hoy)
    .forEach((e) => {
      tareasHoy[e.agente] += 1;
    });

  // "Recuperado este mes" vs. el mismo tramo del mes anterior.
  const recuperadoMes = pagosDelMes(db, 0);
  const anterior = pagosDelMes(db, -1);

  return {
    porCobrar: suma(abiertas),
    facturasAbiertas: abiertas.length,
    vencido: suma(abiertas.filter((f) => f.estado === 'vencida')),
    clientesVencidos: rs.filter((r) => r.estado === 'vencido').length,
    recuperadoMes,
    recuperadoVariacion: variacion(recuperadoMes, anterior),
    promesasActivas: pendientes.length,
    montoPromesas: suma(pendientes),
    antiguedad: tramos.map((t) => {
      const fs = abiertas.filter((f) => f.diasAtraso >= t.min && f.diasAtraso <= t.max);
      return { rango: t.rango, monto: suma(fs), clientes: new Set(fs.map((f) => f.clienteId)).size };
    }),
    tareasHoy,
    recuperacionSemanal: db.clientes.length ? recuperacionSemanal(db) : []
  };
}

/**
 * Variación semanal estimada a partir de pagos y facturas de los últimos 7 días
 * (no guardamos fotos históricas de la cartera).
 */
export function variacionesSemana(db: Db): { porCobrar: number; vencido: number } {
  const hace7 = Date.now() - 7 * 86_400_000;
  const pagos7 = suma(db.pagos.filter((p) => new Date(p.fecha).getTime() >= hace7));
  const abiertas = db.facturas.filter((f) => f.estado !== 'pagada');
  const nuevas = suma(abiertas.filter((f) => new Date(f.fechaEmision).getTime() >= hace7));
  const porCobrar = suma(abiertas);
  const vencido = suma(abiertas.filter((f) => f.estado === 'vencida'));
  const vencidoAntes = suma(abiertas.filter((f) => f.estado === 'vencida' && new Date(f.fechaVencimiento).getTime() < hace7)) + pagos7;
  return {
    porCobrar: variacion(porCobrar, porCobrar + pagos7 - nuevas),
    vencido: variacion(vencido, vencidoAntes)
  };
}
