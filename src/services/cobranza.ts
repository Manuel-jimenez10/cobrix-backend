/**
 * Orquestación de los flujos de cobranza (los usan las rutas HTTP y el webhook).
 *
 *   iniciarCobranza:     Analista prioriza (reglas) → Redactor arma la plantilla → se envía por el canal.
 *   recibirRespuesta:    el cliente contesta → se guarda y se marca "requiere atención" para el equipo.
 *   responderComoEquipo: una persona del equipo contesta desde la app (texto libre dentro de la ventana de 24 h).
 *   registrarPromesa:    una persona registra el compromiso de pago que acordó con el cliente.
 *
 * La negociación la hace una persona: en cobranza de PyMEs la relación es personal.
 * Cada paso emite un evento en eventos_agente → Supabase Realtime → dashboard en vivo.
 */
import { priorizar } from '../agents/analista.js';
import { redactar } from '../agents/redactor.js';
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
import { estadoVentana, siguienteTono } from '../shared/reglas.js';
import type { Cliente, ClienteResumen, Mensaje, ProgresoCobranza, PromesaPago, ResultadoCobranza, Tono } from '../shared/types.js';

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

export async function iniciarCobranza(
  userId: string,
  clienteIds: string[],
  opciones: { tono?: Tono; onProgreso?: (p: ProgresoCobranza) => void }
): Promise<ResultadoCobranza> {
  const db = await cargarDb(userId);
  const politicas = db.perfil.politicas;
  if (!dentroDeHorario(politicas)) {
    throw new ErrorDeNegocio(`Fuera del horario de envíos configurado (${describirHorario(politicas)}). Cámbialo en Ajustes → Reglas de cobranza.`);
  }
  const log = bitacora(userId);
  const seleccion = clienteIds
    .map((id) => db.clientes.find((c) => c.id === id))
    .filter((c): c is Cliente => Boolean(c))
    .map((c) => resumir(db, c));

  const omitidos: ResultadoCobranza['omitidos'] = [];
  const candidatos = seleccion.filter((c) => {
    const motivo = motivoParaOmitir(db, c);
    if (motivo) omitidos.push({ clienteId: c.id, empresa: c.empresa, motivo });
    return !motivo;
  });

  // 1. Analista: recalcula la prioridad por reglas (instantáneo) y ordena la cola.
  opciones.onProgreso?.({ fase: 'analizando', orden: [], actualId: null, enviados: [] });
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

  const enviados: string[] = [];
  const mensajes: Mensaje[] = [];
  const reportar = (fase: ProgresoCobranza['fase'], actualId: string | null) =>
    opciones.onProgreso?.({ fase, orden, actualId, enviados: [...enviados] });

  // 2. Redactor + envío, en orden de prioridad. Siempre plantilla aprobada: vale dentro y fuera de la ventana de 24 h.
  for (const item of orden) {
    const c = priorizados.find((x) => x.id === item.clienteId)!;
    const borrador = redactar(db, c, item.tono);
    reportar('enviando', c.id);
    const evR = log.emitir({ agente: 'redactor', clienteId: c.id, accion: `Enviando recordatorio a ${c.empresa}`, detalle: `Plantilla ${item.tono}`, estado: 'en_progreso' });

    const canal = canalPara(db, c);
    const envio = await canal.enviarPlantilla({ telefono: destinoDe(db, c), tono: item.tono, variables: borrador.variables });
    if (!envio.ok) {
      log.actualizar(evR, { estado: 'error', accion: `No se pudo enviar el recordatorio a ${c.empresa}`, detalle: envio.error ?? 'error desconocido' });
      continue;
    }

    const mensaje = await insertarMensaje(userId, {
      clienteId: c.id,
      rol: 'agente',
      agente: 'redactor',
      contenido: borrador.contenido,
      tono: item.tono,
      esPlantilla: true,
      canal: canal.nombre,
      waMessageId: envio.messageId ?? null
    });
    db.mensajes.push(mensaje);
    mensajes.push(mensaje);
    enviados.push(c.id);
    log.actualizar(evR, {
      estado: 'completado',
      accion: `Recordatorio enviado a ${c.empresa}`,
      detalle: `Plantilla ${item.tono} · ${canal.nombre === 'whatsapp' ? 'WhatsApp' : 'simulador'}`
    });
  }

  reportar('listo', null);
  await log.listo();
  return { enviados: enviados.length, mensajes, omitidos };
}

/**
 * El cliente contestó (por WhatsApp o desde el simulador). No responde ninguna IA:
 * se guarda, se pausan sus recordatorios y el equipo recibe el aviso en tiempo real.
 */
export async function recibirRespuesta(
  userId: string,
  clienteId: string,
  texto: string,
  origen: 'simulador' | 'whatsapp',
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
    canal: origen,
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

/** Una persona del equipo le contesta al cliente desde la app. */
export async function responderComoEquipo(userId: string, clienteId: string, texto: string): Promise<Mensaje> {
  const db = await cargarDb(userId);
  const cliente = db.clientes.find((c) => c.id === clienteId);
  if (!cliente) throw new ErrorDeNegocio('Cliente no encontrado');

  const canal = canalPara(db, cliente);
  const ventana = estadoVentana(db.mensajes.filter((m) => m.clienteId === clienteId));
  if (canal.nombre === 'whatsapp' && !ventana.abierta) {
    throw new ErrorDeNegocio(
      'La ventana de 24 h de WhatsApp está cerrada: Meta solo permite plantillas. Envía un recordatorio o escríbele desde tu WhatsApp Business.'
    );
  }
  const envio = await canal.enviarTexto(destinoDe(db, cliente), texto);
  if (!envio.ok) throw new ErrorDeNegocio(`WhatsApp rechazó el mensaje: ${envio.error ?? 'error desconocido'}`);

  const mensaje = await insertarMensaje(userId, {
    clienteId,
    rol: 'agente',
    agente: null, // null = lo escribió una persona del equipo
    contenido: texto,
    tono: null,
    esPlantilla: false,
    canal: canal.nombre,
    waMessageId: envio.messageId ?? null
  });
  await emitirEvento(userId, {
    agente: 'negociador', // 'negociador' = acciones del equipo humano
    clienteId,
    accion: `Respondiste a ${cliente.empresa}`,
    detalle: texto.length > 60 ? `${texto.slice(0, 57)}…` : texto,
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
