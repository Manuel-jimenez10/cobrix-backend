import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { env, iaDisponible } from '../env.js';
import { formatFecha } from '../shared/format.js';

/**
 * Proveedor de IA. Hoy: Gemini (capa gratuita de Google AI Studio).
 * Con el Vercel AI SDK, cambiar a OpenAI o Anthropic es reemplazar esta función.
 */
const google = createGoogleGenerativeAI({ apiKey: env.geminiKey });

export const modelo = () => google(env.geminiModel);
export { iaDisponible };

/**
 * Latencia: los modelos Gemini 3 "piensan" antes de responder. Para cobranza no hace falta
 * razonamiento profundo, así que bajamos el nivel de pensamiento (configurable con GEMINI_THINKING).
 */
export const opcionesRapidas = {
  google: { thinkingConfig: { thinkingLevel: env.geminiThinking } }
} as const;

/** Corta llamadas que tarden demasiado (la capa gratuita a veces se atora); el agente usa reglas de respaldo. */
export const conLimite = (ms: number) => AbortSignal.timeout(ms);

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
export const hoyTexto = () => {
  const d = new Date();
  return `${DIAS[d.getDay()]} ${formatFecha(d.toISOString())}`;
};

export function registrarErrorIA(agente: string, error: unknown) {
  const mensaje = error instanceof Error ? error.message : String(error);
  console.warn(`[${agente}] IA no disponible, uso reglas de respaldo: ${mensaje.slice(0, 200)}`);
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
