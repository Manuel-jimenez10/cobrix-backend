// Carga .env en desarrollo (Node >= 20.12). En Render las variables vienen del panel.
try {
  process.loadEnvFile();
} catch {
  /* sin archivo .env: se usan las variables del entorno */
}

// Las fechas y "días de atraso" se calculan con la hora de México.
process.env.TZ ??= 'America/Mexico_City';

function requerida(nombre: string): string {
  const valor = process.env[nombre];
  if (!valor) throw new Error(`Falta la variable de entorno ${nombre}. Revisa server/.env.example`);
  return valor;
}

const lista = (valor: string | undefined, porDefecto: string) =>
  (valor ?? porDefecto)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export const env = {
  port: Number(process.env.PORT ?? 8787),
  corsOrigins: lista(process.env.CORS_ORIGINS, 'http://localhost:5173'),

  supabaseUrl: requerida('SUPABASE_URL'),
  supabaseServiceKey: requerida('SUPABASE_SERVICE_ROLE_KEY'),

  geminiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? '',
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-3.8-flash',
  geminiThinking: (process.env.GEMINI_THINKING ?? 'low') as 'minimal' | 'low' | 'medium' | 'high',
  aiRateLimit: Number(process.env.AI_RATE_LIMIT_PER_10MIN ?? 60),

  whatsapp: {
    token: process.env.WHATSAPP_TOKEN ?? '',
    /** Número compartido de demo (opcional si cada empresa conecta el suyo). */
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? '',
    /** Cuenta de WhatsApp Business de Cobrix: ahí se registran los números de las empresas. */
    wabaId: process.env.WHATSAPP_WABA_ID ?? '',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? '',
    appSecret: process.env.WHATSAPP_APP_SECRET ?? '',
    graphVersion: process.env.WHATSAPP_GRAPH_VERSION ?? 'v21.0',
    idioma: process.env.WHATSAPP_TEMPLATE_LANG ?? 'es_MX',
    plantillas: {
      amable: process.env.WHATSAPP_TEMPLATE_AMABLE ?? 'cobrix_recordatorio_amable',
      firme: process.env.WHATSAPP_TEMPLATE_FIRME ?? 'cobrix_seguimiento_firme',
      final: process.env.WHATSAPP_TEMPLATE_FINAL ?? 'cobrix_aviso_final'
    }
  }
};

export const iaDisponible = Boolean(env.geminiKey);
/** Hay un número compartido de demo configurado en el servidor. */
export const whatsappConfigurado = Boolean(env.whatsapp.token && env.whatsapp.phoneNumberId);
/** Las empresas pueden conectar su propio número (registro por Graph API). */
export const registroWhatsAppDisponible = Boolean(env.whatsapp.token && env.whatsapp.wabaId);
