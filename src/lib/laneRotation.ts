// src/lib/laneRotation.ts
// Persistent per-scope rotation pointers (lane_rotation_state).
// Scope convention: `${lane}:${brand}` — one row per lane per brand, so lanes
// never fight over a shared pointer. safeMod normalization happens in
// selectDeterministicBase; this module only stores/loads the raw index.

import { getSupabaseAdmin } from './supabaseClient';

export async function getLaneRotationIndex(scope: string): Promise<number> {
  const { data, error } = await getSupabaseAdmin()
    .from('lane_rotation_state')
    .select('last_used_index')
    .eq('scope', scope)
    .maybeSingle();

  if (error) {
    throw new Error(`[laneRotation.get] "${scope}": ${error.message}`);
  }
  return (data as { last_used_index: number } | null)?.last_used_index ?? -1;
}

export async function advanceLaneRotation(scope: string, index: number): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from('lane_rotation_state')
    .upsert(
      { scope, last_used_index: index, updated_at: Date.now() },
      { onConflict: 'scope' },
    );

  if (error) {
    throw new Error(`[laneRotation.advance] "${scope}": ${error.message}`);
  }
}
