/**
 * Guía: asistente de IA que enseña a usar Cobrix.
 *
 * Conoce cada pantalla y el flujo de cobranza, lee el estado real de la cuenta
 * (para dar consejos concretos: "tienes 2 clientes esperando respuesta") y
 * propone botones que llevan a la pantalla o acción exacta. No modifica datos.
 * Si la IA no está disponible, responde con una base de preguntas frecuentes.
 */
import { stepCountIs, streamText, tool } from 'ai';
import { z } from 'zod';
import type { Db } from '../domain/db.js';
import { resumenes } from '../domain/logic.js';
import { formatMXN, normalizar } from '../shared/format.js';
import type { AccionGuia, DestinoGuia, EventoGuia, MensajeGuia } from '../shared/guia-types.js';
import { describirHorario } from '../shared/politicas.js';
import { motivoParaOmitir } from '../services/cobranza.js';
import { conLimite, iaLista, modelo, opcionesRapidas, REINTENTOS, registrarErrorIA, turnosAlternados } from './modelo.js';

type Emitir = (ev: EventoGuia) => void;

export const MANUAL = `
# Qué es Cobrix
App de gestión de cobranza por WhatsApp para PyMEs mexicanas. Cobrix ordena a quién cobrar primero y prepara cada mensaje; una persona del equipo (el usuario) lo revisa y lo envía desde su propio WhatsApp con un toque (se abre WhatsApp con el chat del cliente y el texto ya escrito). La conversación y los acuerdos de pago los lleva esa persona, porque en este negocio la relación es personal. Nada se envía solo.

# Qué hace la IA (siempre la revisa una persona)
1. Redacta cada recordatorio personalizado según el tono que toca (amable, firme o aviso final), los días de atraso y el historial del cliente. Si la IA no está disponible se usa la plantilla base.
2. Sugiere 3 respuestas cuando un cliente contesta (aparecen como botones arriba del cuadro de texto; al tocar una se llena el cuadro para revisarla).
3. Detecta promesas de pago en lo que escribió el cliente ("te pago el viernes 5 mil") y muestra el aviso "prometió pagar…" con el botón "Registrar", que abre la promesa con monto y fecha ya llenos.
4. Escribe el "Resumen de hoy" en Inicio: qué hacer primero y por qué.
5. La Guía (tú) explica cómo usar la app y señala dónde presionar.

# Flujo de trabajo (en este orden)
1. Revisar el día: Inicio muestra el "Resumen de hoy", cuánto te deben, lo vencido, lo recuperado y quién va primero.
2. Contestar a quien te escribió: aparecen en "Requieren tu atención" (Inicio) y con la etiqueta "Espera respuesta" (Cartera). Sus recordatorios se pausan hasta que les contestes. Abres al cliente, con "Tú respondes" eliges una sugerencia de la IA o escribes, y presionas el botón verde: se abre tu WhatsApp con el mensaje y Cobrix lo registra en la conversación.
3. Registrar lo que te contestó: como los clientes te responden en tu WhatsApp, copias su mensaje y lo pegas en la ficha del cliente con "Respuesta del cliente" (botón del cuadro de abajo). Así queda el historial, se marca "Espera respuesta" y la IA te sugiere qué contestar.
4. Registrar la promesa: si acuerdan fecha, presionas "Registrar promesa" (o "Registrar" en el aviso de promesa detectada), eliges monto y fecha (atajos Hoy, Viernes, +7 días, +15 días) y presionas "Registrar promesa".
5. Enviar recordatorios: el botón "Iniciar cobranza" (en Inicio; en el teléfono es el botón verde flotante) ordena a los clientes vencidos y omite a quien espera tu respuesta, tiene una promesa vigente, está en revisión o no tiene saldo. Presionas "Preparar mensajes", la IA redacta cada uno y luego los revisas uno por uno: puedes editarlo, "Reescribir con IA", "Saltar" o "Enviar por WhatsApp". También puedes enviar a un solo cliente desde su ficha con "Enviar recordatorio".
6. Cobrar: en Promesas presionas "Cumplida" cuando el cliente pague lo prometido; o en la ficha del cliente "Marcar pagada" si liquidó todo. Se suma a "Recuperado este mes".

# Cómo se decide la prioridad
Score 0-100 por reglas: días de atraso (hasta 45 pts), monto respecto al mayor saldo (hasta 35), mensajes sin respuesta (hasta 15), promesas incumplidas (+8 c/u) y promesa vigente (-15). Alta ≥70, media ≥40. La razón está en la ficha del cliente (pestaña "Facturas y análisis" en el teléfono).

# Pantallas
- Inicio: "Resumen de hoy", totales, "Requieren tu atención", "A quién cobrar hoy", antigüedad de la cartera y "Actividad reciente".
- Cartera: búsqueda, filtros ("Esperan respuesta", vencidos, por vencer, con promesa, prioridad). En el teléfono puedes deslizar una tarjeta a la derecha para enviar recordatorio o a la izquierda para marcar pagada.
- Ficha del cliente: botones "Enviar recordatorio", "Registrar promesa", "Marcar pagada"; la conversación; selector "Tú respondes" / "Respuesta del cliente"; sugerencias de la IA.
- Promesas: vencidas, hoy, esta semana, más adelante y cumplidas.
- Ajustes (ícono de engrane en el teléfono): cuenta, canal (WhatsApp o Simulador), "Reglas de cobranza" (horario y tono máximo), sección "WhatsApp" (cómo se envía y "Tu WhatsApp para pruebas"), plantillas base, datos de ejemplo y "Recorrido guiado".
- Guía: en computadora el botón "¿Necesitas ayuda?" (abajo a la derecha); en el teléfono la pestaña "Guía".

# WhatsApp
- Hoy no hay que conectar nada: los mensajes salen del WhatsApp de la persona (app de WhatsApp o WhatsApp Business en el teléfono, WhatsApp Web o de escritorio en la computadora). El cliente recibe el mensaje del número que ya conoce. Sin costo.
- "Tu WhatsApp para pruebas" (Ajustes → WhatsApp): los clientes de ejemplo tienen números ficticios; si guardas tu número ahí, WhatsApp se abre con tu chat en lugar del del cliente para que veas lo que recibirían. Para cobrar a clientes reales se deja vacío.
- Canal "Simulador": no se abre WhatsApp, los envíos solo se registran en Cobrix.
- Próximamente: envío automático con la API oficial de WhatsApp (Meta). La app se envió a revisión de Meta el 12 de octubre de 2026; cuando la aprueben, en Ajustes se podrá conectar el número de la empresa con un código por SMS y Cobrix enviará los recordatorios solo y recibirá las respuestas en tiempo real. Todavía no está disponible.

# Datos de ejemplo
Cada cuenta tiene su propia cartera de ejemplo; se vacía o recarga en Ajustes. Nada se envía a clientes reales.
`.trim();

const DESTINOS = ['inicio', 'cartera', 'cliente', 'atencion', 'promesas', 'ajustes', 'reglas', 'whatsapp', 'recorrido', 'iniciar_cobranza', 'registrar_promesa', 'guia'] as const satisfies readonly DestinoGuia[];

function estadoCuenta(db: Db) {
  const rs = resumenes(db);
  const conSaldo = rs.filter((r) => r.deuda > 0);
  const atencion = rs.filter((r) => r.requiereAtencion);
  const listos = conSaldo.filter((r) => !motivoParaOmitir(db, r));
  return {
    empresa: db.perfil.empresa,
    esDemoAnonima: db.perfil.esAnonimo,
    clientes: rs.length,
    clientesConSaldo: conSaldo.length,
    porCobrar: formatMXN(conSaldo.reduce((s, r) => s + r.deuda, 0)),
    vencido: formatMXN(rs.filter((r) => r.estado === 'vencido').reduce((s, r) => s + r.deuda, 0)),
    clientesVencidos: rs.filter((r) => r.estado === 'vencido').length,
    prioridadAlta: conSaldo
      .filter((r) => r.prioridad.nivel === 'alta')
      .sort((a, b) => b.prioridad.score - a.prioridad.score)
      .slice(0, 3)
      .map((r) => ({ id: r.id, empresa: r.empresa, deuda: formatMXN(r.deuda), diasAtraso: r.diasAtraso, razon: r.prioridad.razon })),
    requierenAtencion: atencion.slice(0, 5).map((r) => ({ id: r.id, empresa: r.empresa })),
    totalRequierenAtencion: atencion.length,
    listosParaRecordatorio: listos.length,
    promesasPendientes: db.promesas.filter((p) => p.estado === 'pendiente').length,
    montoPromesas: formatMXN(db.promesas.filter((p) => p.estado === 'pendiente').reduce((s, p) => s + p.monto, 0)),
    recordatoriosEnviados: db.mensajes.filter((m) => m.agente === 'redactor').length,
    canal: db.perfil.canal,
    envio: db.perfil.canal === 'simulador' ? 'simulador (no se abre WhatsApp)' : 'desde el WhatsApp del usuario (enlace con el mensaje listo)',
    apiOficialMeta: 'próximamente (en revisión de Meta desde el 12 de octubre de 2026)',
    telefonoDePruebas: db.perfil.telefonoPrueba ?? null,
    horarioDeEnvios: describirHorario(db.perfil.politicas),
    tonoMaximo: db.perfil.politicas.tonoMaximo
  };
}

/* ───────────── Respaldo sin IA: preguntas frecuentes ───────────── */

interface Faq {
  patron: RegExp;
  respuesta: (db: Db) => string;
  acciones: (db: Db) => AccionGuia[];
}

const FAQS: Faq[] = [
  {
    patron: /(respond|contest|atencion|me escribio|escribieron|negoci)/,
    respuesta: (db) => {
      const n = resumenes(db).filter((r) => r.requiereAtencion).length;
      return (
        'Cuando un cliente contesta, su conversación queda marcada como "Requiere atención" y se pausan sus recordatorios. ' +
        'Abre al cliente: con "Tú respondes" la IA te sugiere respuestas; elige una, revísala y presiona el botón verde para enviarla desde tu WhatsApp. Si acuerdan una fecha, usa "Registrar promesa". Cuando te conteste en WhatsApp, pega su mensaje con "Respuesta del cliente".' +
        (n ? ` Ahora mismo tienes ${n} cliente${n === 1 ? '' : 's'} esperando tu respuesta.` : '')
      );
    },
    acciones: () => [{ destino: 'atencion', etiqueta: 'Ver quién espera respuesta' }]
  },
  {
    patron: /(promesa|compromet|acuerdo|fecha de pago)/,
    respuesta: () =>
      'Las promesas las registras tú: abre al cliente → "Registrar promesa", pon monto y fecha. Aparecen en Promesas y, cuando pague, toca "Marcar cumplida". Mientras la promesa esté vigente no se le envían recordatorios.',
    acciones: (db) => {
      const c = resumenes(db).find((r) => r.requiereAtencion) ?? resumenes(db).filter((r) => r.deuda > 0).sort((a, b) => b.prioridad.score - a.prioridad.score)[0];
      return c ? [{ destino: 'registrar_promesa', etiqueta: `Registrar promesa de ${c.empresa}`.slice(0, 40), clienteId: c.id }] : [{ destino: 'promesas', etiqueta: 'Ir a Promesas' }];
    }
  },
  {
    patron: /(recordatorio|enviar|mandar|cobrar|cobranza|plantilla)/,
    respuesta: () =>
      'Toca "Iniciar cobranza": Cobrix ordena a los clientes por prioridad y prepara el mensaje de cada uno con el tono que le toca (amable, firme o final). Luego los revisas uno por uno y presionas "Enviar por WhatsApp": se abre tu WhatsApp con el chat y el texto listos. Se omite a quien espera tu respuesta o ya prometió pagar.',
    acciones: () => [{ destino: 'iniciar_cobranza', etiqueta: 'Iniciar cobranza' }]
  },
  {
    patron: /(prioridad|score|primero|orden|analista)/,
    respuesta: () =>
      'Cobrix calcula un score de 0 a 100 con reglas: días de atraso, monto, mensajes sin respuesta y promesas incumplidas (una promesa vigente lo baja). Puedes ver la razón de cada cliente en su pestaña "Facturas y análisis".',
    acciones: () => [{ destino: 'cartera', etiqueta: 'Ver cartera' }]
  },
  {
    patron: /(whatsapp|meta|numero|telefono|24 ?h|ventana)/,
    respuesta: (db) =>
      'Los mensajes salen desde tu propio WhatsApp: Cobrix lo abre con el chat del cliente y el texto listo, y tú solo presionas enviar. No hay nada que conectar. ' +
      (db.perfil.telefonoPrueba
        ? `Ahora tienes ${db.perfil.telefonoPrueba} como número de pruebas: WhatsApp se abre con ese chat en lugar del del cliente.`
        : 'Para probar con los clientes de ejemplo (sus números son ficticios), pon tu número en Ajustes → "Tu WhatsApp para pruebas".') +
      ' El envío automático con la API oficial de Meta llega pronto: la app está en revisión desde el 12 de octubre de 2026.' +
      (db.perfil.canal === 'simulador' ? ' Ahora estás en modo Simulador: no se abre WhatsApp.' : ''),
    acciones: () => [{ destino: 'whatsapp', etiqueta: 'Abrir ajustes de WhatsApp' }]
  },
  {
    patron: /(\bia\b|inteligencia|sugerencia|redact|resumen del dia|asistente)/,
    respuesta: () =>
      'La IA te ayuda en cuatro cosas: redacta cada recordatorio según el tono, el atraso y el historial; cuando un cliente responde, te sugiere 3 respuestas; detecta si prometió pagar y te deja la promesa lista; y en Inicio te da el resumen del día. Tú siempre revisas y envías: nada sale solo.',
    acciones: (db) => {
      const c = resumenes(db).find((r) => r.requiereAtencion);
      return c ? [{ destino: 'cliente', etiqueta: `Ver sugerencias para ${c.empresa}`.slice(0, 40), clienteId: c.id }] : [{ destino: 'iniciar_cobranza', etiqueta: 'Iniciar cobranza' }];
    }
  },
  {
    patron: /(horario|tono|regla|politica|ajuste|configur)/,
    respuesta: (db) =>
      `En Ajustes → Reglas de cobranza defines en qué días y horas se pueden enviar recordatorios (hoy: ${describirHorario(db.perfil.politicas)}) y el tono más fuerte permitido (hoy: ${db.perfil.politicas.tonoMaximo}).`,
    acciones: () => [{ destino: 'reglas', etiqueta: 'Abrir reglas de cobranza' }]
  },
  {
    patron: /(cuanto|debe|vencid|cartera|resumen|reporte)/,
    respuesta: (db) => {
      const e = estadoCuenta(db);
      return `Tienes ${e.porCobrar} por cobrar en ${e.clientesConSaldo} clientes; ${e.vencido} ya está vencido. Hay ${e.promesasPendientes} promesas activas por ${e.montoPromesas}.` +
        (e.prioridadAlta[0] ? ` Lo más urgente es ${e.prioridadAlta[0].empresa} (${e.prioridadAlta[0].deuda}).` : '');
    },
    acciones: () => [{ destino: 'cartera', etiqueta: 'Ver cartera' }]
  },
  {
    patron: /(pag|liquid)/,
    respuesta: () =>
      'Si el cliente liquidó todo, abre su ficha y toca "Marcar pagada". Si pagó una promesa, ve a Promesas y toca "Marcar cumplida". El monto se suma a "Recuperado este mes".',
    acciones: () => [{ destino: 'promesas', etiqueta: 'Ir a Promesas' }]
  },
  {
    patron: /(empez|inicio|como funciona|que hago|ayuda|tutorial|recorrido|guia)/,
    respuesta: () =>
      'El flujo es: 1) revisa el resumen de hoy, 2) contesta a quien te escribió (la IA te sugiere qué decir), 3) registra la promesa de pago, 4) envía recordatorios desde tu WhatsApp y 5) marca como cumplida la promesa cuando te paguen. El recorrido guiado te ilumina cada botón paso a paso.',
    acciones: () => [{ destino: 'recorrido', etiqueta: 'Iniciar recorrido guiado' }]
  }
];

async function respaldo(db: Db, pregunta: string, emitir: Emitir) {
  const q = normalizar(pregunta);
  const faq = FAQS.find((f) => f.patron.test(q));
  const texto = faq
    ? faq.respuesta(db)
    : 'Puedo explicarte cómo enviar recordatorios desde tu WhatsApp, cómo atender a un cliente que respondió, qué hace la IA, cómo registrar promesas o cómo se calcula la prioridad. ¿Qué te gustaría hacer?';
  for (const parte of texto.match(/\S+\s*/g) ?? []) {
    emitir({ tipo: 'delta', texto: parte });
    await new Promise((r) => setTimeout(r, 14));
  }
  for (const accion of faq ? faq.acciones(db) : [{ destino: 'recorrido' as const, etiqueta: 'Iniciar recorrido guiado' }]) emitir({ tipo: 'accion', accion });
}

const NOMBRE_PANTALLA: Record<string, string> = {
  '/': 'Inicio',
  '/cartera': 'Cartera',
  '/promesas': 'Promesas',
  '/ajustes': 'Ajustes'
};

export async function guiar(db: Db, mensajes: MensajeGuia[], pantalla: string, emitir: Emitir): Promise<void> {
  const pregunta = [...mensajes].reverse().find((m) => m.rol === 'usuario')?.texto ?? '';
  if (!iaLista()) return respaldo(db, pregunta, emitir);

  const ruta = pantalla.startsWith('/cartera/') ? 'la ficha de un cliente' : NOMBRE_PANTALLA[pantalla] ?? pantalla;
  let acciones = 0;
  let emitioTexto = false;

  try {
    const resultado = streamText({
      model: modelo(),
      maxRetries: REINTENTOS,
      providerOptions: opcionesRapidas,
      abortSignal: conLimite(30_000),
      temperature: 0.4,
      stopWhen: stepCountIs(3),
      tools: {
        estado_de_mi_cuenta: tool({
          description: 'Estado actual de la cuenta del usuario: clientes, quién espera respuesta, promesas, canal y configuración. Úsalo para dar consejos concretos.',
          inputSchema: z.object({}),
          execute: async () => estadoCuenta(db)
        }),
        mostrar_boton: tool({
          description:
            'Muestra un botón debajo de tu respuesta. Al presionarlo, la app lleva al usuario a la pantalla y le ILUMINA el botón exacto que debe presionar. ' +
            'Úsalo siempre que el siguiente paso sea una acción en la app (máximo 2 por respuesta). Destinos: ' +
            'inicio; cartera; cliente (ilumina el cuadro para responder; requiere clienteId); atencion (ilumina al primer cliente que espera respuesta); ' +
            'registrar_promesa (ilumina el botón "Registrar promesa"; requiere clienteId); promesas (ilumina "Marcar cumplida"); iniciar_cobranza (ilumina "Iniciar cobranza"); ' +
            'reglas (reglas de cobranza); whatsapp (cómo se envía y teléfono de pruebas); ajustes; recorrido (recorrido guiado paso a paso).',
          inputSchema: z.object({
            destino: z.enum(DESTINOS),
            etiqueta: z.string().max(40).describe('Texto corto del botón, p. ej. "Ir a Promesas"'),
            clienteId: z.string().optional()
          }),
          execute: async ({ destino, etiqueta, clienteId }) => {
            if (acciones >= 2) return { mostrado: false, motivo: 'Máximo 2 botones por respuesta' };
            if ((destino === 'cliente' || destino === 'registrar_promesa') && !db.clientes.some((c) => c.id === clienteId)) return { mostrado: false, motivo: 'clienteId inválido' };
            acciones++;
            emitir({ tipo: 'accion', accion: { destino, etiqueta, ...(clienteId && (destino === 'cliente' || destino === 'registrar_promesa') ? { clienteId } : {}) } });
            return { mostrado: true };
          }
        })
      },
      system: [
        `Eres la Guía de Cobrix: enseñas a ${db.perfil.nombre} (${db.perfil.empresa}) a usar la app. Ahora está en: ${ruta}.`,
        'Responde SOLO con base en este manual; si algo no está en el manual, dilo y sugiere lo más cercano. No inventes botones ni pantallas.',
        MANUAL,
        'Estilo: español de México, cálido y claro, máximo 4 frases o una lista corta de pasos numerados. Usa los nombres exactos de los botones entre comillas.',
        'Si la pregunta depende de su cuenta (cuánto me deben, qué hago ahora, quién me respondió, a quién cobro primero), consulta estado_de_mi_cuenta primero y responde con esas cifras exactas; nunca inventes datos.',
        'Cuando expliques cómo hacer algo, termina con el botón (mostrar_boton) que le ilumina dónde presionar. No le pidas datos personales. Si preguntan algo ajeno a Cobrix, redirige con amabilidad.'
      ].join('\n\n'),
      messages: turnosAlternados(
        mensajes.slice(-10).map((m) => ({ role: m.rol === 'usuario' ? ('user' as const) : ('assistant' as const), content: m.texto || '(vacío)' }))
      )
    });

    for await (const parte of resultado.fullStream) {
      if (parte.type === 'text-delta' && parte.text) {
        emitir({ tipo: 'delta', texto: parte.text });
        emitioTexto = true;
      } else if (parte.type === 'error') {
        throw parte.error;
      }
    }
    if (!emitioTexto) await respaldo(db, pregunta, emitir);
  } catch (error) {
    registrarErrorIA('Guía', error);
    if (!emitioTexto) await respaldo(db, pregunta, emitir);
    else emitir({ tipo: 'delta', texto: '\n\n(Se interrumpió la respuesta. Intenta de nuevo.)' });
  }
}
