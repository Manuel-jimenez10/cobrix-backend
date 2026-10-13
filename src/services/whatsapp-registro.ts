/**
 * Conexión del WhatsApp de cada empresa, todo desde Cobrix (sin que el usuario toque Meta):
 *
 *   1. conectar:  POST /{WABA}/phone_numbers         agrega el número a la cuenta de Cobrix
 *                 POST /{número}/request_code         Meta manda un código por SMS o llamada
 *   2. verificar: POST /{número}/verify_code          valida el código
 *                 POST /{número}/register             activa el número en la Cloud API
 *                 POST /{WABA}/subscribed_apps        el webhook recibe sus mensajes
 *                 POST /{WABA}/message_templates      crea las plantillas que falten
 *
 * Requisitos: WHATSAPP_TOKEN (usuario de sistema con whatsapp_business_management y
 * whatsapp_business_messaging) y WHATSAPP_WABA_ID. El número NO debe estar activo en la
 * app de WhatsApp (si lo está, hay que borrar esa cuenta antes).
 */
import { randomInt } from 'node:crypto';
import { ErrorMeta, PLANTILLAS_META, crearCanalWhatsApp, graph, infoNumero, soloDigitos } from '../channels/whatsapp.js';
import { actualizarPerfil, obtenerPerfil } from '../domain/db.js';
import { env, registroWhatsAppDisponible } from '../env.js';
import { revisar, supabase } from '../lib/supabase.js';
import type { Tono } from '../shared/types.js';
import { ErrorDeNegocio } from './cobranza.js';

export type EstadoPlantilla = 'APPROVED' | 'PENDING' | 'REJECTED' | 'PAUSED' | 'DISABLED' | 'NO_CREADA';

export interface EstadoWhatsApp {
  disponible: boolean;
  estado: 'desconectado' | 'verificando' | 'conectado';
  numero: string | null;
  nombre: string | null;
  calidad: string | null;
  estadoNombre: string | null;
  plantillas: { tono: Tono; nombre: string; estado: EstadoPlantilla; motivo?: string }[];
  webhookUrl: string;
}

const TONOS: Tono[] = ['amable', 'firme', 'final'];

/** Traduce los errores más comunes de Meta a algo accionable. */
function traducir(error: unknown): never {
  if (error instanceof ErrorDeNegocio) throw error;
  const e = error instanceof ErrorMeta ? error : null;
  const m = (e?.message ?? (error instanceof Error ? error.message : '')).toLowerCase();
  if (e?.codigo === 190) throw new ErrorDeNegocio('El token de WhatsApp del servidor expiró o es inválido. Genera uno nuevo de usuario de sistema.');
  if (e?.codigo === 10 || e?.codigo === 200) throw new ErrorDeNegocio('El token del servidor no tiene permiso whatsapp_business_management sobre la cuenta de WhatsApp Business.');
  if (m.includes('already') && m.includes('use')) throw new ErrorDeNegocio('Ese número ya está activo en WhatsApp. Borra la cuenta de WhatsApp de ese teléfono (Ajustes → Cuenta → Eliminar cuenta) y vuelve a intentarlo.');
  if (m.includes('limit') && m.includes('phone')) throw new ErrorDeNegocio('La cuenta de WhatsApp Business de Cobrix llegó a su límite de números. Verifica el negocio en Meta para ampliarlo.');
  if (m.includes('code') && (m.includes('incorrect') || m.includes('invalid') || m.includes('mismatch'))) throw new ErrorDeNegocio('El código no es correcto. Revísalo o pide uno nuevo.');
  if (m.includes('too many') || e?.codigo === 136024 || e?.codigo === 4) throw new ErrorDeNegocio('Pediste demasiados códigos. Espera unos minutos antes de volver a intentarlo.');
  if (m.includes('display name') || m.includes('verified_name')) throw new ErrorDeNegocio('Meta no aceptó el nombre del negocio. Usa el nombre comercial real, sin palabras genéricas ni emojis.');
  throw new ErrorDeNegocio(`Meta: ${e?.message ?? 'no se pudo completar la operación.'}`);
}

function exigirDisponible() {
  if (!registroWhatsAppDisponible) {
    throw new ErrorDeNegocio('El servidor aún no tiene configurada la cuenta de WhatsApp Business de Cobrix (WHATSAPP_TOKEN y WHATSAPP_WABA_ID).');
  }
}

/* ───────────── Plantillas ───────────── */

async function plantillasDeMeta(): Promise<Map<string, { status: EstadoPlantilla; rejected_reason?: string }>> {
  const r = await graph<{ data?: { name: string; status: EstadoPlantilla; language: string; rejected_reason?: string }[] }>(
    `${env.whatsapp.wabaId}/message_templates?fields=name,status,language,rejected_reason&limit=200`
  );
  const mapa = new Map<string, { status: EstadoPlantilla; rejected_reason?: string }>();
  for (const t of r.data ?? []) if (t.language === env.whatsapp.idioma) mapa.set(t.name, t);
  return mapa;
}

/** Crea en la cuenta de WhatsApp Business las plantillas de cobranza que falten (idempotente). */
export async function asegurarPlantillas(): Promise<void> {
  exigirDisponible();
  const existentes = await plantillasDeMeta();
  for (const tono of TONOS) {
    const nombre = env.whatsapp.plantillas[tono];
    if (existentes.has(nombre)) continue;
    const p = PLANTILLAS_META[tono];
    await graph(`${env.whatsapp.wabaId}/message_templates`, {
      cuerpo: {
        name: nombre,
        language: env.whatsapp.idioma,
        category: 'UTILITY',
        components: [{ type: 'BODY', text: p.texto, example: { body_text: [p.ejemplo] } }]
      }
    });
  }
}

/* ───────────── Estado ───────────── */

export async function estadoWhatsApp(userId: string): Promise<EstadoWhatsApp> {
  const perfil = await obtenerPerfil(userId);
  const base: EstadoWhatsApp = {
    disponible: registroWhatsAppDisponible,
    estado: perfil?.wa.estado ?? 'desconectado',
    numero: perfil?.wa.numero ?? null,
    nombre: perfil?.wa.nombre ?? null,
    calidad: null,
    estadoNombre: null,
    plantillas: TONOS.map((tono) => ({ tono, nombre: env.whatsapp.plantillas[tono], estado: 'NO_CREADA' as EstadoPlantilla })),
    webhookUrl: '/webhooks/whatsapp'
  };
  if (!registroWhatsAppDisponible) return base;
  try {
    const plantillas = await plantillasDeMeta();
    base.plantillas = base.plantillas.map((p) => {
      const t = plantillas.get(p.nombre);
      return t ? { ...p, estado: t.status, motivo: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : undefined } : p;
    });
    if (perfil?.wa.estado === 'conectado' && perfil.wa.phoneNumberId) {
      const info = await infoNumero(perfil.wa.phoneNumberId);
      base.numero = info.numero || base.numero;
      base.nombre = info.nombre || base.nombre;
      base.calidad = info.calidad;
      base.estadoNombre = info.estadoNombre;
    }
  } catch (error) {
    console.warn('[whatsapp] no se pudo leer el estado en Meta:', error instanceof Error ? error.message : error);
  }
  return base;
}

/* ───────────── Registro del número ───────────── */

export async function conectarNumero(
  userId: string,
  datos: { cc: string; numero: string; nombre: string; metodo: 'SMS' | 'VOICE' }
): Promise<EstadoWhatsApp> {
  exigirDisponible();
  const cc = soloDigitos(datos.cc);
  let numero = soloDigitos(datos.numero);
  if (numero.startsWith(cc) && numero.length > 10) numero = numero.slice(cc.length);
  if (cc === '52' && numero.length === 11 && numero.startsWith('1')) numero = numero.slice(1); // 521 + 10 dígitos
  if (numero.length < 7 || numero.length > 12) throw new ErrorDeNegocio('Escribe el número sin el código de país, por ejemplo 55 1234 5678.');

  try {
    // ¿Ya existe en la cuenta (por ejemplo, si se interrumpió un intento anterior)?
    const lista = await graph<{ data?: { id: string; display_phone_number: string }[] }>(`${env.whatsapp.wabaId}/phone_numbers?fields=id,display_phone_number&limit=100`);
    let id = lista.data?.find((n) => soloDigitos(n.display_phone_number).endsWith(numero))?.id;
    if (id) {
      const { data: dueño } = await supabase.from('perfiles').select('user_id').eq('wa_phone_number_id', id).neq('user_id', userId).maybeSingle();
      if (dueño) throw new ErrorDeNegocio('Ese número ya está conectado a otra cuenta de Cobrix.');
    } else {
      const creado = await graph<{ id: string }>(`${env.whatsapp.wabaId}/phone_numbers`, { cuerpo: { cc, phone_number: numero, verified_name: datos.nombre.trim() } });
      id = creado.id;
    }
    await graph(`${id}/request_code`, { cuerpo: { code_method: datos.metodo, language: 'es' } });
    await actualizarPerfil(userId, {
      wa_phone_number_id: id,
      wa_numero: `+${cc} ${numero}`,
      wa_nombre: datos.nombre.trim(),
      wa_estado: 'verificando',
      wa_conectado_en: null
    });
  } catch (error) {
    traducir(error);
  }
  return estadoWhatsApp(userId);
}

export async function reenviarCodigo(userId: string, metodo: 'SMS' | 'VOICE'): Promise<void> {
  exigirDisponible();
  const perfil = await obtenerPerfil(userId);
  if (!perfil?.wa.phoneNumberId || perfil.wa.estado !== 'verificando') throw new ErrorDeNegocio('Primero escribe tu número.');
  try {
    await graph(`${perfil.wa.phoneNumberId}/request_code`, { cuerpo: { code_method: metodo, language: 'es' } });
  } catch (error) {
    traducir(error);
  }
}

export async function verificarCodigo(userId: string, codigo: string): Promise<EstadoWhatsApp> {
  exigirDisponible();
  const perfil = await obtenerPerfil(userId);
  const id = perfil?.wa.phoneNumberId;
  if (!id || perfil.wa.estado !== 'verificando') throw new ErrorDeNegocio('Primero escribe tu número.');
  try {
    await graph(`${id}/verify_code`, { cuerpo: { code: soloDigitos(codigo) } });
    // PIN de verificación en dos pasos del número (lo pide Meta para registrarlo).
    const pin = String(randomInt(100000, 1000000));
    await graph(`${id}/register`, { cuerpo: { messaging_product: 'whatsapp', pin } });
    await graph(`${env.whatsapp.wabaId}/subscribed_apps`, { cuerpo: {} });
    await asegurarPlantillas().catch((e) => console.warn('[whatsapp] plantillas:', e instanceof Error ? e.message : e));
    const info = await infoNumero(id).catch(() => null);
    await actualizarPerfil(userId, {
      wa_estado: 'conectado',
      wa_pin: pin,
      wa_conectado_en: new Date().toISOString(),
      ...(info?.numero ? { wa_numero: info.numero } : {}),
      // Al conectar su número, la empresa pasa a enviar por WhatsApp.
      canal: 'whatsapp'
    });
  } catch (error) {
    traducir(error);
  }
  return estadoWhatsApp(userId);
}

export async function desconectar(userId: string): Promise<void> {
  revisar(
    await supabase
      .from('perfiles')
      .update({ wa_phone_number_id: null, wa_numero: null, wa_nombre: null, wa_estado: null, wa_pin: null, wa_conectado_en: null, canal: 'simulador' })
      .eq('user_id', userId),
    'desconectar whatsapp'
  );
}

/** Envía el recordatorio amable de ejemplo a un número, para ver cómo le llega al cliente. */
export async function enviarPrueba(userId: string, telefono: string): Promise<void> {
  const perfil = await obtenerPerfil(userId);
  if (perfil?.wa.estado !== 'conectado' || !perfil.wa.phoneNumberId) throw new ErrorDeNegocio('Conecta primero tu número de WhatsApp.');
  const canal = crearCanalWhatsApp(perfil.wa.phoneNumberId);
  const r = await canal.enviarPlantilla({
    telefono,
    tono: 'amable',
    variables: { nombre: 'Jorge', empresa: perfil.empresa, folio: 'F-1042', monto: '$28,500.00 MXN', dias: '67' }
  });
  if (!r.ok) throw new ErrorDeNegocio(`No se pudo enviar: ${r.error ?? 'error desconocido'}. ¿Ya está aprobada la plantilla amable?`);
}
