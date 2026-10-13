/**
 * Datos de demostración por usuario. Cada cuenta (incluida la demo anónima)
 * recibe su propia copia, con IDs nuevos y fechas desplazadas a "ahora".
 */
import { randomUUID } from 'node:crypto';
import { revisar, supabase } from '../lib/supabase.js';
import * as demo from './demo-data.js';

const EMPRESA_DEMO = 'Distribuidora del Valle';

export async function vaciarDatos(userId: string): Promise<void> {
  // clientes arrastra en cascada facturas, prioridades, mensajes, promesas, escalamientos y eventos ligados.
  revisar(await supabase.from('eventos_agente').delete().eq('user_id', userId), 'vaciar eventos');
  revisar(await supabase.from('pagos').delete().eq('user_id', userId), 'vaciar pagos');
  revisar(await supabase.from('clientes').delete().eq('user_id', userId), 'vaciar clientes');
}

export async function sembrarDemo(userId: string, empresa: string): Promise<void> {
  await vaciarDatos(userId);

  const desfase = Date.now() - demo.generadoEn;
  const mover = (iso: string) => new Date(new Date(iso).getTime() + desfase).toISOString();
  const ids = new Map<string, string>();
  const id = (viejo: string) => {
    if (!ids.has(viejo)) ids.set(viejo, randomUUID());
    return ids.get(viejo)!;
  };
  const texto = (s: string) => s.split(EMPRESA_DEMO).join(empresa);

  const insertar = async (tabla: string, filas: object[]) => {
    if (filas.length) revisar(await supabase.from(tabla).insert(filas), `sembrar ${tabla}`);
  };

  await insertar(
    'clientes',
    demo.clientes.map((c) => ({
      id: id(c.id),
      user_id: userId,
      nombre: c.nombre,
      empresa: c.empresa,
      telefono: c.telefono,
      email: c.email,
      canal: c.canal
    }))
  );

  await insertar(
    'facturas',
    demo.facturas.map((f) => ({
      id: id(f.id),
      user_id: userId,
      cliente_id: id(f.clienteId),
      folio: f.folio,
      monto: f.monto,
      fecha_emision: mover(f.fechaEmision),
      fecha_vencimiento: mover(f.fechaVencimiento),
      // "vencida" se recalcula en vivo; se guarda el estado administrativo.
      estado: f.estado === 'vencida' ? 'pendiente' : f.estado
    }))
  );

  await Promise.all([
    insertar(
      'prioridades',
      demo.prioridades.map((p) => ({
        cliente_id: id(p.clienteId),
        user_id: userId,
        score: p.score,
        nivel: p.nivel,
        razon: p.razon
      }))
    ),
    insertar(
      'mensajes',
      demo.mensajes.map((m) => ({
        id: id(m.id),
        user_id: userId,
        cliente_id: id(m.clienteId),
        rol: m.rol,
        agente: m.agente,
        contenido: texto(m.contenido),
        tono: m.tono,
        es_plantilla: m.esPlantilla,
        canal: 'simulador',
        fecha: mover(m.fecha)
      }))
    ),
    insertar(
      'eventos_agente',
      demo.eventosAgente.map((e) => ({
        id: id(e.id),
        user_id: userId,
        cliente_id: e.clienteId ? id(e.clienteId) : null,
        agente: e.agente,
        accion: e.accion,
        detalle: e.detalle,
        estado: e.estado,
        fecha: mover(e.fecha)
      }))
    ),
    insertar(
      'promesas',
      demo.promesas.map((p) => ({
        id: id(p.id),
        user_id: userId,
        cliente_id: id(p.clienteId),
        factura_id: id(p.facturaId),
        monto: p.monto,
        fecha_compromiso: mover(p.fechaCompromiso),
        estado: p.estado
      }))
    ),
    insertar(
      'escalamientos',
      demo.escalamientos.map((e) => ({
        id: id(e.id),
        user_id: userId,
        cliente_id: id(e.clienteId),
        motivo: e.motivo,
        fecha: mover(e.fecha),
        resuelto: e.resuelto
      }))
    ),
    // Historial de pagos: alimenta "recuperado este mes" y la gráfica semanal.
    insertar(
      'pagos',
      demo.recuperacionSemanal.map((p, i, arr) => ({
        user_id: userId,
        cliente_id: null,
        monto: p.valor,
        fecha: new Date(Date.now() - (arr.length - 1 - i) * 7 * 86_400_000 - 3_600_000).toISOString()
      }))
    )
  ]);
}
