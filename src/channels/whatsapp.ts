/**
 * WhatsApp Cloud API (Meta Graph API).
 *
 * Plantillas que hay que crear y aprobar en WhatsApp Manager (categoría Utility,
 * idioma es_MX). El orden de las variables {{n}} debe coincidir con PARAMETROS.
 *
 *  cobrix_recordatorio_amable:
 *    Hola {{1}}, buen día. Te escribimos de {{2}} para recordarte que la factura {{3}} por {{4}}
 *    está pendiente de pago. ¿Nos ayudas confirmando la fecha en que podrás cubrirla? ¡Gracias!
 *  cobrix_seguimiento_firme:
 *    {{1}}, seguimos sin registrar el pago de la factura {{2}} por {{3}}, con {{4}} días de atraso.
 *    Necesitamos acordar una fecha de pago esta semana para evitar recargos. Responde este mensaje y lo resolvemos.
 *  cobrix_aviso_final:
 *    {{1}}, este es nuestro último aviso sobre la factura {{2}} por {{3}}. Si no recibimos respuesta en 48 horas,
 *    el adeudo se turnará a nuestro despacho jurídico. Aún podemos acordar un plan de pagos si nos escribes hoy.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env, whatsappConfigurado } from '../env.js';
import type { Tono } from '../shared/types.js';
import type { CanalMensajeria, ResultadoEnvio } from './canal.js';

const PARAMETROS: Record<Tono, string[]> = {
  amable: ['nombre', 'empresa', 'folio', 'monto'],
  firme: ['nombre', 'folio', 'monto', 'dias'],
  final: ['nombre', 'folio', 'monto']
};

const urlGraph = (ruta: string) => `https://graph.facebook.com/${env.whatsapp.graphVersion}/${ruta}`;

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

async function llamarGraph(cuerpo: object): Promise<ResultadoEnvio> {
  try {
    const res = await fetch(urlGraph(`${env.whatsapp.phoneNumberId}/messages`), {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.whatsapp.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...cuerpo })
    });
    const json = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string } };
    if (!res.ok) return { ok: false, error: json.error?.message ?? `HTTP ${res.status}` };
    return { ok: true, messageId: json.messages?.[0]?.id };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Error de red' };
  }
}

export const canalWhatsApp: CanalMensajeria = {
  nombre: 'whatsapp',
  async enviarPlantilla({ telefono, tono, variables }) {
    if (!whatsappConfigurado) return { ok: false, error: 'WhatsApp no está configurado en el servidor' };
    return llamarGraph({
      to: soloDigitos(telefono),
      type: 'template',
      template: {
        name: env.whatsapp.plantillas[tono],
        language: { code: env.whatsapp.idioma },
        components: [
          { type: 'body', parameters: PARAMETROS[tono].map((clave) => ({ type: 'text', text: variables[clave] ?? '' })) }
        ]
      }
    });
  },
  async enviarTexto(telefono, texto) {
    if (!whatsappConfigurado) return { ok: false, error: 'WhatsApp no está configurado en el servidor' };
    return llamarGraph({ to: soloDigitos(telefono), type: 'text', text: { preview_url: false, body: texto } });
  }
};

export async function verificarConexion(): Promise<{ ok: boolean; numero?: string; nombre?: string; error?: string }> {
  if (!whatsappConfigurado) return { ok: false, error: 'Faltan WHATSAPP_TOKEN y WHATSAPP_PHONE_NUMBER_ID' };
  try {
    const res = await fetch(urlGraph(`${env.whatsapp.phoneNumberId}?fields=display_phone_number,verified_name`), {
      headers: { Authorization: `Bearer ${env.whatsapp.token}` }
    });
    const json = (await res.json()) as { display_phone_number?: string; verified_name?: string; error?: { message?: string } };
    if (!res.ok) return { ok: false, error: json.error?.message ?? `HTTP ${res.status}` };
    return { ok: true, numero: json.display_phone_number, nombre: json.verified_name };
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
