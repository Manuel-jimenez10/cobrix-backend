import { createClient } from '@supabase/supabase-js';
import { env } from '../env.js';

/**
 * Cliente con service role: salta RLS. Solo vive en el backend y SIEMPRE
 * se usa filtrando por el user_id que sale del JWT verificado.
 */
export const supabase = createClient(env.supabaseUrl, env.supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

export function revisar<T>(resultado: { data: T; error: { message: string } | null }, contexto: string): T {
  if (resultado.error) throw new Error(`${contexto}: ${resultado.error.message}`);
  return resultado.data;
}
