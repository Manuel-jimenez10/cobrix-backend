/**
 * Acceso a datos por usuario. Todas las consultas filtran por user_id.
 * La cartera de una PyME es pequeña (decenas de clientes), así que cargamos
 * el estado completo del usuario por petición y calculamos en memoria.
 */
import { randomUUID } from 'node:crypto';
import { revisar, supabase } from '../lib/supabase.js';
import { diasHasta } from '../shared/format.js';
import { conDefaults, type Politicas } from '../shared/politicas.js';
import type {
  AgenteId,
  Canal,
  Cliente,
  Escalamiento,
  EstadoFactura,
  EventoAgente,
  Factura,
  Mensaje,
  Prioridad,
  PromesaPago
} from '../shared/types.js';

export interface Perfil {
  userId: string;
  nombre: string;
  empresa: string;
  canal: Canal;
  telefonoPrueba: string | null;
  esAnonimo: boolean;
  politicas: Politicas;
  /** WhatsApp propio de la empresa. */
  wa: { phoneNumberId: string | null; numero: string | null; nombre: string | null; estado: 'verificando' | 'conectado' | null };
}

export interface Pago {
  id: string;
  clienteId: string | null;
  monto: number;
  fecha: string;
}

export interface Db {
  userId: string;
  perfil: Perfil;
  clientes: Cliente[];
  facturas: Factura[];
  prioridades: Prioridad[];
  mensajes: Mensaje[];
  eventos: EventoAgente[];
  promesas: PromesaPago[];
  escalamientos: Escalamiento[];
  pagos: Pago[];
}

/* ───────────── Mapeo filas (snake_case) → tipos de la app ───────────── */

type Fila = Record<string, any>;
const num = (v: unknown) => Number(v ?? 0);

export const aPerfil = (r: Fila): Perfil => ({
  userId: r.user_id,
  nombre: r.nombre,
  empresa: r.empresa,
  canal: r.canal,
  telefonoPrueba: r.telefono_prueba ?? null,
  esAnonimo: Boolean(r.es_anonimo),
  politicas: conDefaults(r.politicas),
  wa: { phoneNumberId: r.wa_phone_number_id ?? null, numero: r.wa_numero ?? null, nombre: r.wa_nombre ?? null, estado: r.wa_estado ?? null }
});

export const aCliente = (r: Fila): Cliente => ({
  id: r.id,
  nombre: r.nombre,
  empresa: r.empresa,
  telefono: r.telefono,
  email: r.email ?? '',
  canal: r.canal
});

/** El estado "vencida" y los días de atraso se calculan en vivo a partir del vencimiento. */
export function aFactura(r: Fila): Factura {
  const guardado = r.estado as EstadoFactura;
  const dias = Math.max(0, -diasHasta(r.fecha_vencimiento));
  const estado: EstadoFactura = guardado === 'pendiente' && dias > 0 ? 'vencida' : guardado;
  return {
    id: r.id,
    clienteId: r.cliente_id,
    folio: r.folio,
    monto: num(r.monto),
    fechaEmision: r.fecha_emision,
    fechaVencimiento: r.fecha_vencimiento,
    estado,
    diasAtraso: estado === 'pagada' ? 0 : dias
  };
}

export const aPrioridad = (r: Fila): Prioridad => ({
  clienteId: r.cliente_id,
  score: r.score,
  nivel: r.nivel,
  razon: r.razon
});

export const aMensaje = (r: Fila): Mensaje => ({
  id: r.id,
  clienteId: r.cliente_id,
  rol: r.rol,
  agente: r.agente ?? null,
  contenido: r.contenido,
  tono: r.tono ?? null,
  esPlantilla: Boolean(r.es_plantilla),
  fecha: r.fecha
});

export const aEvento = (r: Fila): EventoAgente => ({
  id: r.id,
  clienteId: r.cliente_id ?? null,
  agente: r.agente,
  accion: r.accion,
  detalle: r.detalle ?? '',
  estado: r.estado,
  fecha: r.fecha
});

export const aPromesa = (r: Fila): PromesaPago => ({
  id: r.id,
  clienteId: r.cliente_id,
  facturaId: r.factura_id ?? '',
  monto: num(r.monto),
  fechaCompromiso: r.fecha_compromiso,
  estado: r.estado
});

export const aEscalamiento = (r: Fila): Escalamiento => ({
  id: r.id,
  clienteId: r.cliente_id,
  motivo: r.motivo,
  fecha: r.fecha,
  resuelto: Boolean(r.resuelto)
});

export const aPago = (r: Fila): Pago => ({ id: r.id, clienteId: r.cliente_id ?? null, monto: num(r.monto), fecha: r.fecha });

/* ───────────── Lectura ───────────── */

export async function obtenerPerfil(userId: string): Promise<Perfil | null> {
  const r = await supabase.from('perfiles').select('*').eq('user_id', userId).maybeSingle();
  const fila = revisar(r, 'perfil');
  return fila ? aPerfil(fila) : null;
}

export async function cargarDb(userId: string): Promise<Db> {
  const desde = (tabla: string) => supabase.from(tabla).select('*').eq('user_id', userId);
  const [perfil, clientes, facturas, prioridades, mensajes, eventos, promesas, escalamientos, pagos] = await Promise.all([
    supabase.from('perfiles').select('*').eq('user_id', userId).single(),
    desde('clientes'),
    desde('facturas'),
    desde('prioridades'),
    desde('mensajes').order('fecha', { ascending: true }),
    desde('eventos_agente').order('fecha', { ascending: false }).limit(80),
    desde('promesas'),
    desde('escalamientos'),
    desde('pagos')
  ]);
  return {
    userId,
    perfil: aPerfil(revisar(perfil, 'perfil')),
    clientes: (revisar(clientes, 'clientes') ?? []).map(aCliente),
    facturas: (revisar(facturas, 'facturas') ?? []).map(aFactura),
    prioridades: (revisar(prioridades, 'prioridades') ?? []).map(aPrioridad),
    mensajes: (revisar(mensajes, 'mensajes') ?? []).map(aMensaje),
    eventos: (revisar(eventos, 'eventos') ?? []).map(aEvento),
    promesas: (revisar(promesas, 'promesas') ?? []).map(aPromesa),
    escalamientos: (revisar(escalamientos, 'escalamientos') ?? []).map(aEscalamiento),
    pagos: (revisar(pagos, 'pagos') ?? []).map(aPago)
  };
}

/* ───────────── Escritura ───────────── */

export async function insertarMensaje(
  userId: string,
  m: Omit<Mensaje, 'id' | 'fecha'> & { canal: Canal; waMessageId?: string | null }
): Promise<Mensaje> {
  const r = await supabase
    .from('mensajes')
    .insert({
      user_id: userId,
      cliente_id: m.clienteId,
      rol: m.rol,
      agente: m.agente,
      contenido: m.contenido,
      tono: m.tono,
      es_plantilla: m.esPlantilla,
      canal: m.canal,
      wa_message_id: m.waMessageId ?? null
    })
    .select()
    .single();
  return aMensaje(revisar(r, 'insertar mensaje'));
}

/** Registra una acción de un agente. Supabase Realtime la empuja al dashboard. */
export async function emitirEvento(
  userId: string,
  e: { id?: string; agente: AgenteId; clienteId: string | null; accion: string; detalle: string; estado: EventoAgente['estado'] }
): Promise<EventoAgente> {
  const r = await supabase
    .from('eventos_agente')
    .insert({ ...(e.id ? { id: e.id } : {}), user_id: userId, cliente_id: e.clienteId, agente: e.agente, accion: e.accion, detalle: e.detalle, estado: e.estado })
    .select()
    .single();
  return aEvento(revisar(r, 'emitir evento'));
}

export async function actualizarEvento(
  userId: string,
  id: string,
  cambios: Partial<Pick<EventoAgente, 'accion' | 'detalle' | 'estado'>>
): Promise<void> {
  revisar(
    await supabase
      .from('eventos_agente')
      .update({ ...cambios, fecha: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId),
    'actualizar evento'
  );
}

export async function guardarPrioridades(userId: string, prioridades: Prioridad[]): Promise<void> {
  if (!prioridades.length) return;
  revisar(
    await supabase.from('prioridades').upsert(
      prioridades.map((p) => ({
        cliente_id: p.clienteId,
        user_id: userId,
        score: p.score,
        nivel: p.nivel,
        razon: p.razon,
        updated_at: new Date().toISOString()
      }))
    ),
    'guardar prioridades'
  );
}

export async function insertarPromesa(userId: string, p: Omit<PromesaPago, 'id'>): Promise<PromesaPago> {
  const r = await supabase
    .from('promesas')
    .insert({
      user_id: userId,
      cliente_id: p.clienteId,
      factura_id: p.facturaId || null,
      monto: p.monto,
      fecha_compromiso: p.fechaCompromiso,
      estado: p.estado
    })
    .select()
    .single();
  return aPromesa(revisar(r, 'insertar promesa'));
}

export async function insertarEscalamiento(userId: string, clienteId: string, motivo: string): Promise<Escalamiento> {
  const r = await supabase
    .from('escalamientos')
    .insert({ user_id: userId, cliente_id: clienteId, motivo })
    .select()
    .single();
  return aEscalamiento(revisar(r, 'insertar escalamiento'));
}

export async function actualizarFacturas(
  userId: string,
  ids: string[],
  cambios: { estado?: EstadoFactura; monto?: number }
): Promise<void> {
  if (!ids.length) return;
  revisar(await supabase.from('facturas').update(cambios).in('id', ids).eq('user_id', userId), 'actualizar facturas');
}

export async function insertarPago(userId: string, clienteId: string | null, monto: number): Promise<void> {
  if (monto <= 0) return;
  revisar(await supabase.from('pagos').insert({ user_id: userId, cliente_id: clienteId, monto }), 'insertar pago');
}

export async function actualizarPerfil(
  userId: string,
  cambios: Partial<{
    canal: Canal;
    telefono_prueba: string | null;
    nombre: string;
    empresa: string;
    politicas: Politicas;
    wa_phone_number_id: string | null;
    wa_numero: string | null;
    wa_nombre: string | null;
    wa_estado: 'verificando' | 'conectado' | null;
    wa_pin: string | null;
    wa_conectado_en: string | null;
  }>
): Promise<void> {
  revisar(await supabase.from('perfiles').update(cambios).eq('user_id', userId), 'actualizar perfil');
}

/**
 * Bitácora de eventos que NO bloquea el flujo: las escrituras se encadenan en orden
 * (Realtime las muestra en secuencia) mientras los agentes siguen trabajando.
 */
export function bitacora(userId: string) {
  let cadena: Promise<unknown> = Promise.resolve();
  const enCola = (fn: () => Promise<unknown>) => {
    cadena = cadena.then(fn).catch((error) => console.warn('[bitácora]', error instanceof Error ? error.message : error));
  };
  return {
    emitir(e: Parameters<typeof emitirEvento>[1]): string {
      const id = e.id ?? randomUUID();
      enCola(() => emitirEvento(userId, { ...e, id }));
      return id;
    },
    actualizar(id: string, cambios: Parameters<typeof actualizarEvento>[2]) {
      enCola(() => actualizarEvento(userId, id, cambios));
    },
    /** Espera a que se escriban todos los eventos pendientes. */
    listo: () => cadena
  };
}
