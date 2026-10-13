/**
 * WhatsApp Cloud API (Meta Graph API).
 *
 * Cada empresa envía desde SU número, registrado en la cuenta de WhatsApp Business
 * de Cobrix (ver services/whatsapp-registro.ts). Si una cuenta no ha conectado número,
 * se puede usar el número compartido de demo (WHATSAPP_PHONE_NUMBER_ID).
 *
 * Las plantillas viven en la cuenta de WhatsApp Business (no en cada número), así que
 * se crean una sola vez por API y sirven para todas las empresas: {{2}} es el nombre
 * de la empresa en el recordatorio amable.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';
import type { Tono } from '../shared/types.js';
import type { CanalMensajeria, ResultadoEnvio } from './canal.js';

/** Plantillas tal como se registran en Meta. El orden de PARAMETROS = {{1}}, {{2}}… */
export const PLANTILLAS_META: Record<Tono, { texto: string; parametros: string[]; ejemplo: string[] }> = {
  amable: {
    texto:
      'Hola {{1}}, buen día. Te escribimos de {{2}} para recordarte que la factura {{3}} por {{4}} está pendiente de pago. ¿Nos ayudas confirmando la fecha en que podrás cubrirla? ¡Gracias!',
    parametros: ['nombre', 'empresa', 'folio', 'monto'],
    ejemplo: ['Jorge', 'Distribuidora del Valle', 'F-1042', '$28,500.00 MXN']
  },
  firme: {
    texto:
      'Hola {{1}}, seguimos sin registrar el pago de la factura {{2}} por {{3}}, con {{4}} días de atraso. Necesitamos acordar una fecha de pago esta semana para evitar recargos. Responde este mensaje y lo resolvemos.',
    parametros: ['nombre', 'folio', 'monto', 'dias'],
    ejemplo: ['Jorge', 'F-1042', '$28,500.00 MXN', '67']
  },
  final: {
    texto:
      'Hola {{1}}, este es nuestro último aviso sobre la factura {{2}} por {{3}}. Si no recibimos respuesta en 48 horas, el adeudo se turnará a nuestro despacho jurídico. Aún podemos acordar un plan de pagos si nos escribes hoy.',
    parametros: ['nombre', 'folio', 'monto'],
    ejemplo: ['Jorge', 'F-1042', '$28,500.00 MXN']
  }
};

const urlGraph = (ruta: string) => `https://graph.facebook.com/${env.whatsapp.graphVersion}/${ruta}`;

export class ErrorMeta extends Error {
  constructor(
    mensaje: string,
    readonly codigo?: number,
    readonly subcodigo?: number
  ) {
    super(mensaje);
  }
}

/** Llamada genérica a la Graph API con el token de usuario de sistema de Cobrix. */
export async function graph<T = Record<string, unknown>>(ruta: string, opciones: { metodo?: 'GET' | 'POST' | 'DELETE'; cuerpo?: object } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(urlGraph(ruta), {
      method: opciones.metodo ?? (opciones.cuerpo ? 'POST' : 'GET'),
      headers: { Authorization: `Bearer ${env.whatsapp.token}`, 'Content-Type': 'application/json' },
      body: opciones.cuerpo ? JSON.stringify(opciones.cuerpo) : undefined
    });
  } catch (error) {
    throw new ErrorMeta(error instanceof Error ? `No se pudo contactar a Meta: ${error.message}` : 'Error de red');
  }
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; error_user_msg?: string; code?: number; error_subcode?: number } };
  if (!res.ok || json.error) {
    const e = json.error;
    throw new ErrorMeta(e?.error_user_msg || e?.message || `Meta respondió HTTP ${res.status}`, e?.code, e?.error_subcode);
  }
  return json;
}

/** Solo dígitos, como los espera la Graph API (ej. 5215512345678). */
export const soloDigitos = (telefono: string) => telefono.replace(/\D/g, '');

/**
 * México: WhatsApp entrega los números móviles con "521" + 10 dígitos,
 * pero la API acepta enviar a "52" + 10 dígitos. Devolvemos ambas variantes.
 */
export function variantesMx(digitos: string): string[] {
  if (digitos.startsWith('521') && digitos.length === 13) return [digitos, `52${digitos.slice(3)}`];
  if (digitos.startsWith('52') && digitos.length === 12) return [digitos, `521${digitos.slice(2)}`];
  return [digitos];
}

async function enviar(phoneNumberId: string, cuerpo: object): Promise<ResultadoEnvio> {
  try {
    const json = await graph<{ messages?: { id: string }[] }>(`${phoneNumberId}/messages`, { cuerpo: { messaging_product: 'whatsapp', ...cuerpo } });
    return { ok: true, messageId: json.messages?.[0]?.id };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Error desconocido' };
  }
}

/** Canal de WhatsApp que envía desde un número concreto (el de la empresa o el de demo). */
export function crearCanalWhatsApp(phoneNumberId: string): CanalMensajeria {
  return {
    nombre: 'whatsapp',
    enviarPlantilla: ({ telefono, tono, variables }) =>
      enviar(phoneNumberId, {
        to: soloDigitos(telefono),
        type: 'template',
        template: {
          name: env.whatsapp.plantillas[tono],
          language: { code: env.whatsapp.idioma },
          components: [{ type: 'body', parameters: PLANTILLAS_META[tono].parametros.map((clave) => ({ type: 'text', text: variables[clave] ?? '' })) }]
        }
      }),
    enviarTexto: (telefono, texto) => enviar(phoneNumberId, { to: soloDigitos(telefono), type: 'text', text: { preview_url: false, body: texto } })
  };
}

export interface InfoNumero {
  id: string;
  numero: string;
  nombre: string;
  calidad: string | null;
  estadoNombre: string | null;
  verificado: boolean;
}

export async function infoNumero(phoneNumberId: string): Promise<InfoNumero> {
  const r = await graph<{
    id: string;
    display_phone_number?: string;
    verified_name?: string;
    quality_rating?: string;
    name_status?: string;
    code_verification_status?: string;
  }>(`${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,name_status,code_verification_status`);
  return {
    id: r.id,
    numero: r.display_phone_number ?? '',
    nombre: r.verified_name ?? '',
    calidad: r.quality_rating ?? null,
    estadoNombre: r.name_status ?? null,
    verificado: r.code_verification_status === 'VERIFIED'
  };
}

/** Comprueba el número compartido de demo. */
export async function verificarConexion(): Promise<{ ok: boolean; numero?: string; nombre?: string; error?: string }> {
  if (!env.whatsapp.token || !env.whatsapp.phoneNumberId) return { ok: false, error: 'Faltan WHATSAPP_TOKEN y WHATSAPP_PHONE_NUMBER_ID' };
  try {
    const i = await infoNumero(env.whatsapp.phoneNumberId);
    return { ok: true, numero: i.numero, nombre: i.nombre };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Error de red' };
  }
}

/** Valida X-Hub-Signature-256 para asegurar que el webhook viene de Meta. */
export function firmaValida(cuerpoCrudo: string, firma: string | undefined): boolean {
  if (!env.whatsapp.appSecret) return true; // sin secreto configurado (solo desarrollo)
  if (!firma?.startsWith('sha256=')) return false;
  const esperada = createHmac('sha256', env.whatsapp.appSecret).update(cuerpoCrudo, 'utf8').digest('hex');
  const a = Buffer.from(firma.slice(7), 'hex');
  const b = Buffer.from(esperada, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
