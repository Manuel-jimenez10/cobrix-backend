/**
 * Orquestación de los flujos de cobranza (los usan las rutas HTTP y el webhook).
 *
 *   prepararCobranza:  Analista prioriza (reglas) → el asistente redacta cada recordatorio (IA o plantilla).
 *                      No envía nada: devuelve borradores para que una persona los revise y los mande
 *                      desde su WhatsApp (enlace wa.me con el mensaje ya escrito).
 *   registrarEnvio:    la persona envió un mensaje desde su WhatsApp → queda en la conversación.
 *   recibirRespuesta:  el cliente contestó (la persona pega su respuesta, o llega por el webhook de Meta)
 *                      → se guarda y se marca "requiere atención".
 *   registrarPromesa:  una persona registra el compromiso de pago que acordó con el cliente.
 *
 * La negociación la hace una persona: en cobranza de PyMEs la relación es personal.
 * Cada paso emite un evento en eventos_agente → Supabase Realtime → dashboard en vivo.
 *
 * Próximamente (cuando Meta apruebe la app): envío automático por la API oficial
 * de WhatsApp Cloud con canalPara(). El código del canal ya está en channels/whatsapp.ts.
 */
import { priorizar } from '../agents/analista.js';
import { redactarLote } from '../agents/asistente.js';
import { canalSimulador, type CanalMensajeria } from '../channels/canal.js';
import { crearCanalWhatsApp } from '../channels/whatsapp.js';
import { env, whatsappConfigurado } from '../env.js';
import {
  actualizarFacturas,
  bitacora,
  cargarDb,
  emitirEvento,
  guardarPrioridades,
  insertarMensaje,
  insertarPromesa,
  type Db
} from '../domain/db.js';
import { facturasAbiertas, resumir } from '../domain/logic.js';
import { formatFecha, formatMXN } from '../shared/format.js';
import { describirHorario, dentroDeHorario, limitarTono } from '../shared/politicas.js';
import { siguienteTono } from '../shared/reglas.js';
import type { Borrador, Cliente, ClienteResumen, Mensaje, ProgresoCobranza, PromesaPago, ResultadoPreparacion, Tono } from '../shared/types.js';

/** Errores de negocio: la ruta responde 409 y la UI muestra el mensaje tal cual. */
export class ErrorDeNegocio extends Error {}

/** Número desde el que envía esta cuenta: el suyo si lo conectó; si no, el compartido de demo. */
export function numeroDeEnvio(db: Db): string | null {
  if (db.perfil.wa.estado === 'conectado' && db.perfil.wa.phoneNumberId) return db.perfil.wa.phoneNumberId;
  return whatsappConfigurado ? env.whatsapp.phoneNumberId : null;
}

export function canalPara(db: Db, cliente: Cliente): CanalMensajeria {
  const numero = numeroDeEnvio(db);
  if (db.perfil.canal === 'simulador' || cliente.canal === 'simulador' || !numero) return canalSimulador;
  return crearCanalWhatsApp(numero);
}

/** En modo demo todos los WhatsApp se redirigen al número de prueba del administrador. */
export const destinoDe = (db: Db, cliente: Cliente) => db.perfil.telefonoPrueba || cliente.telefono;

const inicioDeHoy = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

/** Por qué NO conviene mandarle un recordatorio automático a este cliente (o null si sí). */
export function motivoParaOmitir(db: Db, c: ClienteResumen): string | null {
  if (c.deuda <= 0) return 'Sin saldo pendiente';
  if (c.requiereAtencion) return 'Te escribió y espera tu respuesta';
  if (c.escalado) return 'Caso en revisión del equipo';
  const promesaVigente = db.promesas.some((p) => p.clienteId === c.id && p.estado === 'pendiente' && new Date(p.fechaCompromiso) >= inicioDeHoy());
  if (promesaVigente) return 'Tiene una promesa de pago vigente';
  return null;
}

export async function prepararCobranza(
  userId: string,
  clienteIds: string[],
  opciones: { tono?: Tono; usarIA: boolean; onProgreso?: (p: ProgresoCobranza) => void }
): Promise<ResultadoPreparacion> {
  const db = await cargarDb(userId);
  const politicas = db.perfil.politicas;
  if (!dentroDeHorario(politicas)) {
    throw new ErrorDeNegocio(`Fuera del horario de cobranza configurado (${describirHorario(politicas)}). Cámbialo en Ajustes → Reglas de cobranza.`);
  }
  const log = bitacora(userId);
  const seleccion = clienteIds
    .map((id) => db.clientes.find((c) => c.id === id))
    .filter((c): c is Cliente => Boolean(c))
    .map((c) => resumir(db, c));

  const omitidos: ResultadoPreparacion['omitidos'] = [];
  const candidatos = seleccion.filter((c) => {
    const motivo = motivoParaOmitir(db, c);
    if (motivo) omitidos.push({ clienteId: c.id, empresa: c.empresa, motivo });
    return !motivo;
  });

  // 1. Analista: recalcula la prioridad por reglas (instantáneo) y ordena la cola.
  opciones.onProgreso?.({ fase: 'analizando', orden: [], actualId: null, listos: [] });
  const evA = log.emitir({
    agente: 'analista',
    clienteId: null,
    accion: 'Ordenando clientes por prioridad',
    detalle: `${candidatos.length} clientes en evaluación`,
    estado: 'en_progreso'
  });
  const nuevas = priorizar(db, candidatos);
  if (nuevas.length) {
    await guardarPrioridades(userId, nuevas);
    db.prioridades = [...db.prioridades.filter((p) => !nuevas.some((n) => n.clienteId === p.clienteId)), ...nuevas];
  }

  const priorizados = candidatos.map((c) => resumir(db, c)).sort((a, b) => b.prioridad.score - a.prioridad.score);
  const orden = priorizados.map((c) => ({
    clienteId: c.id,
    empresa: c.empresa,
    score: c.prioridad.score,
    nivel: c.prioridad.nivel,
    tono: limitarTono(opciones.tono ?? siguienteTono(db.mensajes.filter((m) => m.clienteId === c.id)), politicas)
  }));
  log.actualizar(evA, {
    estado: 'completado',
    accion: 'Clientes ordenados por prioridad',
    detalle: priorizados[0]
      ? `${priorizados[0].empresa} va primero · score ${priorizados[0].prioridad.score}${omitidos.length ? ` · ${omitidos.length} omitido(s)` : ''}`
      : 'Nadie necesita recordatorio ahora'
  });

  // 2. Asistente: redacta toda la tanda en una sola llamada a la IA (respeta el orden de prioridad).
  const listos: string[] = [];
  const reportar = (fase: ProgresoCobranza['fase'], actualId: string | null) => opciones.onProgreso?.({ fase, orden, actualId, listos: [...listos] });
  reportar('redactando', orden[0]?.clienteId ?? null);
  const redactados = await redactarLote(
    db,
    orden.map((item) => ({ c: priorizados.find((x) => x.id === item.clienteId)!, tono: item.tono })),
    opciones.usarIA,
    (id) => {
      listos.push(id);
      reportar('redactando', orden.find((o) => !listos.includes(o.clienteId))?.clienteId ?? null);
    }
  );
  const borradores: (Borrador | undefined)[] = orden.map((item) => {
    const c = priorizados.find((x) => x.id === item.clienteId)!;
    const r = redactados.get(c.id);
    return r && { clienteId: c.id, empresa: c.empresa, nombre: c.nombre, telefono: destinoDe(db, c), deuda: c.deuda, tono: r.tono, texto: r.texto, origen: r.origen };
  });

  const lista = borradores.filter((b): b is Borrador => Boolean(b));
  if (lista.length) {
    const conIA = lista.filter((b) => b.origen === 'ia').length;
    await emitirEvento(userId, {
      agente: 'redactor',
      clienteId: null,
      accion: `${lista.length} ${lista.length === 1 ? 'recordatorio listo' : 'recordatorios listos'} para enviar`,
      detalle: conIA ? `${conIA} redactado${conIA === 1 ? '' : 's'} con IA · se envían desde tu WhatsApp` : 'Con plantilla · se envían desde tu WhatsApp',
      estado: 'completado'
    });
  }
  reportar('listo', null);
  await log.listo();
  return { borradores: lista, omitidos };
}

/**
 * La persona envió un mensaje desde su WhatsApp (enlace wa.me). Se guarda en la conversación:
 * con tono = recordatorio de cobranza; sin tono = respuesta del equipo.
 */
export async function registrarEnvio(
  userId: string,
  clienteId: string,
  datos: { texto: string; tono: Tono | null; origen: 'ia' | 'plantilla' | 'manual' }
): Promise<Mensaje> {
  const db = await cargarDb(userId);
  const cliente = db.clientes.find((c) => c.id === clienteId);
  if (!cliente) throw new ErrorDeNegocio('Cliente no encontrado');
  const esRecordatorio = Boolean(datos.tono);
  const mensaje = await insertarMensaje(userId, {
    clienteId,
    rol: 'agente',
    agente: esRecordatorio ? 'redactor' : null, // null = lo escribió una persona del equipo
    contenido: datos.texto,
    tono: datos.tono,
    esPlantilla: datos.origen === 'plantilla',
    canal: db.perfil.canal === 'simulador' ? 'simulador' : 'whatsapp',
    waMessageId: null
  });
  const vista = datos.texto.length > 60 ? `${datos.texto.slice(0, 57)}…` : datos.texto;
  await emitirEvento(userId, esRecordatorio
    ? {
        agente: 'redactor',
        clienteId,
        accion: `Recordatorio enviado a ${cliente.empresa}`,
        detalle: `Tono ${datos.tono}${datos.origen === 'ia' ? ' · redactado con IA' : ''} · desde tu WhatsApp`,
        estado: 'completado'
      }
    : {
        agente: 'negociador', // 'negociador' = acciones del equipo humano
        clienteId,
        accion: `Respondiste a ${cliente.empresa}`,
        detalle: vista,
        estado: 'completado'
      });
  return mensaje;
}

/**
 * El cliente contestó: la persona pega lo que le escribió por WhatsApp (o, con la API
 * oficial, llega por el webhook). No responde ninguna IA: se guarda, se pausan sus
 * recordatorios y el equipo recibe el aviso en tiempo real.
 */
export async function recibirRespuesta(
  userId: string,
  clienteId: string,
  texto: string,
  origen: 'manual' | 'simulador' | 'whatsapp',
  waMessageId?: string
): Promise<Mensaje> {
  const db = await cargarDb(userId);
  const cliente = db.clientes.find((c) => c.id === clienteId);
  if (!cliente) throw new ErrorDeNegocio('Cliente no encontrado');

  const mensaje = await insertarMensaje(userId, {
    clienteId,
    rol: 'cliente',
    agente: null,
    contenido: texto,
    tono: null,
    esPlantilla: false,
    canal: origen === 'simulador' ? 'simulador' : 'whatsapp',
    waMessageId: waMessageId ?? null
  });
  const vista = texto.length > 60 ? `${texto.slice(0, 57)}…` : texto;
  await emitirEvento(userId, {
    agente: 'analista',
    clienteId,
    accion: `${cliente.empresa} te escribió`,
    detalle: `“${vista}” · espera tu respuesta`,
    estado: 'completado'
  });
  return mensaje;
}

/** Registra la promesa de pago que el equipo acordó con el cliente. */
export async function registrarPromesa(
  userId: string,
  clienteId: string,
  datos: { monto: number; fecha: string }
): Promise<PromesaPago> {
  const db = await cargarDb(userId);
  const cliente = db.clientes.find((c) => c.id === clienteId);
  if (!cliente) throw new ErrorDeNegocio('Cliente no encontrado');
  const resumen = resumir(db, cliente);
  if (resumen.deuda <= 0) throw new ErrorDeNegocio('Este cliente no tiene saldo pendiente.');
  if (datos.monto > resumen.deuda + 0.01) throw new ErrorDeNegocio(`El monto supera el saldo pendiente (${formatMXN(resumen.deuda)}).`);
  const fecha = new Date(`${datos.fecha}T12:00:00`);
  if (Number.isNaN(fecha.getTime()) || fecha < inicioDeHoy()) throw new ErrorDeNegocio('La fecha de pago debe ser hoy o posterior.');

  const abiertas = facturasAbiertas(db, clienteId).sort((a, b) => b.diasAtraso - a.diasAtraso);
  const promesa = await insertarPromesa(userId, {
    clienteId,
    facturaId: abiertas[0]?.id ?? '',
    monto: Math.round(datos.monto * 100) / 100,
    fechaCompromiso: fecha.toISOString(),
    estado: 'pendiente'
  });
  await actualizarFacturas(userId, abiertas.map((f) => f.id), { estado: 'promesa' });
  await emitirEvento(userId, {
    agente: 'negociador',
    clienteId,
    accion: `Promesa de pago de ${cliente.empresa}`,
    detalle: `${formatMXN(promesa.monto)} para el ${formatFecha(promesa.fechaCompromiso)}`,
    estado: 'completado'
  });
  return promesa;
}
