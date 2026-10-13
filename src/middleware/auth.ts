import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { env } from '../env.js';
import { obtenerPerfil } from '../domain/db.js';
import { sembrarDemo } from '../domain/seed.js';
import { revisar, supabase } from '../lib/supabase.js';

export type AppEnv = { Variables: { userId: string } };

/** Caché corta de tokens ya verificados para no consultar Supabase Auth en cada petición. */
const verificados = new Map<string, { userId: string; expira: number }>();
const inicializando = new Map<string, Promise<void>>();

/**
 * Primera vez que entra un usuario: crea su perfil y le siembra su propia cartera
 * de ejemplo. Así cada cuenta (o visitante de la demo anónima) tiene datos aislados.
 */
async function asegurarPerfil(user: { id: string; is_anonymous?: boolean; user_metadata?: Record<string, unknown> }) {
  if (await obtenerPerfil(user.id)) return;
  const meta = user.user_metadata ?? {};
  // Correo: nombre del registro. Google: full_name / name del perfil de Google.
  const nombre = String(meta.nombre ?? meta.full_name ?? meta.name ?? '').trim() || (user.is_anonymous ? 'Invitado' : 'Administrador');
  const empresa = String(meta.empresa ?? '').trim() || 'Distribuidora del Valle';
  revisar(
    await supabase
      .from('perfiles')
      .upsert({ user_id: user.id, nombre, empresa, es_anonimo: Boolean(user.is_anonymous) }, { onConflict: 'user_id', ignoreDuplicates: true }),
    'crear perfil'
  );
  await sembrarDemo(user.id, empresa);
}

export const requiereUsuario: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) throw new HTTPException(401, { message: 'Falta el token de sesión' });

  const enCache = verificados.get(token);
  if (enCache && enCache.expira > Date.now()) {
    c.set('userId', enCache.userId);
    return next();
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw new HTTPException(401, { message: 'Sesión inválida o expirada' });

  const user = data.user;
  if (!inicializando.has(user.id)) {
    inicializando.set(user.id, asegurarPerfil(user).finally(() => inicializando.delete(user.id)));
  }
  await inicializando.get(user.id);

  verificados.set(token, { userId: user.id, expira: Date.now() + 5 * 60_000 });
  if (verificados.size > 5000) verificados.clear();
  c.set('userId', user.id);
  return next();
};

/** Límite de llamadas a IA por usuario: protege la capa gratuita de Gemini de abusos en la demo pública. */
const ventanas = new Map<string, number[]>();

/**
 * Versión "suave" del límite para el asistente de cobranza: en vez de fallar,
 * responde false y la función usa sus reglas de respaldo (la app nunca se traba).
 */
export function cuotaIA(userId: string, costo = 1): boolean {
  const ahora = Date.now();
  const recientes = (ventanas.get(userId) ?? []).filter((t) => ahora - t < 10 * 60_000);
  if (recientes.length + costo > env.aiRateLimit) {
    ventanas.set(userId, recientes);
    return false;
  }
  for (let i = 0; i < costo; i++) recientes.push(ahora);
  ventanas.set(userId, recientes);
  return true;
}
export const limiteIA: MiddlewareHandler<AppEnv> = async (c, next) => {
  const userId = c.get('userId');
  const ahora = Date.now();
  const recientes = (ventanas.get(userId) ?? []).filter((t) => ahora - t < 10 * 60_000);
  if (recientes.length >= env.aiRateLimit) {
    throw new HTTPException(429, { message: 'Demasiadas solicitudes a los agentes. Espera unos minutos.' });
  }
  recientes.push(ahora);
  ventanas.set(userId, recientes);
  return next();
};
