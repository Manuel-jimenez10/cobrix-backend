-- WhatsApp por empresa: cada cuenta registra su propio número en la cuenta de
-- WhatsApp Business de Cobrix (Graph API). Ejecuta este archivo en el SQL Editor
-- de Supabase si tu base ya existía antes de esta función.
alter table public.perfiles
  add column if not exists wa_phone_number_id text,
  add column if not exists wa_numero          text,
  add column if not exists wa_nombre          text,
  add column if not exists wa_estado          text check (wa_estado in ('verificando', 'conectado')),
  add column if not exists wa_pin             text,
  add column if not exists wa_conectado_en    timestamptz;

-- Un número de WhatsApp solo puede pertenecer a una cuenta de Cobrix.
create unique index if not exists perfiles_wa_phone_idx
  on public.perfiles (wa_phone_number_id) where wa_phone_number_id is not null;
