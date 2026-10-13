export type Canal = 'whatsapp' | 'simulador';
export type AgenteId = 'director' | 'analista' | 'redactor' | 'negociador';
export type Tono = 'amable' | 'firme' | 'final';
export type EstadoFactura = 'pendiente' | 'vencida' | 'pagada' | 'promesa';
export type NivelPrioridad = 'alta' | 'media' | 'baja';
export type EstadoCliente = 'al_dia' | 'por_vencer' | 'vencido' | 'promesa';
export type EstadoEvento = 'en_progreso' | 'completado' | 'error';
export type EstadoPromesa = 'pendiente' | 'cumplida' | 'incumplida';
export type OrdenClientes = 'prioridad' | 'monto' | 'atraso' | 'nombre';

export interface Cliente {
  id: string;
  nombre: string;
  empresa: string;
  telefono: string;
  email: string;
  canal: Canal;
}

export interface Factura {
  id: string;
  clienteId: string;
  folio: string;
  monto: number;
  fechaEmision: string;
  fechaVencimiento: string;
  estado: EstadoFactura;
  diasAtraso: number;
}

export interface Prioridad {
  clienteId: string;
  score: number;
  nivel: NivelPrioridad;
  razon: string;
}

export interface Mensaje {
  id: string;
  clienteId: string;
  rol: 'agente' | 'cliente';
  agente: AgenteId | null;
  contenido: string;
  tono: Tono | null;
  esPlantilla: boolean;
  fecha: string;
}

export interface EventoAgente {
  id: string;
  clienteId: string | null;
  agente: AgenteId;
  accion: string;
  detalle: string;
  estado: EstadoEvento;
  fecha: string;
}

export interface PromesaPago {
  id: string;
  clienteId: string;
  facturaId: string;
  monto: number;
  fechaCompromiso: string;
  estado: EstadoPromesa;
}

export interface Escalamiento {
  id: string;
  clienteId: string;
  motivo: string;
  fecha: string;
  resuelto: boolean;
}

export interface ClienteResumen extends Cliente {
  deuda: number;
  diasAtraso: number;
  estado: EstadoCliente;
  prioridad: Prioridad;
  facturasAbiertas: number;
  ultimoMensaje: Mensaje | null;
  escalado: boolean;
}

export interface ClienteDetalle {
  cliente: ClienteResumen;
  facturas: Factura[];
  mensajes: Mensaje[];
  promesas: PromesaPago[];
  escalamientos: Escalamiento[];
}

export interface FiltrosClientes {
  busqueda?: string;
  estado?: EstadoCliente | 'todos';
  prioridad?: NivelPrioridad | 'todas';
  orden?: OrdenClientes;
}

export interface TramoAntiguedad {
  rango: string;
  monto: number;
  clientes: number;
}

export interface PuntoSerie {
  etiqueta: string;
  valor: number;
}

export interface Dashboard {
  porCobrar: number;
  facturasAbiertas: number;
  vencido: number;
  clientesVencidos: number;
  recuperadoMes: number;
  recuperadoVariacion: number;
  promesasActivas: number;
  montoPromesas: number;
  antiguedad: TramoAntiguedad[];
  tareasHoy: Record<AgenteId, number>;
  recuperacionSemanal: PuntoSerie[];
}

export interface PromesaConCliente extends PromesaPago {
  cliente: Cliente;
  folio: string;
}

export interface Plantilla {
  tono: Tono;
  nombre: string;
  descripcion: string;
  contenido: string;
}

export interface ItemColaCobranza {
  clienteId: string;
  empresa: string;
  score: number;
  nivel: NivelPrioridad;
  tono: Tono;
}

export interface ProgresoCobranza {
  fase: 'analizando' | 'redactando' | 'enviando' | 'listo';
  orden: ItemColaCobranza[];
  actualId: string | null;
  enviados: string[];
}

export interface ResultadoCobranza {
  enviados: number;
  mensajes: Mensaje[];
}

export type EventoNegociacion =
{tipo: 'cliente';mensaje: Mensaje;} |
{tipo: 'pensando';} |
{tipo: 'delta';texto: string;} |
{tipo: 'promesa';promesa: PromesaPago;} |
{tipo: 'escalamiento';escalamiento: Escalamiento;} |
{tipo: 'fin';mensaje: Mensaje;};

export interface Ajustes {
  canal: Canal;
  whatsapp: {
    conectado: boolean;
    numero: string;
    proveedor: string;
    plantillasAprobadas: number;
    ultimaSincronizacion: string;
  };
}

export interface AgenteMeta {
  id: AgenteId;
  nombre: string;
  rol: string;
  texto: string;
  fondo: string;
  suave: string;
  anillo: string;
  delegacion: string;
}