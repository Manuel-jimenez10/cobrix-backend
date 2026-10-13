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
import { whatsappConfigurado } from '../env.js';
import { conLimite, iaDisponible, modelo, opcionesRapidas, registrarErrorIA, turnosAlternados } from './modelo.js';

type Emitir = (ev: EventoGuia) => void;

export const MANUAL = `
# Qué es Cobrix
App de cobranza por WhatsApp para PyMEs mexicanas. Automatiza lo repetitivo (decidir a quién cobrar y mandar recordatorios con plantillas aprobadas por Meta) y deja la conversación con el cliente en manos de una persona del equipo, porque en este negocio la relación es personal.

# Quién hace qué
- Analista (automático, por reglas): ordena la cartera. Score 0-100: días de atraso (hasta 45 pts), monto respecto al mayor saldo (hasta 35), mensajes sin respuesta (hasta 15), promesas incumplidas (+8 c/u) y promesa vigente (-15). Alta ≥70, media ≥40. La razón se ve en el cliente → pestaña "Facturas y análisis".
- Redactor (automático, plantillas): manda el recordatorio con la plantilla que toca según los intentos previos: amable → firme → final. Nunca supera el "tono máximo" de Ajustes. Las plantillas se pueden enviar siempre, incluso fuera de la ventana de 24 h.
- Tú y tu equipo: cuando un cliente responde, su conversación queda marcada "Requiere atención", se pausan sus recordatorios y te llega el aviso. Contestas desde la conversación del cliente (o desde tu WhatsApp) y, si acuerdan fecha, registras la promesa.
- Director (IA): chat para preguntar por tu cartera con datos reales ("¿cuánto falta por cobrar?", "¿quién no ha respondido?"). Puede preparar un envío de recordatorios, pero siempre pide tu confirmación.
- Guía (yo, IA): explico cómo usar la app y te llevo a la pantalla correcta.

# Pantallas
- Inicio: totales (por cobrar, vencido, recuperado del mes, promesas activas), "Requieren tu atención", "A quién cobrar hoy", antigüedad de la cartera y actividad en vivo. Botón "Iniciar cobranza".
- Cartera: lista de clientes con búsqueda y filtros (estado, prioridad y "Requieren atención"). Puedes seleccionar varios y enviarles recordatorio. Al abrir un cliente:
  · Botones "Enviar recordatorio", "Registrar promesa" y "Marcar pagada".
  · Pestaña "Conversación": historial; el indicador muestra si la ventana de 24 h está abierta. Abajo escribes como "Tú (equipo)". En modo simulador hay un modo "Simular cliente" con respuestas rápidas para probar.
  · Pestaña "Facturas y análisis": facturas, promesas y la razón de prioridad del Analista.
- Director: chat con tarjetas, gráficas y listas. Las sugerencias de envío requieren confirmar.
- Promesas: agrupadas en vencidas, hoy, esta semana, más adelante y cumplidas. "Marcar cumplida" registra el pago.
- Ajustes: cuenta; "Reglas de cobranza" (horario permitido para enviar recordatorios y tono máximo); canal (Simulador o WhatsApp); "Tu WhatsApp para pruebas"; plantillas; cargar o vaciar datos de ejemplo; reiniciar el recorrido guiado.
- Atajos en computadora: Ctrl/⌘+K buscar, Ctrl/⌘+J abrir el Director. En el teléfono, la barra inferior tiene Inicio, Cartera, Director y Promesas; Ajustes está en el ícono de engrane.

# Al enviar recordatorios se omite automáticamente a quien:
te escribió y espera tu respuesta, tiene una promesa de pago vigente, está en revisión del equipo o no tiene saldo. Fuera del horario configurado no se envía nada.

# WhatsApp
- Meta solo permite texto libre dentro de las 24 h posteriores al último mensaje del cliente; fuera de esa ventana solo plantillas aprobadas. Por eso los recordatorios son plantillas y tus respuestas manuales solo salen con la ventana abierta.
- Modo demo: con el número de prueba de Meta, todos los mensajes se redirigen al número que pongas en Ajustes → "Tu WhatsApp para pruebas"; lo que respondas desde tu teléfono llega a la conversación del cliente.
- Sin WhatsApp configurado se usa el Simulador: nada sale de la app y tú puedes responder como si fueras el cliente.

# Datos de ejemplo
Cada cuenta (y cada visitante de la demo) tiene su propia cartera de ejemplo; se puede vaciar o volver a cargar en Ajustes. Nada se envía a clientes reales.
`.trim();

const DESTINOS = ['inicio', 'cartera', 'cliente', 'atencion', 'director', 'promesas', 'ajustes', 'reglas', 'whatsapp', 'recorrido', 'iniciar_cobranza'] as const satisfies readonly DestinoGuia[];

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
    requierenAtencion: atencion.slice(0, 5).map((r) => ({ id: r.id, empresa: r.empresa })),
    totalRequierenAtencion: atencion.length,
    listosParaRecordatorio: listos.length,
    promesasPendientes: db.promesas.filter((p) => p.estado === 'pendiente').length,
    recordatoriosEnviados: db.mensajes.filter((m) => m.agente === 'redactor').length,
    canal: db.perfil.canal,
    whatsappConfiguradoEnServidor: whatsappConfigurado,
    tieneTelefonoDePrueba: Boolean(db.perfil.telefonoPrueba),
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
        'Abre al cliente, escríbele desde el cuadro de abajo (modo "Tú (equipo)") y, si acuerdan una fecha, usa "Registrar promesa".' +
        (n ? ` Ahora mismo tienes ${n} cliente${n === 1 ? '' : 's'} esperando tu respuesta.` : '')
      );
    },
    acciones: () => [{ destino: 'atencion', etiqueta: 'Ver quién espera respuesta' }]
  },
  {
    patron: /(promesa|compromet|acuerdo|fecha de pago)/,
    respuesta: () =>
      'Las promesas las registras tú: abre al cliente → "Registrar promesa", pon monto y fecha. Aparecen en Promesas y, cuando pague, toca "Marcar cumplida". Mientras la promesa esté vigente no se le envían recordatorios.',
    acciones: () => [{ destino: 'promesas', etiqueta: 'Ir a Promesas' }]
  },
  {
    patron: /(recordatorio|enviar|mandar|cobrar|cobranza|plantilla)/,
    respuesta: () =>
      'Toca "Iniciar cobranza": el Analista ordena a los clientes y el Redactor les manda la plantilla que toca (amable, firme o final). Se omite a quien espera tu respuesta o ya prometió pagar. También puedes enviar a un solo cliente desde su ficha con "Enviar recordatorio".',
    acciones: () => [{ destino: 'iniciar_cobranza', etiqueta: 'Iniciar cobranza' }]
  },
  {
    patron: /(prioridad|score|primero|orden|analista)/,
    respuesta: () =>
      'El Analista calcula un score de 0 a 100 con reglas: días de atraso, monto, mensajes sin respuesta y promesas incumplidas (una promesa vigente lo baja). Puedes ver la razón de cada cliente en su pestaña "Facturas y análisis".',
    acciones: () => [{ destino: 'cartera', etiqueta: 'Ver cartera' }]
  },
  {
    patron: /(whatsapp|meta|numero|telefono|24 ?h|ventana)/,
    respuesta: (db) =>
      'Meta solo permite texto libre durante 24 h después del último mensaje del cliente; fuera de esa ventana solo plantillas aprobadas. ' +
      (whatsappConfigurado
        ? 'Para probarlo, en Ajustes activa el canal WhatsApp y escribe tu número en "Tu WhatsApp para pruebas": los mensajes te llegarán a ti.'
        : 'Este servidor aún no tiene WhatsApp configurado, así que se usa el Simulador.') +
      (db.perfil.canal === 'simulador' ? ' Ahora estás en modo Simulador.' : ''),
    acciones: () => [{ destino: 'whatsapp', etiqueta: 'Configurar WhatsApp' }]
  },
  {
    patron: /(horario|tono|regla|politica|ajuste|configur)/,
    respuesta: (db) =>
      `En Ajustes → Reglas de cobranza defines en qué días y horas se pueden enviar recordatorios (hoy: ${describirHorario(db.perfil.politicas)}) y el tono más fuerte permitido (hoy: ${db.perfil.politicas.tonoMaximo}).`,
    acciones: () => [{ destino: 'reglas', etiqueta: 'Abrir reglas de cobranza' }]
  },
  {
    patron: /(director|pregunt|reporte|cuanto)/,
    respuesta: () =>
      'El Director es el asistente de IA para tu cartera: pregúntale "¿cuánto falta por cobrar?" o "¿quién no ha respondido?" y te contesta con tarjetas y datos reales. Si te sugiere un envío, tú lo confirmas.',
    acciones: () => [{ destino: 'director', etiqueta: 'Hablar con el Director' }]
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
      'Te sugiero este orden: 1) revisa la cartera y quién va primero, 2) inicia una cobranza, 3) en un cliente, simula su respuesta y contéstale como equipo, 4) registra la promesa. El recorrido guiado te lleva paso a paso.',
    acciones: () => [
      { destino: 'recorrido', etiqueta: 'Iniciar recorrido guiado' },
      { destino: 'cartera', etiqueta: 'Ver cartera' }
    ]
  }
];

async function respaldo(db: Db, pregunta: string, emitir: Emitir) {
  const q = normalizar(pregunta);
  const faq = FAQS.find((f) => f.patron.test(q));
  const texto = faq
    ? faq.respuesta(db)
    : 'Puedo explicarte cómo enviar recordatorios, cómo atender a un cliente que respondió, cómo registrar promesas, cómo se calcula la prioridad o cómo conectar WhatsApp. ¿Qué te gustaría hacer?';
  for (const parte of texto.match(/\S+\s*/g) ?? []) {
    emitir({ tipo: 'delta', texto: parte });
    await new Promise((r) => setTimeout(r, 14));
  }
  for (const accion of faq ? faq.acciones(db) : [{ destino: 'recorrido' as const, etiqueta: 'Iniciar recorrido guiado' }]) emitir({ tipo: 'accion', accion });
}

const NOMBRE_PANTALLA: Record<string, string> = {
  '/': 'Inicio',
  '/cartera': 'Cartera',
  '/director': 'Director',
  '/promesas': 'Promesas',
  '/ajustes': 'Ajustes'
};

export async function guiar(db: Db, mensajes: MensajeGuia[], pantalla: string, emitir: Emitir): Promise<void> {
  const pregunta = [...mensajes].reverse().find((m) => m.rol === 'usuario')?.texto ?? '';
  if (!iaDisponible) return respaldo(db, pregunta, emitir);

  const ruta = pantalla.startsWith('/cartera/') ? 'la ficha de un cliente' : NOMBRE_PANTALLA[pantalla] ?? pantalla;
  let acciones = 0;
  let emitioTexto = false;

  try {
    const resultado = streamText({
      model: modelo(),
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
            'Muestra un botón debajo de tu respuesta que lleva al usuario a una pantalla o acción. Úsalo cuando expliques algo que se hace en otra pantalla (máximo 2 por respuesta). ' +
            'Destinos: inicio, cartera, cliente (requiere clienteId de estado_de_mi_cuenta), atencion (clientes que esperan respuesta), director, promesas, ajustes, reglas (reglas de cobranza), whatsapp (canal y teléfono de pruebas), recorrido (tutorial paso a paso), iniciar_cobranza.',
          inputSchema: z.object({
            destino: z.enum(DESTINOS),
            etiqueta: z.string().max(40).describe('Texto corto del botón, p. ej. "Ir a Promesas"'),
            clienteId: z.string().optional()
          }),
          execute: async ({ destino, etiqueta, clienteId }) => {
            if (acciones >= 2) return { mostrado: false, motivo: 'Máximo 2 botones por respuesta' };
            if (destino === 'cliente' && !db.clientes.some((c) => c.id === clienteId)) return { mostrado: false, motivo: 'clienteId inválido' };
            acciones++;
            emitir({ tipo: 'accion', accion: { destino, etiqueta, ...(destino === 'cliente' ? { clienteId } : {}) } });
            return { mostrado: true };
          }
        })
      },
      system: [
        `Eres la Guía de Cobrix: enseñas a ${db.perfil.nombre} (${db.perfil.empresa}) a usar la app. Ahora está en: ${ruta}.`,
        'Responde SOLO con base en este manual; si algo no está en el manual, dilo y sugiere lo más cercano. No inventes botones ni pantallas.',
        MANUAL,
        'Estilo: español de México, cálido y claro, máximo 4 frases o una lista corta de pasos numerados. Usa los nombres exactos de los botones entre comillas.',
        'Si la pregunta depende de su cuenta (qué hago ahora, quién me respondió, por qué no se envió), consulta estado_de_mi_cuenta primero.',
        'Cuando el siguiente paso esté en otra pantalla, ofrece un botón con mostrar_boton. No le pidas datos personales. Si preguntan algo ajeno a Cobrix, redirige con amabilidad.'
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
