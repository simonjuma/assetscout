/**
 * Service-role Supabase client. WRITES BYPASS RLS BY DESIGN.
 *
 * Allowed callers: the Stripe webhook route, the checkout/portal routes (customer
 * binding), the catalog loader, the entitlement guard's usage counter, and
 * admin-only provisioning. NEVER import this from a Client Component — the
 * `server-only` guard below turns that mistake into a build error instead of a
 * leaked credential.
 */
import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdminEnv } from '@/env';
import type { Database } from './database.types';

let cached: SupabaseClient<Database> | undefined;

export function supabaseAdmin(): SupabaseClient<Database> {
  if (cached) return cached;

  const { url, serviceRoleKey } = supabaseAdminEnv();

  cached = createClient<Database>(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { 'x-assetscout-client': 'server-admin' },
    },
  });

  return cached;
}