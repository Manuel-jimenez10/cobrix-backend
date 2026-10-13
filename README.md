# Cobrix · Backend de agentes

Cobrix es una app de cobranza por **WhatsApp** para PyMEs mexicanas. Automatiza lo repetitivo, que es decidir a quién cobrar primero y mandar los recordatorios con plantillas aprobadas por Meta, y deja la conversación con el cliente en manos de una persona del equipo, porque en este negocio la relación es personal. La única IA es la **Guía**: le enseña al usuario a usar la app, responde datos de su cartera y le ilumina en pantalla dónde presionar.

| Pieza | Qué hace | Cómo está construida |
|---|---|---|
| **Prioridad** (automático) | Decide a quién cobrar primero y explica por qué | Score 0-100 por reglas: atraso, monto, mensajes sin respuesta y promesas. Instantáneo y explicable |
| **Recordatorios** (automático) | Envía el recordatorio que toca: amable → firme → final | Siempre plantilla aprobada por Meta, así que vale dentro y fuera de la ventana de 24 h |
| **Tu equipo** (personas) | Contesta a los clientes y registra promesas de pago | Cuando un cliente responde queda en **"Requiere atención"** y sus recordatorios se pausan |
| **Guía** (IA) | Enseña a usar Cobrix, responde sobre la cartera y señala dónde presionar | `streamText` con un manual de la app, el estado real de la cuenta (`estado_de_mi_cuenta`) y botones (`mostrar_boton`) que llevan a la pantalla e iluminan el botón exacto |

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
 │ /guia/chat          (NDJSON)     │
 └──────────────────────────────────┘
```

**Decisiones técnicas**

- **La API vive en código** (Hono) y no en reglas del dashboard: validación con Zod, lógica testeable y versionada. Supabase se usa como base de datos, auth y realtime.
- **Multiusuario con RLS.** Cada fila tiene `user_id`. El frontend solo puede **leer** lo suyo; todas las escrituras pasan por el backend, que verifica el JWT. Cada cuenta nueva, y cada visitante de la demo anónima, recibe su propia cartera de ejemplo.
- **Streaming NDJSON.** La UI ve el progreso de los agentes y el texto de la IA mientras se genera.
- **La IA nunca inventa cifras.** La Guía solo usa los números que le da su herramienta `estado_de_mi_cuenta`.
- **Siempre funciona.** Si no hay API key de Gemini, se agota la capa gratuita o el modelo falla, los agentes pasan a reglas de respaldo y la demo no se rompe.
- **Canal desacoplado.** La interfaz `CanalMensajeria` tiene dos implementaciones: `WhatsAppCloud` y `Simulador`. Agregar Twilio o Telegram no toca a los agentes.
- **Proveedor de IA intercambiable.** Con el Vercel AI SDK, pasar de Gemini a OpenAI o Claude es cambiar una línea en `src/agents/modelo.ts`.
- **Límite de uso por usuario** en los endpoints de IA, para proteger la capa gratuita en una demo pública.
- **Supabase en lugar de Neon y S3.** Ya tenía auth, realtime y storage integrados en un solo proveedor, lo que reduce complejidad en un MVP. Migrar los archivos a S3 sería directo.

## Flujo de cobranza

1. **Iniciar cobranza** (`POST /cobranza/iniciar`, NDJSON): se recalcula la prioridad y se envía la plantilla que toca. Se omite a quien espera respuesta, tiene una promesa vigente, está en revisión o no tiene saldo. La respuesta lista los omitidos.
2. **El cliente responde** (webhook de WhatsApp o simulador `POST /cobranza/responder`): se guarda el mensaje, se marca "requiere atención" y se avisa por Realtime. Ninguna IA le contesta.
3. **El equipo contesta** (`POST /clientes/:id/responder`): texto libre por WhatsApp. Solo sale con la ventana de 24 h abierta; si está cerrada responde 409 con el motivo.
4. **Promesa de pago** (`POST /clientes/:id/promesa`): monto y fecha. Se valida contra el saldo y pausa los recordatorios hasta esa fecha.

## Reglas de cobranza (configurables por empresa)

En **Ajustes → Reglas de cobranza** se define el **horario de envíos** (`/cobranza/iniciar` responde 409 fuera de horario) y el **tono máximo** de los recordatorios. Las reglas se aplican en el servidor.

## Estructura

```
├── src/
│   ├── agents/      guía (IA), analista y redactor (reglas)
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

## WhatsApp Cloud API

Sin estas variables, Cobrix usa el **simulador**: tú respondes como el cliente dentro de la app.

### Cada empresa conecta su propio número (desde la app)

Cobrix registra el número de cada empresa en **su propia cuenta de WhatsApp Business** por la Graph API. El usuario no entra a Meta:

1. Ajustes → **Conectar mi WhatsApp**: número + nombre del negocio → `POST /{WABA}/phone_numbers` y `POST /{número}/request_code` (SMS o llamada).
2. Escribe el código de 6 dígitos → `verify_code` → `register` → `subscribed_apps`.
3. Cobrix crea las 3 plantillas que falten (`POST /{WABA}/message_templates`, Utility, es_MX) y muestra su estado de aprobación.

Desde ahí, los recordatorios de esa cuenta salen de su número y el webhook ubica cada respuesta por `metadata.phone_number_id`.

**Configuración (una vez, en Meta):**
1. En **business.facebook.com**, crea el portafolio comercial; en **developers.facebook.com**, agrega el producto **WhatsApp** a tu app. Anota el **ID de la cuenta de WhatsApp Business** (WABA).
2. Agrega un **método de pago** en WhatsApp Manager (Meta cobra las conversaciones a esta cuenta).
3. **Usuarios del sistema** → crea uno Administrador, asígnale la app y la cuenta de WhatsApp, y genera un token *sin caducidad* con `whatsapp_business_management` y `whatsapp_business_messaging`.
4. **Webhook** (WhatsApp → Configuración): Callback `https://TU-BACKEND.onrender.com/webhooks/whatsapp`, Verify token = `WHATSAPP_VERIFY_TOKEN`, suscrito a **messages**.
5. En Render: `WHATSAPP_TOKEN`, `WHATSAPP_WABA_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`.
6. En Supabase, ejecuta `supabase/003_whatsapp_empresa.sql` si tu base ya existía.

**Límites:** el número **no puede estar activo** en la app de WhatsApp (hay que borrar esa cuenta antes); sin verificación del negocio, Meta permite pocos números por cuenta. Para que las empresas usen el número que ya tienen en WhatsApp Business (coexistencia), el camino es **Embedded Signup** (requiere ser Tech Provider).

### Número compartido de demo (opcional)

Con `WHATSAPP_PHONE_NUMBER_ID` las cuentas sin número propio envían desde el número de prueba de Meta. Como solo puede escribir a destinatarios registrados, en **Ajustes → "Tu WhatsApp para pruebas"** cada usuario pone su número y los mensajes de la demo se redirigen ahí.

**Para producción:** verificación del negocio, número propio, plantillas aprobadas y App Review de Meta.

## Stack

React 18 · Vite · TypeScript · Tailwind · Framer Motion · Hono · Vercel AI SDK · Gemini · Zod · Supabase (Postgres, Auth, RLS, Realtime) · WhatsApp Cloud API · Render · Vercel
