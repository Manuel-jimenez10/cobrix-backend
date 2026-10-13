/**
 * Director: el agente coordinador con el que conversa el administrador.
 *
 * Cada herramienta "delega" en un agente (Analista o Redactor),
 * consulta datos REALES de la cartera y devuelve dos cosas:
 *   · un resumen compacto para el modelo (así no inventa cifras), y
 *   · bloques de UI (KPI, gráfica, lista de clientes, confirmación) que el
 *     frontend pinta dentro del chat (generative UI).
 * Ninguna acción de envío se ejecuta sin confirmación humana (human in the loop).
 */
import { randomUUID } from 'node:crypto';
import { stepCountIs, streamText, tool } from 'ai';
import { z } from 'zod';
import type { Db } from '../domain/db.js';
import { porFecha, recuperacionSemanal, resumenes, suma, variacion, variacionesSemana } from '../domain/logic.js';
import type { BloqueDirector, EventoDirector, MensajeDirector } from '../shared/director-types.js';
import { formatFecha, formatMXN, normalizar, tiempoRelativo } from '../shared/format.js';
import { describirHorario, describirParaAgente, limitarTono } from '../shared/politicas.js';
import type { AgenteId, ClienteResumen } from '../shared/types.js';
import { hoyTexto, iaDisponible, modelo, registrarErrorIA, turnosAlternados, conLimite, opcionesRapidas } from './modelo.js';
import { planDirector } from './respaldo.js';

type Emitir = (ev: EventoDirector) => void;

const DELEGACION: Record<string, { agente: AgenteId; texto: string }> = {
  estado_cartera: { agente: 'analista', texto: 'Consultando al Analista…' },
  buscar_clientes: { agente: 'analista', texto: 'Consultando al Analista…' },
  recuperacion: { agente: 'analista', texto: 'Revisando pagos con el Analista…' },
  clientes_sin_respuesta: { agente: 'analista', texto: 'Revisando conversaciones…' },
  clientes_por_atender: { agente: 'analista', texto: 'Buscando quién espera tu respuesta…' },
  promesas_de_pago: { agente: 'analista', texto: 'Revisando promesas de pago…' },
  casos_escalados: { agente: 'analista', texto: 'Revisando casos en revisión…' },
  proponer_envio: { agente: 'redactor', texto: 'Preparando recordatorios con el Redactor…' },
  politicas_vigentes: { agente: 'analista', texto: 'Revisando tus reglas de cobranza…' }
};

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

function aBloqueClientes(titulo: string, lista: ClienteResumen[], detalle: (c: ClienteResumen) => string): BloqueDirector {
  return { tipo: 'clientes', titulo, clientes: lista.map((c) => ({ id: c.id, empresa: c.empresa, monto: c.deuda, detalle: detalle(c) })) };
}

const compacto = (c: ClienteResumen) => ({
  id: c.id,
  empresa: c.empresa,
  contacto: c.nombre,
  deuda: c.deuda,
  diasAtraso: c.diasAtraso,
  estado: c.estado,
  prioridad: c.prioridad.nivel,
  score: c.prioridad.score,
  escalado: c.escalado,
  esperaRespuesta: c.requiereAtencion
});

function historialParaModelo(mensajes: MensajeDirector[]) {
  return turnosAlternados(
    mensajes.slice(-12).map((m) => ({
      role: m.rol === 'usuario' ? ('user' as const) : ('assistant' as const),
      content:
        m.bloques
          .map((b) => {
            if (b.tipo === 'texto') return b.texto;
            if (b.tipo === 'kpi') return `[Tarjeta: ${b.etiqueta} ${formatMXN(b.valor)}]`;
            if (b.tipo === 'grafica') return `[Gráfica: ${b.titulo}]`;
            if (b.tipo === 'clientes') return `[Lista "${b.titulo}": ${b.clientes.map((c) => c.empresa).join(', ')}]`;
            return `[Confirmación de envío (${b.estado}): ${b.mensaje}]`;
          })
          .join('\n') || '(sin contenido)'
    }))
  );
}

function crearHerramientas(db: Db, bloquesPorLlamada: Map<string, BloqueDirector[]>) {
  const rs = resumenes(db);
  const conSaldo = rs.filter((r) => r.deuda > 0);
  const guardar = (id: string, bloques: BloqueDirector[]) => bloquesPorLlamada.set(id, bloques);

  const sinRespuesta = () =>
    conSaldo
      .map((r) => ({ r, ms: db.mensajes.filter((m) => m.clienteId === r.id).sort(porFecha) }))
      .filter(({ ms }) => ms.length > 0 && ms[ms.length - 1].rol === 'agente')
      .sort((a, b) => b.r.deuda - a.r.deuda);

  const elegibles = (lista: ClienteResumen[]) => lista.filter((r) => r.deuda > 0 && !r.escalado && !r.requiereAtencion && r.estado !== 'promesa');

  return {
    estado_cartera: tool({
      description: 'Panorama general de la cartera: total por cobrar, vencido y clientes más urgentes.',
      inputSchema: z.object({}),
      execute: async (_, { toolCallId }) => {
        const vencidos = rs.filter((r) => r.estado === 'vencido');
        const porCobrar = suma(conSaldo.map((r) => ({ monto: r.deuda })));
        const vencido = suma(db.facturas.filter((f) => f.estado === 'vencida'));
        const urgentes = [...vencidos].filter((r) => !r.escalado).sort((a, b) => b.prioridad.score - a.prioridad.score).slice(0, 3);
        const v = variacionesSemana(db);
        guardar(toolCallId, [
          { tipo: 'kpi', etiqueta: 'Por cobrar', valor: porCobrar, variacion: v.porCobrar, detalle: 'vs. semana pasada', mejorSi: 'baja' },
          ...(urgentes.length ? [aBloqueClientes('Lo más urgente', urgentes, (c) => `${c.diasAtraso} días · score ${c.prioridad.score}`)] : [])
        ]);
        return { porCobrar, vencido, clientesConSaldo: conSaldo.length, clientesVencidos: vencidos.length, urgentes: urgentes.map(compacto) };
      }
    }),

    buscar_clientes: tool({
      description: 'Busca clientes por nombre/empresa o filtra por prioridad o estado.',
      inputSchema: z.object({
        texto: z.string().optional().describe('Nombre o empresa a buscar'),
        prioridad: z.enum(['alta', 'media', 'baja']).optional(),
        estado: z.enum(['al_dia', 'por_vencer', 'vencido', 'promesa']).optional()
      }),
      execute: async ({ texto, prioridad, estado }, { toolCallId }) => {
        const q = normalizar(texto ?? '');
        const lista = rs
          .filter((r) => (!q || normalizar(`${r.empresa} ${r.nombre}`).includes(q)) && (!prioridad || r.prioridad.nivel === prioridad) && (!estado || r.estado === estado))
          .sort((a, b) => b.prioridad.score - a.prioridad.score)
          .slice(0, 8);
        guardar(toolCallId, lista.length ? [aBloqueClientes('Clientes', lista, (c) => `${c.diasAtraso} días · prioridad ${c.prioridad.nivel}`)] : []);
        return { encontrados: lista.length, clientes: lista.map((c) => ({ ...compacto(c), razonAnalista: c.prioridad.razon })) };
      }
    }),

    recuperacion: tool({
      description: 'Dinero recuperado: pagos por semana de las últimas 8 semanas y comparación con la semana anterior.',
      inputSchema: z.object({}),
      execute: async (_, { toolCallId }) => {
        const serie = recuperacionSemanal(db);
        const actual = serie.at(-1)?.valor ?? 0;
        const anterior = serie.at(-2)?.valor ?? 0;
        guardar(toolCallId, [
          { tipo: 'kpi', etiqueta: 'Recuperado esta semana', valor: actual, variacion: variacion(actual, anterior), detalle: 'vs. semana anterior', mejorSi: 'sube' },
          { tipo: 'grafica', titulo: 'Recuperado por semana', total: suma(serie.map((p) => ({ monto: p.valor }))), puntos: serie }
        ]);
        return { estaSemana: actual, semanaAnterior: anterior, totalOchoSemanas: suma(serie.map((p) => ({ monto: p.valor }))) };
      }
    }),

    clientes_sin_respuesta: tool({
      description: 'Clientes con saldo que no han contestado nuestro último mensaje.',
      inputSchema: z.object({}),
      execute: async (_, { toolCallId }) => {
        const lista = sinRespuesta();
        guardar(toolCallId, lista.length ? [aBloqueClientes('Sin respuesta', lista.map((x) => x.r), (c) => {
          const ms = lista.find((x) => x.r.id === c.id)!.ms;
          return `Último mensaje ${tiempoRelativo(ms[ms.length - 1].fecha)}`;
        })] : []);
        return { total: lista.length, clientes: lista.map(({ r, ms }) => ({ ...compacto(r), ultimoMensaje: ms[ms.length - 1].fecha })) };
      }
    }),

    clientes_por_atender: tool({
      description: 'Clientes que respondieron y esperan que alguien del equipo les conteste (sus recordatorios están en pausa).',
      inputSchema: z.object({}),
      execute: async (_, { toolCallId }) => {
        const lista = rs.filter((r) => r.requiereAtencion).sort((a, b) => b.deuda - a.deuda);
        guardar(toolCallId, lista.length ? [aBloqueClientes('Esperan tu respuesta', lista, (c) => `“${(c.ultimoMensaje?.contenido ?? '').slice(0, 48)}” · ${tiempoRelativo(c.ultimoMensaje?.fecha ?? new Date().toISOString())}`)] : []);
        return { total: lista.length, clientes: lista.map((c) => ({ ...compacto(c), ultimoMensajeDelCliente: c.ultimoMensaje?.contenido })) };
      }
    }),

    promesas_de_pago: tool({
      description: 'Promesas de pago pendientes (montos y fechas comprometidas).',
      inputSchema: z.object({}),
      execute: async (_, { toolCallId }) => {
        const pendientes = db.promesas
          .filter((p) => p.estado === 'pendiente')
          .sort((a, b) => a.fechaCompromiso.localeCompare(b.fechaCompromiso));
        const items = pendientes
          .map((p) => ({ p, c: rs.find((r) => r.id === p.clienteId) }))
          .filter((x): x is { p: (typeof pendientes)[number]; c: ClienteResumen } => Boolean(x.c));
        guardar(toolCallId, items.length ? [{
          tipo: 'clientes',
          titulo: 'Promesas activas',
          clientes: items.map(({ p, c }) => ({ id: c.id, empresa: c.empresa, monto: p.monto, detalle: `Compromiso ${formatFecha(p.fechaCompromiso)}` }))
        }] : []);
        return {
          total: items.length,
          montoTotal: suma(pendientes),
          promesas: items.map(({ p, c }) => ({ empresa: c.empresa, monto: p.monto, fecha: formatFecha(p.fechaCompromiso), vencida: new Date(p.fechaCompromiso) < new Date() }))
        };
      }
    }),

    casos_escalados: tool({
      description: 'Casos marcados en revisión del equipo y su motivo.',
      inputSchema: z.object({}),
      execute: async (_, { toolCallId }) => {
        const casos = db.escalamientos.filter((e) => !e.resuelto);
        const lista = casos.map((e) => ({ e, c: rs.find((r) => r.id === e.clienteId) })).filter((x) => x.c) as { e: (typeof casos)[number]; c: ClienteResumen }[];
        guardar(toolCallId, lista.length ? [{
          tipo: 'clientes',
          titulo: 'Escalados a humano',
          clientes: lista.map(({ e, c }) => ({ id: c.id, empresa: c.empresa, monto: c.deuda, detalle: e.motivo }))
        }] : []);
        return { total: lista.length, casos: lista.map(({ e, c }) => ({ empresa: c.empresa, motivo: e.motivo, deuda: c.deuda })) };
      }
    }),

    proponer_envio: tool({
      description:
        'Prepara un envío de recordatorios (plantillas aprobadas) y pide CONFIRMACIÓN al administrador (no envía nada por sí mismo). ' +
        'Excluye automáticamente clientes que esperan respuesta del equipo, en revisión, con promesa activa o sin saldo.',
      inputSchema: z.object({
        grupo: z.enum(['prioridad_alta', 'vencidos', 'sin_respuesta', 'seleccion']).describe('A quién escribir'),
        clienteIds: z.array(z.string()).optional().describe('Solo si grupo = seleccion: ids de clientes obtenidos de otras herramientas'),
        tono: z.enum(['amable', 'firme', 'final']).describe('Tono de los mensajes')
      }),
      execute: async ({ grupo, clienteIds, tono: tonoPedido }, { toolCallId }) => {
        const tono = limitarTono(tonoPedido, db.perfil.politicas);
        const base =
          grupo === 'prioridad_alta' ? rs.filter((r) => r.prioridad.nivel === 'alta')
          : grupo === 'vencidos' ? rs.filter((r) => r.estado === 'vencido')
          : grupo === 'sin_respuesta' ? sinRespuesta().map((x) => x.r)
          : rs.filter((r) => clienteIds?.includes(r.id));
        const objetivo = elegibles(base).sort((a, b) => b.prioridad.score - a.prioridad.score);
        const omitidos = base.length - objetivo.length;
        guardar(toolCallId, objetivo.length ? [
          aBloqueClientes('Recibirán mensaje', objetivo, (c) => `${c.diasAtraso} días · score ${c.prioridad.score}`),
          {
            tipo: 'confirmacion',
            id: `conf_${randomUUID().slice(0, 8)}`,
            mensaje: `Voy a enviar el recordatorio ${tono} a ${objetivo.length} cliente${objetivo.length === 1 ? '' : 's'}. ¿Confirmas?`,
            clienteIds: objetivo.map((c) => c.id),
            tono,
            estado: 'pendiente'
          }
        ] : []);
        return {
          clientes: objetivo.length,
          omitidosPorEsperarRespuestaEscaladoOPromesa: omitidos,
          requiereConfirmacion: objetivo.length > 0,
          tono,
          tonoAjustadoPorPolitica: tono !== tonoPedido
        };
      }
    }),

    politicas_vigentes: tool({
      description: 'Reglas de cobranza de la empresa: horario de envíos, tono máximo y criterios de referencia para acuerdos.',
      inputSchema: z.object({}),
      execute: async () => ({
        politicas: describirParaAgente(db.perfil.politicas),
        tonoMaximo: db.perfil.politicas.tonoMaximo,
        horario: describirHorario(db.perfil.politicas),
        escalaSaldosMayoresA: db.perfil.politicas.escalar.montoMayorA,
        dondeCambiarlas: 'Ajustes → Reglas de cobranza'
      })
    })
  };
}

async function respaldo(db: Db, pregunta: string, emitir: Emitir) {
  for (const paso of planDirector(db, pregunta)) {
    if (paso.tipo === 'delegando') {
      emitir(paso);
      await espera(700);
    } else if (paso.tipo === 'texto') {
      let primero = true;
      for (const parte of paso.texto.match(/\S+\s*/g) ?? []) {
        emitir({ tipo: 'delta', texto: parte, nuevo: primero });
        primero = false;
        await espera(18);
      }
    } else {
      emitir({ tipo: 'bloque', bloque: paso.bloque });
      await espera(150);
    }
  }
}

export async function dirigir(db: Db, mensajes: MensajeDirector[], emitir: Emitir): Promise<void> {
  const pregunta = [...mensajes].reverse().find((m) => m.rol === 'usuario')?.bloques.map((b) => (b.tipo === 'texto' ? b.texto : '')).join(' ') ?? '';

  if (!iaDisponible) return respaldo(db, pregunta, emitir);
  if (!db.clientes.length) return respaldo(db, pregunta, emitir);

  const bloquesPorLlamada = new Map<string, BloqueDirector[]>();
  let ultimoFueTexto = false;
  let emitioAlgo = false;

  try {
    const resultado = streamText({
      model: modelo(),
      providerOptions: opcionesRapidas,
      abortSignal: conLimite(45_000),
      temperature: 0.3,
      stopWhen: stepCountIs(4),
      tools: crearHerramientas(db, bloquesPorLlamada),
      system: [
        `Eres el Director de cobranza de ${db.perfil.empresa}. Conversas con ${db.perfil.nombre}, el administrador. Hoy es ${hoyTexto()}.`,
        'Coordinas la automatización: el Analista prioriza la cartera por reglas y el Redactor envía recordatorios con plantillas aprobadas. Las conversaciones con los clientes las lleva una persona del equipo: cuando un cliente responde, queda en "requiere atención". Si preguntan qué hacer hoy, menciona primero a quién hay que contestar.',
        'Reglas:',
        '- SIEMPRE usa herramientas para obtener cifras o listas; nunca inventes datos.',
        '- Las herramientas ya muestran tarjetas y listas en pantalla: no repitas cada número; da una conclusión y una recomendación en 1 a 3 frases.',
        '- Para enviar o reenviar mensajes usa proponer_envio: el administrador debe confirmar en la tarjeta. Nunca digas que ya enviaste algo.',
        '- Montos en formato $12,500.00 MXN. Responde en español de México, profesional y directo.',
        '- Si te piden algo fuera de la cobranza, explica brevemente en qué puedes ayudar.'
      ].join('\n'),
      messages: historialParaModelo(mensajes)
    });

    for await (const parte of resultado.fullStream) {
      if (parte.type === 'tool-call') {
        const d = DELEGACION[parte.toolName];
        if (d) emitir({ tipo: 'delegando', agente: d.agente, texto: d.texto });
        ultimoFueTexto = false;
        emitioAlgo = true;
      } else if (parte.type === 'tool-result') {
        for (const bloque of bloquesPorLlamada.get(parte.toolCallId) ?? []) emitir({ tipo: 'bloque', bloque });
        ultimoFueTexto = false;
      } else if (parte.type === 'text-delta' && parte.text) {
        emitir({ tipo: 'delta', texto: parte.text, nuevo: !ultimoFueTexto });
        ultimoFueTexto = true;
        emitioAlgo = true;
      } else if (parte.type === 'error') {
        throw parte.error;
      }
    }
    if (!emitioAlgo) await respaldo(db, pregunta, emitir);
  } catch (error) {
    registrarErrorIA('Director', error);
    if (!emitioAlgo) await respaldo(db, pregunta, emitir);
    else emitir({ tipo: 'delta', texto: '\n\n(Se interrumpió la respuesta. Intenta de nuevo en un momento.)', nuevo: false });
  }
}
