/** Tipos compartidos del agente Guía (asistente que enseña a usar Cobrix). */

export type DestinoGuia =
  | 'inicio'
  | 'cartera'
  | 'cliente'
  | 'atencion'
  | 'promesas'
  | 'ajustes'
  | 'reglas'
  | 'whatsapp'
  | 'recorrido'
  | 'iniciar_cobranza'
  | 'registrar_promesa'
  | 'guia';

export interface AccionGuia {
  destino: DestinoGuia;
  etiqueta: string;
  /** Para destino = cliente o registrar_promesa. */
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
