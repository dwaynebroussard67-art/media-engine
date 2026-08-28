// src/lib/browserSupabase.ts
// Lazily-initialized anon-key browser client, shared by client pages.
//
// MUST stay lazy (called inside effects/handlers, never at module scope):
// `next build` prerenders client pages, and a module-scope createClient
// with unset NEXT_PUBLIC_* vars throws "supabaseUrl is required" — that
// exact bug broke production builds once already (see DEBUG-REPORT).
// ANON key only — never the service role.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;

export function browserSupabase(): SupabaseClient {
  if (!_client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) {
      throw new Error(
        'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set'
      );
    }
    _client = createClient(url, key);
  }
  return _client;
}
