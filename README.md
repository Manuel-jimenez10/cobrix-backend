# Cobrix · Backend de agentes

Cobrix es una app de cobranza para PyMEs mexicanas. Un equipo de **cuatro agentes de IA** prioriza la cartera, escribe a los deudores por **WhatsApp**, negocia fechas de pago y le reporta al administrador. El administrador conversa con el agente coordinador y **confirma cada envío**: es un esquema *human in the loop*.

| Agente | Qué hace | Cómo está construido |
|---|---|---|
| **Director** | Conversa con el administrador, le da el estado de la cartera y delega en los demás agentes | `streamText` + 7 herramientas. Responde con componentes de UI dentro del chat: KPIs, gráficas, listas y confirmaciones |
| **Analista** | Decide a quién cobrar primero y por qué | Score base determinista + `generateObject` (Zod) que lo ajusta ±15 y redacta la razón |
| **Redactor** | Escribe el mensaje con el tono adecuado (amable → firme → final) | Fuera de la ventana de 24 h usa plantillas aprobadas por Meta; dentro de la ventana, la IA redacta |
| **Negociador** | Contesta al deudor y registra promesas de pago o escala a un humano | `streamText` con *tool calling*: `registrar_promesa` y `escalar_a_humano` |

> Este repo es la **API de agentes** (Hono + Vercel AI SDK + Gemini + Supabase + WhatsApp Cloud API). La interfaz vive en el repo **cobrix-frontend** de la misma organización.

## Arquitectura

```
                         ┌────────────────────────────┐
 Navegador (React+Vite)  │  Supabase                  │
 ───────────────────────►│  · Auth (correo / anónimo) │
   login y Realtime      │  · Postgres + RLS          │
        │                │  · Realtime (eventos)      │
        │ JWT            └─────────────▲──────────────┘
        ▼                              │ service role (filtra por user_id)
 ┌──────────────────────────────────┐  │
 │ Backend de agentes (Render)      │──┘
 │ Hono + Vercel AI SDK + Gemini    │
 │ /dashboard /clientes …           │◄──── Webhook ──── WhatsApp Cloud API
 │ /cobranza/iniciar   (NDJSON)     │───── Graph API ──►  (Meta)
 │ /cobranza/responder (NDJSON)     │
 │ /director/chat      (NDJSON)     │
 └──────────────────────────────────┘
```

**Decisiones técnicas**

- **La API vive en código** (Hono) y no en reglas del dashboard: validación con Zod, lógica testeable y versionada. Supabase se usa como base de datos, auth y realtime.
- **Multiusuario con RLS.** Cada fila tiene `user_id`. El frontend solo puede **leer** lo suyo; todas las escrituras pasan por el backend, que verifica el JWT. Cada cuenta nueva, y cada visitante de la demo anónima, recibe su propia cartera de ejemplo.
- **Streaming NDJSON.** La UI ve el progreso de los agentes y el texto de la IA mientras se genera.
- **La IA nunca inventa cifras.** El Director solo habla de números que vienen de sus herramientas, y el Analista parte de un score calculado.
- **Siempre funciona.** Si no hay API key de Gemini, se agota la capa gratuita o el modelo falla, los agentes pasan a reglas de respaldo y la demo no se rompe.
- **Canal desacoplado.** La interfaz `CanalMensajeria` tiene dos implementaciones: `WhatsAppCloud` y `Simulador`. Agregar Twilio o Telegram no toca a los agentes.
- **Proveedor de IA intercambiable.** Con el Vercel AI SDK, pasar de Gemini a OpenAI o Claude es cambiar una línea en `src/agents/modelo.ts`.
- **Límite de uso por usuario** en los endpoints de IA, para proteger la capa gratuita en una demo pública.
- **Supabase en lugar de Neon y S3.** Ya tenía auth, realtime y storage integrados en un solo proveedor, lo que reduce complejidad en un MVP. Migrar los archivos a S3 sería directo.

## Políticas de negociación (configurables por empresa)

En **Ajustes → Políticas de negociación** cada empresa define qué puede ofrecer el Negociador:

- **Acuerdos:** número máximo de pagos, plazo máximo del primer pago, pago inicial mínimo, descuento por liquidar y tono más fuerte permitido.
- **Escalamiento:** disputa, producto defectuoso, temas legales, petición de hablar con una persona y saldos mayores a un monto.
- **Horario:** días y horas en que se pueden iniciar envíos. Las respuestas a clientes se atienden siempre.

Las reglas se le explican al modelo, pero **se hacen cumplir en el servidor**. `registrar_promesa` valida cada propuesta con `validarPromesa()` y, si no cumple, devuelve `registrada: false` con el motivo, así que el agente tiene que reformular. `escalar_a_humano` solo escala por los motivos activos. El Redactor y el Director respetan el tono máximo, y `/cobranza/iniciar` rechaza los envíos fuera de horario (HTTP 409). Las reglas de respaldo (sin IA) usan las mismas políticas.

## Estructura

```
├── src/
│   ├── agents/      director, analista, redactor, negociador y respaldo (reglas sin IA)
│   ├── channels/    whatsapp (Cloud API) y simulador
│   ├── services/    flujos de cobranza (orquestación)
│   ├── routes/      datos, agentes (streaming NDJSON) y webhook de WhatsApp
│   ├── domain/      acceso a datos, reglas de negocio y datos demo
│   └── shared/      tipos, formatos y políticas (compartidos con el frontend)
├── supabase/        schema.sql y migraciones
├── render.yaml      despliegue en Render (Blueprint)
└── .github/workflows/mantener-despierto.yml
```

## Puesta en marcha (todo con planes gratuitos)

### 1. Supabase
1. Crea un proyecto en [supabase.com](https://supabase.com).
2. En **SQL Editor**, pega el contenido de `supabase/schema.sql` y dale **Run**. Si ya lo habías ejecutado antes de que existieran las políticas, corre también `supabase/002_politicas.sql`.
3. En **Authentication → Sign In / Providers**, activa **Allow anonymous sign-ins** (lo usa el botón "Probar la demo").
4. Opcional, para probar más rápido: desactiva **Confirm email** en el proveedor Email.
5. En **Project Settings → API**, copia la **URL**, la **anon key** (va al frontend) y la **service_role key** (solo va al backend).

### 2. Gemini (gratis)
Crea una API key en [Google AI Studio](https://aistudio.google.com/apikey).

### 3. En local
```bash
cp .env.example .env      # rellena SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY y GOOGLE_GENERATIVE_AI_API_KEY
npm install
npm run dev               # http://localhost:8787/health
```

### 4. Despliegue en Render
1. *New → Blueprint* y elige este repo; Render lee `render.yaml`.
2. Llena las variables: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` y, en `CORS_ORIGINS`, la URL de Vercel del frontend (por ejemplo `https://cobrix-frontend.vercel.app`; separa varias con coma).
3. Revisa que responda `https://TU-BACKEND.onrender.com/health`.

> El plan gratuito de Render "duerme" el servidor tras 15 minutos sin uso, y la primera petición tarda unos 30 segundos. Para evitarlo, el workflow `.github/workflows/mantener-despierto.yml` hace ping a `/health` cada 5 minutos (el mínimo de GitHub Actions) de 7:00 a 1:00. Con el repo **público** los minutos de Actions son gratis; si es privado, este ping consume más que los 2,000 minutos gratuitos del mes. Solo tienes que crear el secreto **`RENDER_HEALTH_URL`** en GitHub (*Settings → Secrets and variables → Actions*) con `https://TU-BACKEND.onrender.com/health`. Si aun así se durmiera, la app lo indica y permite reintentar.

## WhatsApp Cloud API (opcional)

Sin estas variables, Cobrix usa el **simulador**: tú respondes como el cliente dentro de la app.

1. En **Meta for Developers**, abre tu app y agrega el producto **WhatsApp**. Meta te da un **número de prueba** gratis, sin necesidad de publicar la app.
2. En **API Setup**, registra tu número personal como destinatario de prueba.
3. Para un token permanente, en **Business Settings → System users** crea un usuario de sistema con permiso `whatsapp_business_messaging` y genera el token. El token temporal del panel vence en 24 h.
4. En **Configuration → Webhook**:
   - Callback URL: `https://TU-BACKEND.onrender.com/webhooks/whatsapp`
   - Verify token: el mismo valor que pongas en `WHATSAPP_VERIFY_TOKEN`
   - Suscríbete al campo **messages**.
5. En **WhatsApp Manager → Plantillas**, crea estas tres plantillas (categoría **Utility**, idioma **Spanish (MEX)**):

| Nombre | Cuerpo |
|---|---|
| `cobrix_recordatorio_amable` | Hola {{1}}, buen día. Te escribimos de {{2}} para recordarte que la factura {{3}} por {{4}} está pendiente de pago. ¿Nos ayudas confirmando la fecha en que podrás cubrirla? ¡Gracias! |
| `cobrix_seguimiento_firme` | {{1}}, seguimos sin registrar el pago de la factura {{2}} por {{3}}, con {{4}} días de atraso. Necesitamos acordar una fecha de pago esta semana para evitar recargos. Responde este mensaje y lo resolvemos. |
| `cobrix_aviso_final` | {{1}}, este es nuestro último aviso sobre la factura {{2}} por {{3}}. Si no recibimos respuesta en 48 horas, el adeudo se turnará a nuestro despacho jurídico. Aún podemos acordar un plan de pagos si nos escribes hoy. |

6. Configura `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN` y `WHATSAPP_APP_SECRET` en Render.
7. En la app, ve a **Ajustes**: activa el canal **WhatsApp** y escribe tu número en **"Tu WhatsApp para pruebas"**. Como el número de prueba solo puede escribir a destinatarios registrados, todos los mensajes de la demo se redirigen a tu número, y lo que respondas llega al Negociador.

**Para producción:** verificación del negocio, número propio, plantillas aprobadas y App Review de Meta.

## Stack

React 18 · Vite · TypeScript · Tailwind · Framer Motion · Hono · Vercel AI SDK · Gemini · Zod · Supabase (Postgres, Auth, RLS, Realtime) · WhatsApp Cloud API · Render · Vercel
