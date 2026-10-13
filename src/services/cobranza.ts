/**
 * Orquestación de los flujos de cobranza (los usan las rutas HTTP y el webhook).
 *
 *   iniciarCobranza:   Analista prioriza → Redactor redacta → se envía por el canal.
 *   procesarRespuesta: llega la respuesta del deudor → Negociador contesta →
 *                      registra promesa o escala → se responde por el canal.
 *
 * Cada paso emite un evento en eventos_agente → Supabase Realtime → dashboard en vivo.
 */
import { afinarConIA, priorizarRapido } from '../agents/analista.js';
import { negociar } from '../agents/negociador.js';
import { redactar } from '../agents/redactor.js';
import { canalSimulador, type CanalMensajeria } from '../channels/canal.js';
import { canalWhatsApp } from '../channels/whatsapp.js';
import { whatsappConfigurado } from '../env.js';
import {
  actualizarEvento,
  actualizarFacturas,
  bitacora,
  cargarDb,
  emitirEvento,
  guardarPrioridades,
  insertarEscalamiento,
  insertarMensaje,
  insertarPromesa,
  type Db
} from '../domain/db.js';
import { facturasAbiertas, resumir } from '../domain/logic.js';
import { formatFecha, formatMXN } from '../shared/format.js';
import { describirHorario, dentroDeHorario, limitarTono } from '../shared/politicas.js';
import { estadoVentana, siguienteTono } from '../shared/reglas.js';
import type {
  Cliente,
  EventoNegociacion,
  Mensaje,
  ProgresoCobranza,
  ResultadoCobranza,
  Tono
} from '../shared/types.js';

/** Error de política: la UI lo muestra tal cual. */
export class FueraDeHorario extends Error {}

export function canalPara(db: Db, cliente: Cliente): CanalMensajeria {
  if (db.perfil.canal === 'simulador' || cliente.canal === 'simulador' || !whatsappConfigurado) return canalSimulador;
  return canalWhatsApp;
}

/** En modo demo todos los WhatsApp se redirigen al número de prueba del administrador. */
export const destinoDe = (db: Db, cliente: Cliente) => db.perfil.telefonoPrueba || cliente.telefono;

export async function iniciarCobranza(
  userId: string,
  clienteIds: string[],
  opciones: { tono?: Tono; onProgreso?: (p: ProgresoCobranza) => void }
): Promise<ResultadoCobranza> {
  const db = await cargarDb(userId);
  const politicas = db.perfil.politicas;
  if (!dentroDeHorario(politicas)) {
    throw new FueraDeHorario(`Fuera del horario de cobranza configurado (${describirHorario(politicas)}). Cámbialo en Ajustes → Políticas.`);
  }
  const log = bitacora(userId);
  const candidatos = clienteIds
    .map((id) => db.clientes.find((c) => c.id === id))
    .filter((c): c is Cliente => Boolean(c))
    .map((c) => resumir(db, c))
    .filter((c) => c.deuda > 0 && !c.escalado);

  // 1. Analista: orden instantáneo. Usa la prioridad que ya tenía cada cliente y calcula por reglas
  //    solo a los nuevos. La IA afina scores y razones en segundo plano (no bloquea el envío).
  opciones.onProgreso?.({ fase: 'analizando', orden: [], actualId: null, enviados: [] });
  const evA = log.emitir({
    agente: 'analista',
    clienteId: null,
    accion: 'Priorizando cola de cobranza',
    detalle: `${candidatos.length} clientes en evaluación`,
    estado: 'en_progreso'
  });
  const sinPrioridad = candidatos.filter((c) => !db.prioridades.some((p) => p.clienteId === c.id));
  const nuevas = priorizarRapido(db, sinPrioridad);
  if (nuevas.length) {
    await guardarPrioridades(userId, nuevas);
    db.prioridades = [...db.prioridades, ...nuevas];
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
    accion: 'Priorizó la cola',
    detalle: priorizados[0] ? `${priorizados[0].empresa} va primero · score ${priorizados[0].prioridad.score}` : 'Sin clientes por cobrar'
  });

  // 2. Redactor: todos los borradores en paralelo (las plantillas son instantáneas;
  //    solo los clientes con ventana de 24 h abierta llaman a la IA).
  const borradores = new Map(
    await Promise.all(orden.map(async (item) => [item.clienteId, await redactar(db, priorizados.find((x) => x.id === item.clienteId)!, item.tono)] as const))
  );

  const enviados: string[] = [];
  const mensajes: Mensaje[] = [];
  const reportar = (fase: ProgresoCobranza['fase'], actualId: string | null) =>
    opciones.onProgreso?.({ fase, orden, actualId, enviados: [...enviados] });

  // 3. Envío por el canal, en orden de prioridad
  for (const item of orden) {
    const c = priorizados.find((x) => x.id === item.clienteId)!;
    const borrador = borradores.get(c.id)!;
    reportar('redactando', c.id);
    const evR = log.emitir({ agente: 'redactor', clienteId: c.id, accion: 'Redactando mensaje', detalle: `Tono ${item.tono} para ${c.empresa}`, estado: 'en_progreso' });

    reportar('enviando', c.id);
    const canal = canalPara(db, c);
    const destino = destinoDe(db, c);
    const envio = borrador.esPlantilla
      ? await canal.enviarPlantilla({ telefono: destino, tono: item.tono, variables: borrador.variables })
      : await canal.enviarTexto(destino, borrador.contenido);

    if (!envio.ok) {
      log.actualizar(evR, { estado: 'error', accion: 'No se pudo enviar por WhatsApp', detalle: `${c.empresa} · ${envio.error ?? 'error desconocido'}` });
      continue;
    }

    const mensaje = await insertarMensaje(userId, {
      clienteId: c.id,
      rol: 'agente',
      agente: 'redactor',
      contenido: borrador.contenido,
      tono: item.tono,
      esPlantilla: borrador.esPlantilla,
      canal: canal.nombre,
      waMessageId: envio.messageId ?? null
    });
    db.mensajes.push(mensaje);
    mensajes.push(mensaje);
    enviados.push(c.id);
    log.actualizar(evR, {
      estado: 'completado',
      accion: canal.nombre === 'whatsapp' ? 'Mensaje enviado por WhatsApp' : 'Mensaje enviado al simulador',
      detalle: `${borrador.esPlantilla ? 'Plantilla' : 'Mensaje'} ${item.tono} · ${c.empresa}`
    });
    reportar('enviando', null);
  }

  reportar('listo', null);
  await log.listo();

  // 4. En segundo plano: la IA afina scores y razones; Realtime avisa al dashboard cuando termina.
  void (async () => {
    const afinadas = await afinarConIA(db, candidatos);
    if (!afinadas?.length) return;
    await guardarPrioridades(userId, afinadas);
    await emitirEvento(userId, {
      agente: 'analista',
      clienteId: null,
      accion: 'Afinó prioridades con IA',
      detalle: `${afinadas.length} clientes reevaluados`,
      estado: 'completado'
    });
  })().catch((error) => console.warn('[Analista] afinado en segundo plano:', error));

  return { enviados: enviados.length, mensajes };
}

export async function procesarRespuesta(
  userId: string,
  clienteId: string,
  texto: string,
  origen: 'simulador' | 'whatsapp',
  emitir: (ev: EventoNegociacion) => void = () => {},
  waMessageId?: string
): Promise<void> {
  const db = await cargarDb(userId);
  const cliente = db.clientes.find((c) => c.id === clienteId);
  if (!cliente) throw new Error('Cliente no encontrado');

  const msgCliente = await insertarMensaje(userId, {
    clienteId,
    rol: 'cliente',
    agente: null,
    contenido: texto,
    tono: null,
    esPlantilla: false,
    canal: origen,
    waMessageId: waMessageId ?? null
  });
  db.mensajes.push(msgCliente);
  emitir({ tipo: 'cliente', mensaje: msgCliente });

  const resumen = resumir(db, cliente);
  const ev = await emitirEvento(userId, {
    agente: 'negociador',
    clienteId,
    accion: 'Leyendo respuesta',
    detalle: `${cliente.empresa} respondió`,
    estado: 'en_progreso'
  });
  emitir({ tipo: 'pensando' });

  // Saldos por encima del umbral configurado los atiende siempre una persona.
  const umbral = db.perfil.politicas.escalar.montoMayorA;
  const porMonto = !resumen.escalado && umbral !== null && resumen.deuda > umbral;

  // Si el caso ya está escalado (o debe escalarse por monto), el agente no negocia.
  const r = porMonto
    ? await (async () => {
        const t = `Gracias por tu mensaje, ${cliente.nombre.split(' ')[0]}. Para darte la mejor atención, una persona de nuestro equipo revisará tu caso y te contactará hoy mismo.`;
        emitir({ tipo: 'delta', texto: t });
        return { texto: t, tono: 'amable' as Tono, conIA: false, promesa: undefined, escalamiento: { motivo: `Saldo de ${formatMXN(resumen.deuda)} supera el límite de ${formatMXN(umbral!)} para negociación automática.` } };
      })()
    : resumen.escalado
    ? await (async () => {
        const t = `Gracias por tu mensaje, ${cliente.nombre.split(' ')[0]}. Tu caso lo está revisando una persona de nuestro equipo; te contactará a la brevedad.`;
        emitir({ tipo: 'delta', texto: t });
        return { texto: t, tono: 'amable' as Tono, conIA: false, promesa: undefined, escalamiento: undefined };
      })()
    : await negociar(db, resumen, (d) => emitir({ tipo: 'delta', texto: d }));

  // Respuesta por el canal real (dentro de la ventana de 24 h se permite texto libre).
  const canal = origen === 'whatsapp' ? canalPara(db, cliente) : canalSimulador;
  const envio = await canal.enviarTexto(destinoDe(db, cliente), r.texto);

  const msgAgente = await insertarMensaje(userId, {
    clienteId,
    rol: 'agente',
    agente: 'negociador',
    contenido: r.texto,
    tono: r.tono,
    esPlantilla: false,
    canal: canal.nombre,
    waMessageId: envio.messageId ?? null
  });

  if (r.promesa) {
    const abiertas = facturasAbiertas(db, clienteId).sort((a, b) => b.diasAtraso - a.diasAtraso);
    const promesa = await insertarPromesa(userId, {
      clienteId,
      facturaId: abiertas[0]?.id ?? '',
      monto: r.promesa.monto,
      fechaCompromiso: new Date(Date.now() + r.promesa.dias * 86_400_000).toISOString(),
      estado: 'pendiente'
    });
    await actualizarFacturas(userId, abiertas.map((f) => f.id), { estado: 'promesa' });
    await actualizarEvento(userId, ev.id, {
      estado: 'completado',
      accion: 'Registró promesa de pago',
      detalle: `${formatMXN(promesa.monto)} · ${cliente.empresa} · ${formatFecha(promesa.fechaCompromiso)}`
    });
    emitir({ tipo: 'promesa', promesa });
  } else if (r.escalamiento) {
    const escalamiento = await insertarEscalamiento(userId, clienteId, r.escalamiento.motivo);
    await actualizarEvento(userId, ev.id, { estado: 'error', accion: 'Escaló a humano', detalle: `${cliente.empresa} · ${escalamiento.motivo}` });
    emitir({ tipo: 'escalamiento', escalamiento });
  } else {
    await actualizarEvento(userId, ev.id, {
      estado: envio.ok ? 'completado' : 'error',
      accion: envio.ok ? 'Respondió al cliente' : 'No se pudo responder por WhatsApp',
      detalle: envio.ok ? `${cliente.empresa} · negociación en curso` : `${cliente.empresa} · ${envio.error ?? ''}`
    });
  }

  emitir({ tipo: 'fin', mensaje: msgAgente });
}

/** Ventana de 24 h abierta para un cliente (para la UI y el Redactor). */
export const ventanaAbierta = (db: Db, clienteId: string) => estadoVentana(db.mensajes.filter((m) => m.clienteId === clienteId)).abierta;
