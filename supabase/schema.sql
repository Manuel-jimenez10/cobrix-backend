-- =====================================================================
-- Cobrix · esquema de base de datos (Supabase / PostgreSQL)
--
-- Cómo usarlo: Supabase → SQL Editor → pega este archivo completo → Run.
-- Es idempotente: puedes volver a ejecutarlo sin perder datos.
--
-- Modelo de seguridad:
--   · Cada fila pertenece a un usuario (user_id → auth.users).
--   · RLS activado en todas las tablas: un usuario SOLO puede LEER sus filas.
--   · No hay políticas de escritura: todas las escrituras las hace el backend
--     de agentes con la service role key, después de validar el JWT del usuario.
--   · Realtime publica eventos_agente, mensajes y promesas (respetando RLS).
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Perfil del administrador (uno por usuario)
-- ---------------------------------------------------------------------
create table if not exists public.perfiles (
  user_id         uuid primary key references auth.users (id) on delete cascade,
  nombre          text not null default 'Invitado',
  empresa         text not null default 'Distribuidora del Valle',
  canal           text not null default 'simulador' check (canal in ('whatsapp', 'simulador')),
  -- Número real al que se redirigen los mensajes de WhatsApp en modo demo
  -- (el número de prueba de Meta solo puede escribir a destinatarios registrados).
  telefono_prueba text,
  telefono_prueba_digitos text generated always as (nullif(regexp_replace(coalesce(telefono_prueba, ''), '\D', '', 'g'), '')) stored,
  es_anonimo      boolean not null default false,
  -- Políticas de negociación (ver server/src/shared/politicas.ts). {} = valores por defecto.
  politicas       jsonb not null default '{}'::jsonb,
  -- WhatsApp propio de la empresa (ver 003_whatsapp_empresa.sql)
  wa_phone_number_id text,
  wa_numero       text,
  wa_nombre       text,
  wa_estado       text check (wa_estado in ('verificando', 'conectado')),
  wa_pin          text,
  wa_conectado_en timestamptz,
  created_at      timestamptz not null default now()
);

-- Proyectos creados antes de agregar las políticas
alter table public.perfiles add column if not exists politicas jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------------
-- Cartera
-- ---------------------------------------------------------------------
create table if not exists public.clientes (
  id         text primary key default gen_random_uuid()::text,
  user_id    uuid not null references auth.users (id) on delete cascade,
  nombre     text not null,
  empresa    text not null,
  telefono   text not null,
  telefono_digitos text generated always as (regexp_replace(telefono, '\D', '', 'g')) stored,
  email      text not null default '',
  canal      text not null default 'whatsapp' check (canal in ('whatsapp', 'simulador')),
  created_at timestamptz not null default now()
);

create table if not exists public.facturas (
  id                text primary key default gen_random_uuid()::text,
  user_id           uuid not null references auth.users (id) on delete cascade,
  cliente_id        text not null references public.clientes (id) on delete cascade,
  folio             text not null,
  monto             numeric(12, 2) not null check (monto >= 0),
  fecha_emision     timestamptz not null,
  fecha_vencimiento timestamptz not null,
  -- 'vencida' se calcula en el backend a partir de fecha_vencimiento;
  -- aquí se guarda el estado administrativo.
  estado            text not null default 'pendiente' check (estado in ('pendiente', 'vencida', 'pagada', 'promesa')),
  created_at        timestamptz not null default now()
);

create table if not exists public.prioridades (
  cliente_id text primary key references public.clientes (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  score      int not null check (score between 0 and 100),
  nivel      text not null check (nivel in ('alta', 'media', 'baja')),
  razon      text not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Conversaciones y actividad de agentes
-- ---------------------------------------------------------------------
create table if not exists public.mensajes (
  id            text primary key default gen_random_uuid()::text,
  user_id       uuid not null references auth.users (id) on delete cascade,
  cliente_id    text not null references public.clientes (id) on delete cascade,
  rol           text not null check (rol in ('agente', 'cliente')),
  agente        text check (agente in ('director', 'analista', 'redactor', 'negociador')),
  contenido     text not null,
  tono          text check (tono in ('amable', 'firme', 'final')),
  es_plantilla  boolean not null default false,
  canal         text not null default 'simulador' check (canal in ('whatsapp', 'simulador')),
  wa_message_id text,
  fecha         timestamptz not null default now()
);

create table if not exists public.eventos_agente (
  id         text primary key default gen_random_uuid()::text,
  user_id    uuid not null references auth.users (id) on delete cascade,
  cliente_id text references public.clientes (id) on delete cascade,
  agente     text not null check (agente in ('director', 'analista', 'redactor', 'negociador')),
  accion     text not null,
  detalle    text not null default '',
  estado     text not null check (estado in ('en_progreso', 'completado', 'error')),
  fecha      timestamptz not null default now()
);

create table if not exists public.promesas (
  id               text primary key default gen_random_uuid()::text,
  user_id          uuid not null references auth.users (id) on delete cascade,
  cliente_id       text not null references public.clientes (id) on delete cascade,
  factura_id       text references public.facturas (id) on delete set null,
  monto            numeric(12, 2) not null check (monto >= 0),
  fecha_compromiso timestamptz not null,
  estado           text not null default 'pendiente' check (estado in ('pendiente', 'cumplida', 'incumplida')),
  created_at       timestamptz not null default now()
);

create table if not exists public.escalamientos (
  id         text primary key default gen_random_uuid()::text,
  user_id    uuid not null references auth.users (id) on delete cascade,
  cliente_id text not null references public.clientes (id) on delete cascade,
  motivo     text not null,
  fecha      timestamptz not null default now(),
  resuelto   boolean not null default false
);

-- Pagos recibidos: alimentan "recuperado este mes" y la gráfica semanal.
create table if not exists public.pagos (
  id         text primary key default gen_random_uuid()::text,
  user_id    uuid not null references auth.users (id) on delete cascade,
  cliente_id text references public.clientes (id) on delete set null,
  monto      numeric(12, 2) not null check (monto >= 0),
  fecha      timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Índices
-- ---------------------------------------------------------------------
create unique index if not exists perfiles_wa_phone_idx on public.perfiles (wa_phone_number_id) where wa_phone_number_id is not null;
create index if not exists clientes_user_idx        on public.clientes (user_id);
create index if not exists clientes_tel_idx         on public.clientes (telefono_digitos);
create index if not exists facturas_user_idx        on public.facturas (user_id);
create index if not exists facturas_cliente_idx     on public.facturas (cliente_id);
create index if not exists prioridades_user_idx     on public.prioridades (user_id);
create index if not exists mensajes_user_idx        on public.mensajes (user_id, fecha);
create index if not exists mensajes_cliente_idx     on public.mensajes (cliente_id, fecha);
create index if not exists eventos_user_idx         on public.eventos_agente (user_id, fecha desc);
create index if not exists promesas_user_idx        on public.promesas (user_id);
create index if not exists escalamientos_user_idx   on public.escalamientos (user_id);
create index if not exists pagos_user_idx           on public.pagos (user_id, fecha);
create index if not exists perfiles_tel_prueba_idx  on public.perfiles (telefono_prueba_digitos);

-- ---------------------------------------------------------------------
-- Row Level Security: cada usuario solo lee lo suyo
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['perfiles','clientes','facturas','prioridades','mensajes','eventos_agente','promesas','escalamientos','pagos']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "lectura propia" on public.%I', t);
    execute format('create policy "lectura propia" on public.%I for select to authenticated using ((select auth.uid()) = user_id)', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Realtime (el dashboard ve a los agentes trabajar en vivo)
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['eventos_agente','mensajes','promesas']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
