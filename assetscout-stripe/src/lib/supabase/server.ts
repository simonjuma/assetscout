/**
 * Request-scoped Supabase client bound to the caller's auth cookies.
 *
 * SERVER ONLY. This is the ONLY client billing routes use to find out *who* is
 * calling. Per the API contracts doc §6.1, the user id ALWAYS comes from this
 * session — never from a request body or query string.
 *
 * It intentionally uses the anon key + the user's JWT (RLS applies), so a bug in
 * a read query cannot silently expose another user's billing rows.
 */
import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { publicEnv } from '@/env';
import type { Database } from './database.types';

export async function supabaseServer() {
  const cookieStore = await cookies();
  const { supabaseUrl, supabaseAnonKey } = publicEnv;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      'Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY',
    );
  }

  return createServerClient<Database>(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component (read-only cookie jar). Middleware
          // refreshes the session there; ignoring is the documented behaviour.
        }
      },
    },
  });
}

/**
 * The authenticated user for this request, or null. Routes turn null into a 401
 * `unauthenticated` response themselves so the error envelope stays consistent.
 */
export async function getSessionUser() {
  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data.user ?? null;
}