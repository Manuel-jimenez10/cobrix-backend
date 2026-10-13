import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { env, iaDisponible } from '../env.js';
import { formatFecha } from '../shared/format.js';

/**
 * Proveedor de IA. Hoy: Gemini (Google AI Studio).
 * Con el Vercel AI SDK, cambiar a OpenAI o Anthropic es reemplazar esta función.
 *
 * Protecciones de cuota (la capa gratuita se agota rápido):
 *  · REINTENTOS = 0: el SDK reintenta 2 veces por defecto, lo que triplica el gasto y tarda ~10 s.
 *  · Pausa ("disyuntor"): tras un error de cuota o saturación, no se llama a Gemini por un rato
 *    y todo responde al instante con reglas, en vez de esperar a que falle de nuevo.
 *  · Modelo de respaldo opcional (GEMINI_MODEL_RESPALDO): cada modelo tiene su propia cuota.
 */
const google = createGoogleGenerativeAI({ apiKey: env.geminiKey });

const MODELOS = [env.geminiModel, ...(env.geminiModelRespaldo ? [env.geminiModelRespaldo] : [])];
export const modelo = (i = 0) => google(MODELOS[Math.min(i, MODELOS.length - 1)]);
export { iaDisponible };

/** El SDK no reintenta: nosotros decidimos (respaldo o reglas). */
export const REINTENTOS = 0;

/**
 * Latencia: los modelos Gemini 3 "piensan" antes de responder. Para cobranza no hace falta
 * razonamiento profundo, así que bajamos el nivel de pensamiento (configurable con GEMINI_THINKING).
 */
export const opcionesRapidas = {
  google: { thinkingConfig: { thinkingLevel: env.geminiThinking } }
} as const;

/** Corta llamadas que tarden demasiado; el agente usa reglas de respaldo. */
export const conLimite = (ms: number) => AbortSignal.timeout(ms);

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
export const hoyTexto = () => {
  const d = new Date();
  return `${DIAS[d.getDay()]} ${formatFecha(d.toISOString())}`;
};

/* ───────────── Disyuntor y estadísticas ───────────── */

type Motivo = 'cuota' | 'saturado' | 'tiempo' | 'otro';

/** Pausa por modelo (índice en MODELOS). */
const pausaHasta = MODELOS.map(() => 0);

const stats = {
  desde: new Date().toISOString(),
  ok: 0,
  fallos: { cuota: 0, saturado: 0, tiempo: 0, otro: 0 } as Record<Motivo, number>,
  omitidasPorPausa: 0,
  ultimosErrores: [] as { fecha: string; agente: string; modelo: string; motivo: Motivo; mensaje: string }[]
};

export function clasificar(error: unknown): Motivo {
  const m = (error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}` : String(error)).toLowerCase();
  if (/quota|rate limit|resource_exhausted|429|too many requests/.test(m)) return 'cuota';
  if (/high demand|overloaded|unavailable|503|try again later/.test(m)) return 'saturado';
  if (/timeout|aborted/.test(m)) return 'tiempo';
  return 'otro';
}

/** Índice del primer modelo que no está en pausa, o -1 si todos lo están. */
function modeloLibre(): number {
  const ahora = Date.now();
  return pausaHasta.findIndex((t) => t <= ahora);
}

/** ¿Vale la pena llamar a la IA ahora mismo? (false = usar reglas sin esperar) */
export function iaLista(): boolean {
  if (!iaDisponible) return false;
  if (modeloLibre() === -1) {
    stats.omitidasPorPausa++;
    return false;
  }
  return true;
}

export function registrarErrorIA(agente: string, error: unknown, indiceModelo = 0) {
  const mensaje = error instanceof Error ? error.message : String(error);
  const motivo = clasificar(error);
  stats.fallos[motivo]++;
  stats.ultimosErrores.unshift({ fecha: new Date().toISOString(), agente, modelo: MODELOS[indiceModelo] ?? '?', motivo, mensaje: mensaje.slice(0, 160) });
  stats.ultimosErrores.length = Math.min(stats.ultimosErrores.length, 20);
  // Cuota agotada: 60 s sin llamar a ese modelo. Saturación: 20 s.
  if (motivo === 'cuota') pausaHasta[indiceModelo] = Date.now() + 60_000;
  if (motivo === 'saturado') pausaHasta[indiceModelo] = Date.now() + 20_000;
  console.warn(`[${agente}] IA no disponible (${motivo}, ${MODELOS[indiceModelo]}), uso reglas de respaldo: ${mensaje.slice(0, 200)}`);
}

/**
 * Ejecuta una llamada a la IA con el primer modelo libre; si falla por cuota o saturación
 * y hay modelo de respaldo, lo intenta con ese. Si todo falla, lanza el error (el agente usa reglas).
 */
export async function conIA<T>(agente: string, llamada: (indiceModelo: number) => Promise<T>): Promise<T> {
  let ultimo: unknown = new Error('IA en pausa');
  for (let intento = 0; intento < MODELOS.length; intento++) {
    const i = modeloLibre();
    if (i === -1) break;
    try {
      const r = await llamada(i);
      stats.ok++;
      return r;
    } catch (error) {
      registrarErrorIA(agente, error, i);
      ultimo = error;
      const motivo = clasificar(error);
      if (motivo !== 'cuota' && motivo !== 'saturado') break; // otro error: no tiene caso probar otro modelo
      if (pausaHasta[i] <= Date.now()) pausaHasta[i] = Date.now() + 20_000;
    }
  }
  throw ultimo;
}

/** Diagnóstico para GET /ia/estado. */
export function estadoIA() {
  const ahora = Date.now();
  const total = stats.ok + Object.values(stats.fallos).reduce((a, b) => a + b, 0);
  return {
    activa: iaDisponible,
    modelos: MODELOS.map((m, i) => ({ modelo: m, enPausaSegundos: Math.max(0, Math.round((pausaHasta[i] - ahora) / 1000)) })),
    desde: stats.desde,
    llamadas: total,
    exitosas: stats.ok,
    tasaExito: total ? Math.round((stats.ok / total) * 100) : null,
    fallos: stats.fallos,
    omitidasPorPausa: stats.omitidasPorPausa,
    ultimosErrores: stats.ultimosErrores
  };
}

/**
 * Gemini espera turnos alternados que empiecen por el usuario: une mensajes
 * consecutivos del mismo rol y antepone un turno de usuario si hace falta.
 */
export function turnosAlternados(mensajes: { role: 'user' | 'assistant'; content: string }[]) {
  const salida: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of mensajes) {
    const ultimo = salida.at(-1);
    if (ultimo && ultimo.role === m.role) ultimo.content += `\n\n${m.content}`;
    else salida.push({ ...m });
  }
  if (salida[0]?.role === 'assistant') salida.unshift({ role: 'user', content: '(Inicio de la conversación)' });
  return salida;
}
