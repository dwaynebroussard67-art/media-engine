// src/lib/supabaseClient.ts
// Lazily-initialized, purpose-scoped Supabase clients.
//
//   getSupabaseAdmin() — service role, for server-side DB and Storage operations.
//                        Never expose to the browser.
//   verifyUserJwt()    — validates a caller JWT via an anon-key client (the
//                        correct verification path; service role bypasses auth).
//
// Env vars are read at first use, not at import time, so pure-logic test
// suites can import modules from this tree without a live Supabase env.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Typed configuration error — thrown when a required Supabase env var is
 * missing. API routes map this to a 503 with an actionable message instead
 * of surfacing a raw `Missing required env var` 500.
 */
export class SupabaseNotConfiguredError extends Error {
  public readonly missingVars: string[];

  constructor(missingVars: string[]) {
    super(
      `Supabase is not configured on the server. Missing env: ${missingVars.join(', ')}. ` +
      `Set these values in the deployment (see .env.example).`,
    );
    this.name = 'SupabaseNotConfiguredError';
    this.missingVars = missingVars;
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new SupabaseNotConfiguredError([name]);
  return v;
}

let _admin: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (!_admin) {
    _admin = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _admin;
}

export async function verifyUserJwt(
  bearerToken: string,
): Promise<{ id: string; email?: string } | null> {
  const anonClient = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_ANON_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${bearerToken}` } },
  });
  const { data, error } = await anonClient.auth.getUser();
  if (error || !data.user) return null;
  return data.user.email ? { id: data.user.id, email: data.user.email } : { id: data.user.id };
}

/**
 * Resets the cached admin client. Test isolation only — never call in
 * production code.
 * @internal
 */
export function _resetSupabaseAdminForTesting(): void {
  _admin = null;
}
