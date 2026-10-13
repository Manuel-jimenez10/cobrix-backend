/** Tipos compartidos del agente Guía (asistente que enseña a usar Cobrix). */

export type DestinoGuia =
  | 'inicio'
  | 'cartera'
  | 'cliente'
  | 'atencion'
  | 'director'
  | 'promesas'
  | 'ajustes'
  | 'reglas'
  | 'whatsapp'
  | 'recorrido'
  | 'iniciar_cobranza';

export interface AccionGuia {
  destino: DestinoGuia;
  etiqueta: string;
  /** Solo para destino = cliente. */
  clienteId?: string;
}

export interface MensajeGuia {
  rol: 'usuario' | 'guia';
  texto: string;
}

export type EventoGuia =
  | { tipo: 'delta'; texto: string }
  | { tipo: 'accion'; accion: AccionGuia }
  | { tipo: 'fin' };
