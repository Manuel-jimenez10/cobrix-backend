/**
 * Canal de mensajería desacoplado de los agentes.
 * Los agentes deciden QUÉ decir; el canal decide POR DÓNDE sale.
 * Agregar Twilio, Telegram o email es implementar esta interfaz.
 */
import type { Tono } from '../shared/types.js';

export interface EnvioPlantilla {
  telefono: string;
  tono: Tono;
  /** Variables de la plantilla: nombre, empresa, folio, monto, dias */
  variables: Record<string, string>;
}

export interface ResultadoEnvio {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface CanalMensajeria {
  nombre: 'whatsapp' | 'simulador';
  enviarPlantilla(envio: EnvioPlantilla): Promise<ResultadoEnvio>;
  enviarTexto(telefono: string, texto: string): Promise<ResultadoEnvio>;
}

/** Modo demo: el mensaje solo se guarda y se ve en la conversación de la app. */
export const canalSimulador: CanalMensajeria = {
  nombre: 'simulador',
  enviarPlantilla: async () => ({ ok: true }),
  enviarTexto: async () => ({ ok: true })
};
