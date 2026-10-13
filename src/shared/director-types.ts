import type { AgenteId, PuntoSerie, Tono } from './types.js';

export type BloqueDirector =
{tipo: 'texto';texto: string;} |
{
  tipo: 'kpi';
  etiqueta: string;
  valor: number;
  variacion: number;
  detalle: string;
  mejorSi: 'sube' | 'baja';
} |
{tipo: 'grafica';titulo: string;total: number;puntos: PuntoSerie[];} |
{
  tipo: 'clientes';
  titulo: string;
  clientes: {id: string;empresa: string;monto: number;detalle: string;}[];
} |
{
  tipo: 'confirmacion';
  id: string;
  mensaje: string;
  clienteIds: string[];
  tono: Tono;
  estado: 'pendiente' | 'confirmada' | 'cancelada';
};

export interface MensajeDirector {
  id: string;
  rol: 'usuario' | 'director';
  bloques: BloqueDirector[];
  fecha: string;
  delegaciones?: AgenteId[];
}

export interface ConversacionDirector {
  id: string;
  titulo: string;
  fecha: string;
  mensajes: MensajeDirector[];
}

export type EventoDirector =
{tipo: 'delegando';agente: AgenteId;texto: string;} |
{tipo: 'delta';texto: string;nuevo: boolean;} |
{tipo: 'bloque';bloque: BloqueDirector;} |
{tipo: 'fin';};