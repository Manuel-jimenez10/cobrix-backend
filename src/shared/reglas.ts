import type { Mensaje, PromesaPago, Tono } from './types.js';
import { diasHasta } from './format.js';

export function estadoVentana(mensajes: Mensaje[]): {abierta: boolean;horasRestantes: number;} {
  const ultimo = [...mensajes].reverse().find((m) => m.rol === 'cliente');
  if (!ultimo) return { abierta: false, horasRestantes: 0 };
  const horas = (Date.now() - new Date(ultimo.fecha).getTime()) / 3_600_000;
  return horas < 24 ?
  { abierta: true, horasRestantes: Math.max(1, Math.ceil(24 - horas)) } :
  { abierta: false, horasRestantes: 0 };
}

export function siguienteTono(mensajes: Mensaje[]): Tono {
  const intentos = mensajes.filter((m) => m.rol === 'agente' && m.agente === 'redactor').length;
  if (intentos === 0) return 'amable';
  if (intentos === 1) return 'firme';
  return 'final';
}

export function llenarPlantilla(contenido: string, variables: Record<string, string>): string {
  return contenido.replace(/\{\{(\w+)\}\}/g, (_, clave: string) => variables[clave] ?? `{{${clave}}}`);
}

export type GrupoPromesa = 'vencidas' | 'hoy' | 'semana' | 'proximas' | 'cumplidas';

export const GRUPOS_PROMESA: {clave: GrupoPromesa;titulo: string;}[] = [
{ clave: 'vencidas', titulo: 'Vencidas' },
{ clave: 'hoy', titulo: 'Hoy' },
{ clave: 'semana', titulo: 'Esta semana' },
{ clave: 'proximas', titulo: 'Más adelante' },
{ clave: 'cumplidas', titulo: 'Cumplidas' }];


export function grupoDePromesa(p: PromesaPago): GrupoPromesa {
  if (p.estado === 'cumplida') return 'cumplidas';
  const d = diasHasta(p.fechaCompromiso);
  if (p.estado === 'incumplida' || d < 0) return 'vencidas';
  if (d === 0) return 'hoy';
  if (d <= 7) return 'semana';
  return 'proximas';
}