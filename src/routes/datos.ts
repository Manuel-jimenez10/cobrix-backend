/** Lecturas y mutaciones simples de la cartera (sin IA). */
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { verificarConexion } from '../channels/whatsapp.js';
import {
  actualizarFacturas,
  actualizarPerfil,
  cargarDb,
  emitirEvento,
  insertarPago,
  obtenerPerfil
} from '../domain/db.js';
import { construirDashboard, facturasAbiertas, porFecha, resumenes, resumir, suma } from '../domain/logic.js';
import { sembrarDemo, vaciarDatos } from '../domain/seed.js';
import { env, iaDisponible, whatsappConfigurado } from '../env.js';
import { revisar, supabase } from '../lib/supabase.js';
import type { AppEnv } from '../middleware/auth.js';
import { formatMXN, normalizar } from '../shared/format.js';
import { plantillas } from '../shared/plantillas.js';
import { type Politicas } from '../shared/politicas.js';
import type { Ajustes, PromesaConCliente } from '../shared/types.js';

export const datos = new Hono<AppEnv>();

datos.get('/perfil', async (c) => {
  const perfil = await obtenerPerfil(c.get('userId'));
  if (!perfil) throw new HTTPException(404, { message: 'Perfil no encontrado' });
  return c.json({ nombre: perfil.nombre, empresa: perfil.empresa, esAnonimo: perfil.esAnonimo, iaActiva: iaDisponible, modelo: iaDisponible ? env.geminiModel : null });
});

datos.get('/dashboard', async (c) => c.json(construirDashboard(await cargarDb(c.get('userId')))));

datos.get('/clientes', async (c) => {
  const db = await cargarDb(c.get('userId'));
  const { busqueda = '', estado = 'todos', prioridad = 'todas', orden = 'prioridad' } = c.req.query();
  const q = normalizar(busqueda).trim();
  let lista = resumenes(db);
  if (q) {
    lista = lista.filter((r) => {
      const folios = db.facturas.filter((f) => f.clienteId === r.id).map((f) => f.folio).join(' ');
      return normalizar(`${r.empresa} ${r.nombre} ${r.telefono} ${folios}`).includes(q);
    });
  }
  if (estado !== 'todos') lista = lista.filter((r) => r.estado === estado);
  if (prioridad !== 'todas') lista = lista.filter((r) => r.prioridad.nivel === prioridad);
  lista.sort((a, b) => {
    if (orden === 'monto') return b.deuda - a.deuda;
    if (orden === 'atraso') return b.diasAtraso - a.diasAtraso;
    if (orden === 'nombre') return a.empresa.localeCompare(b.empresa, 'es');
    return b.prioridad.score - a.prioridad.score;
  });
  return c.json(lista);
});

datos.get('/clientes/:id', async (c) => {
  const db = await cargarDb(c.get('userId'));
  const id = c.req.param('id');
  const cliente = db.clientes.find((x) => x.id === id);
  if (!cliente) return c.json(null);
  return c.json({
    cliente: resumir(db, cliente),
    facturas: db.facturas.filter((f) => f.clienteId === id).sort((a, b) => b.diasAtraso - a.diasAtraso),
    mensajes: db.mensajes.filter((m) => m.clienteId === id).sort(porFecha),
    promesas: db.promesas.filter((p) => p.clienteId === id).sort((a, b) => b.fechaCompromiso.localeCompare(a.fechaCompromiso)),
    escalamientos: db.escalamientos.filter((e) => e.clienteId === id)
  });
});

datos.get('/promesas', async (c) => {
  const db = await cargarDb(c.get('userId'));
  const lista: PromesaConCliente[] = [];
  for (const p of db.promesas) {
    const cliente = db.clientes.find((x) => x.id === p.clienteId);
    if (cliente) lista.push({ ...p, cliente, folio: db.facturas.find((f) => f.id === p.facturaId)?.folio ?? '—' });
  }
  return c.json(lista.sort((a, b) => a.fechaCompromiso.localeCompare(b.fechaCompromiso)));
});

datos.get('/eventos-agente', async (c) => c.json((await cargarDb(c.get('userId'))).eventos));

datos.post('/facturas/pagar', async (c) => {
  const userId = c.get('userId');
  const { clienteId } = z.object({ clienteId: z.string() }).parse(await c.req.json());
  const db = await cargarDb(userId);
  const cliente = db.clientes.find((x) => x.id === clienteId);
  if (!cliente) throw new HTTPException(404, { message: 'Cliente no encontrado' });
  const abiertas = facturasAbiertas(db, clienteId);
  const monto = suma(abiertas);
  await actualizarFacturas(userId, abiertas.map((f) => f.id), { estado: 'pagada' });
  revisar(
    await supabase.from('promesas').update({ estado: 'cumplida' }).eq('user_id', userId).eq('cliente_id', clienteId).eq('estado', 'pendiente'),
    'cumplir promesas'
  );
  await insertarPago(userId, clienteId, monto);
  await emitirEvento(userId, { agente: 'director', clienteId, accion: 'Registró pago', detalle: `${cliente.empresa} · ${formatMXN(monto)}`, estado: 'completado' });
  return c.json({ monto });
});

datos.post('/promesas/:id/cumplir', async (c) => {
  const userId = c.get('userId');
  const db = await cargarDb(userId);
  const promesa = db.promesas.find((p) => p.id === c.req.param('id'));
  if (!promesa) throw new HTTPException(404, { message: 'Promesa no encontrada' });
  revisar(await supabase.from('promesas').update({ estado: 'cumplida' }).eq('id', promesa.id).eq('user_id', userId), 'cumplir promesa');

  const factura = db.facturas.find((f) => f.id === promesa.facturaId);
  if (factura && factura.estado !== 'pagada') {
    if (promesa.monto >= factura.monto - 0.01) {
      await actualizarFacturas(userId, [factura.id], { estado: 'pagada' });
    } else {
      // Pago parcial: se descuenta del saldo y la factura vuelve a su estado natural.
      await actualizarFacturas(userId, [factura.id], { monto: Math.round((factura.monto - promesa.monto) * 100) / 100, estado: 'pendiente' });
    }
  }
  await insertarPago(userId, promesa.clienteId, promesa.monto);
  const cliente = db.clientes.find((x) => x.id === promesa.clienteId);
  await emitirEvento(userId, {
    agente: 'negociador',
    clienteId: promesa.clienteId,
    accion: 'Promesa cumplida',
    detalle: `${cliente?.empresa ?? ''} · ${formatMXN(promesa.monto)}`,
    estado: 'completado'
  });
  return c.json({ ok: true });
});

datos.get('/ajustes', async (c) => {
  const perfil = await obtenerPerfil(c.get('userId'));
  const ajustes: Ajustes & { telefonoPrueba: string | null; iaActiva: boolean } = {
    canal: perfil?.canal ?? 'simulador',
    telefonoPrueba: perfil?.telefonoPrueba ?? null,
    iaActiva: iaDisponible,
    whatsapp: {
      conectado: whatsappConfigurado,
      numero: whatsappConfigurado ? (await verificarConexion()).numero ?? 'Número de prueba de Meta' : 'No configurado',
      proveedor: 'WhatsApp Business Platform · Cloud API',
      plantillasAprobadas: whatsappConfigurado ? plantillas.length : 0,
      ultimaSincronizacion: new Date().toISOString()
    }
  };
  return c.json(ajustes);
});

datos.patch('/ajustes', async (c) => {
  const cuerpo = z
    .object({
      canal: z.enum(['whatsapp', 'simulador']).optional(),
      telefonoPrueba: z.string().regex(/^\+?[\d\s()-]{8,20}$/, 'Teléfono inválido').nullable().optional()
    })
    .parse(await c.req.json());
  await actualizarPerfil(c.get('userId'), {
    ...(cuerpo.canal ? { canal: cuerpo.canal } : {}),
    ...(cuerpo.telefonoPrueba !== undefined ? { telefono_prueba: cuerpo.telefonoPrueba?.trim() || null } : {})
  });
  return c.json({ ok: true });
});

datos.post('/whatsapp/probar', async (c) => {
  const r = await verificarConexion();
  if (!r.ok) throw new HTTPException(502, { message: r.error ?? 'No se pudo conectar con WhatsApp' });
  return c.json(r);
});

datos.post('/demo/cargar', async (c) => {
  const userId = c.get('userId');
  const perfil = await obtenerPerfil(userId);
  await sembrarDemo(userId, perfil?.empresa ?? 'Distribuidora del Valle');
  return c.json({ ok: true });
});

datos.post('/demo/vaciar', async (c) => {
  await vaciarDatos(c.get('userId'));
  return c.json({ ok: true });
});

/* ───────────── Políticas de negociación ───────────── */

const hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Formato HH:MM');
const esquemaPoliticas: z.ZodType<Politicas> = z
  .object({
    maxPagos: z.number().int().min(1).max(6),
    plazoMaxDias: z.number().int().min(1).max(90),
    pagoInicialMinPct: z.number().min(0).max(100),
    descuentoMaxPct: z.number().min(0).max(30),
    tonoMaximo: z.enum(['amable', 'firme', 'final']),
    escalar: z.object({
      disputa: z.boolean(),
      productoDefectuoso: z.boolean(),
      legal: z.boolean(),
      pideHumano: z.boolean(),
      montoMayorA: z.number().positive().nullable()
    }),
    horario: z
      .object({ activo: z.boolean(), dias: z.array(z.number().int().min(0).max(6)).min(1), desde: hora, hasta: hora })
      .refine((h) => h.desde < h.hasta, 'La hora de inicio debe ser anterior a la de fin')
  })
  .strict();

datos.get('/politicas', async (c) => {
  const perfil = await obtenerPerfil(c.get('userId'));
  if (!perfil) throw new HTTPException(404, { message: 'Perfil no encontrado' });
  return c.json(perfil.politicas);
});

datos.put('/politicas', async (c) => {
  const politicas = esquemaPoliticas.parse(await c.req.json());
  await actualizarPerfil(c.get('userId'), { politicas });
  return c.json(politicas);
});
