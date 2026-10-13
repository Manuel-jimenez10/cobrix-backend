import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { logger } from 'hono/logger';
import { ZodError } from 'zod';
import { env, iaDisponible, whatsappConfigurado } from './env.js';
import { requiereUsuario, type AppEnv } from './middleware/auth.js';
import { agentes } from './routes/agentes.js';
import { datos } from './routes/datos.js';
import { webhook } from './routes/webhook.js';

const app = new Hono<AppEnv>();

app.use('*', logger());
app.use(
  '*',
  cors({
    origin: (origen) => (env.corsOrigins.includes('*') || env.corsOrigins.includes(origen) ? origen : null),
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'OPTIONS'],
    maxAge: 600
  })
);

app.get('/health', (c) => c.json({ ok: true, ia: iaDisponible ? env.geminiModel : 'reglas', whatsapp: whatsappConfigurado }));

// Público: Meta llama a este endpoint (se valida con firma HMAC).
app.route('/webhooks/whatsapp', webhook);

// Todo lo demás requiere sesión de Supabase.
const privado = new Hono<AppEnv>();
privado.use('*', requiereUsuario);
privado.route('/', datos);
privado.route('/', agentes);
app.route('/', privado);

app.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  if (error instanceof ZodError) return c.json({ error: 'Datos inválidos', detalles: error.issues }, 400);
  console.error(error);
  return c.json({ error: 'Error interno del servidor' }, 500);
});

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`Cobrix API escuchando en http://localhost:${info.port}`);
  console.log(`  IA: ${iaDisponible ? `Gemini (${env.geminiModel})` : 'sin API key → reglas de respaldo'}`);
  console.log(`  WhatsApp: ${whatsappConfigurado ? 'Cloud API configurada' : 'no configurado → simulador'}`);
});
