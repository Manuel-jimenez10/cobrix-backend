const numero = new Intl.NumberFormat('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const entero = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 });
const DIA = 86_400_000;

export function formatMXN(valor: number, conMoneda = true): string {
  return `$${numero.format(valor)}${conMoneda ? ' MXN' : ''}`;
}

export function formatMXNCorto(valor: number): string {
  return `$${entero.format(Math.round(valor))}`;
}

export function partesMonto(valor: number) {
  const [e, c = '00'] = numero.format(Math.abs(valor)).split('.');
  return { entero: e, centavos: c, negativo: valor < 0 };
}

const dos = (n: number) => String(n).padStart(2, '0');

export function formatFecha(iso: string): string {
  const d = new Date(iso);
  return `${dos(d.getDate())}/${dos(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export function formatHora(iso: string): string {
  const d = new Date(iso);
  return `${dos(d.getHours())}:${dos(d.getMinutes())}`;
}

function inicioDelDia(d: Date): number {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

export function diasHasta(iso: string): number {
  return Math.round((inicioDelDia(new Date(iso)) - inicioDelDia(new Date())) / DIA);
}

export function etiquetaDia(iso: string): string {
  const d = diasHasta(iso);
  if (d === 0) return 'Hoy';
  if (d === -1) return 'Ayer';
  return formatFecha(iso);
}

export function relativoDias(iso: string): string {
  const d = diasHasta(iso);
  if (d === 0) return 'Hoy';
  if (d === 1) return 'Mañana';
  if (d === -1) return 'Ayer';
  return d > 0 ? `En ${d} días` : `Hace ${-d} días`;
}

export function tiempoRelativo(iso: string, ahora = Date.now()): string {
  const seg = Math.round((ahora - new Date(iso).getTime()) / 1000);
  if (seg < 45) return 'justo ahora';
  const min = Math.round(seg / 60);
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  if (d === 1) return 'ayer';
  if (d < 30) return `hace ${d} días`;
  return formatFecha(iso);
}

export function normalizar(texto: string): string {
  return texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function primerNombre(nombre: string): string {
  return nombre.split(' ')[0];
}

export function saludoPorHora(fecha = new Date()): string {
  const h = fecha.getHours();
  if (h < 12) return 'Buenos días';
  if (h < 19) return 'Buenas tardes';
  return 'Buenas noches';
}