import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Vite exposes only VITE_-prefixed vars to the browser. The ANON key is safe to
// ship to the client; row-level security on Supabase is what protects the data.
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// If env isn't wired yet, the app still runs fully on local (zustand/localStorage).
// Supabase just becomes a no-op until the keys are set. Nothing breaks.
export const supabaseEnabled = Boolean(url && anon);

export const supabase: SupabaseClient | null = supabaseEnabled
  ? createClient(url as string, anon as string, { auth: { persistSession: false } })
  : null;

if (!supabaseEnabled && typeof window !== 'undefined') {
  console.info('[supabase] no VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — running local-only.');
}
