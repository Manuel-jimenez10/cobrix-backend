-- Cobrix · migración 002: políticas de negociación por empresa.
-- Si ya ejecutaste schema.sql antes, corre SOLO este archivo en el SQL Editor.
alter table public.perfiles add column if not exists politicas jsonb not null default '{}'::jsonb;
