// ============================================================================
// SYNC SERVICE — the bridge between the local store and Supabase.
// Everything is best-effort: if Supabase is down or unconfigured, the app keeps
// working locally and simply doesn't sync. Nothing here can crash the UI.
// ============================================================================
import { supabase, supabaseEnabled } from './supabaseClient';
import type { TasteEvent } from './tasteMemory';
import type { PostBatch } from '../store/useStore';

export const syncEnabled = supabaseEnabled;

// ---- BATCHES ---------------------------------------------------------------
// The Vercel cron writes autonomous batches into `media_batches`. The app both
// pushes its own generated batches up and pulls the cron's down, so the phone
// and the browser see the same queue.
export async function pushBatch(batch: PostBatch): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from('media_batches').upsert(
      {
        id: batch.id,
        generated_at: new Date(batch.generatedAt).toISOString(),
        hour_slot: batch.hourSlot,
        payload: batch, // full batch as JSONB — schema-tolerant
      },
      { onConflict: 'id' }
    );
  } catch (e) { console.warn('[sync] pushBatch failed (non-fatal):', e); }
}

export async function pullBatches(limit = 60): Promise<PostBatch[]> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('media_batches')
      .select('id, payload')
      .order('generated_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? [])
      .map((r: { payload: PostBatch | null }) => r.payload)
      .filter((p): p is PostBatch => Boolean(p && (p as PostBatch).posts));
  } catch (e) { console.warn('[sync] pullBatches failed (non-fatal):', e); return []; }
}

// ---- STATUS DECISIONS ------------------------------------------------------
// A decision is a fact about a specific post/merch item. Upsert by id so the
// latest status wins, but the taste ledger below keeps the full history.
export async function pushDecision(
  itemId: string, itemType: 'post' | 'merch', status: string, notes?: string
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from('media_decisions').upsert(
      { item_id: itemId, item_type: itemType, status, notes: notes ?? null, decided_at: new Date().toISOString() },
      { onConflict: 'item_id' }
    );
  } catch (e) { console.warn('[sync] pushDecision failed (non-fatal):', e); }
}

// ---- TASTE LEDGER (append-only — NOTHING auto-deletes) ---------------------
export async function pushTasteEvents(events: TasteEvent[]): Promise<void> {
  if (!supabase || events.length === 0) return;
  try {
    await supabase.from('taste_events').insert(
      events.map((e) => ({
        id: e.id, brand: e.brand, kind: e.kind, value: e.value,
        decision: e.decision, at: new Date(e.at).toISOString(), source_id: e.sourceId,
      }))
    );
  } catch (e) { console.warn('[sync] pushTasteEvents failed (non-fatal):', e); }
}

export async function pullTasteEvents(): Promise<TasteEvent[]> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('taste_events')
      .select('id, brand, kind, value, decision, at, source_id')
      .order('at', { ascending: false })
      .limit(5000);
    if (error) throw error;
    return (data ?? []).map((r: Record<string, unknown>) => ({
      id: String(r.id), brand: r.brand as TasteEvent['brand'], kind: r.kind as TasteEvent['kind'],
      value: String(r.value), decision: r.decision as TasteEvent['decision'],
      at: new Date(String(r.at)).getTime(), sourceId: String(r.source_id),
    }));
  } catch (e) { console.warn('[sync] pullTasteEvents failed (non-fatal):', e); return []; }
}
