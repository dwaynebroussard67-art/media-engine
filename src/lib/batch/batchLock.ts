// src/lib/batch/batchLock.ts
//
// Single-flight batch runs, backed by `batch_runs` (migration 004).
//
// Problem this closes (red-team finding F-01): rotation pointers are
// read-modify-write. Two overlapping batches for the same brand both read the
// same index, both pick the same base, both write the same next index —
// duplicate renders against an append-only gallery, skipped assets, duplicate
// API spend. The cron and the phone button are both live triggers, so
// overlap is a normal Tuesday, not an edge case.
//
// Design (matches the repo's existing posture):
//   - The Postgres partial unique index is the AUTHORITY, not the app
//     (same pattern as media_decisions / remix_queue finality).
//   - Refuse-rather-than-err: a live run means 409 "busy", not a silent
//     overlap and not a corrupted rotation pointer.
//   - Degrade loudly, never silently: if migration 004 has not been applied
//     yet, the batch still runs (D must not be blocked from his own pipeline
//     by a missing migration) but the caller receives an explicit
//     `unavailable` claim with the reason, and the setup UI screams about it.
//   - Stale locks self-heal: a Vercel function that is killed mid-batch never
//     finalizes its row. Without a staleness window the brand would be locked
//     out forever — a worse failure than the race. Claims older than
//     STALE_RUN_MS are retired (guarded UPDATE) and the claim is retried once.

import { randomUUID } from 'crypto';
import { getSupabaseAdmin } from '../supabaseClient';
import type { Brand } from '../../types/media';

/** A run older than this is presumed dead (function killed before finalize). */
export const STALE_RUN_MS = 15 * 60 * 1000;

export interface BatchRunRow {
  id: string;
  brand: Brand;
  status: 'running' | 'done' | 'error';
  started_at: number;
  finished_at: number | null;
  queued: number | null;
  note: string | null;
}

export type BatchRunClaim =
  | { status: 'claimed'; runId: string; startedAt: number }
  | { status: 'busy'; runId?: string; startedAt?: number; ageMs?: number; staleRetired?: boolean }
  | { status: 'unavailable'; reason: string };

function pgCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code ?? '')
    : undefined;
}

function pgMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message?: unknown }).message ?? 'unknown error');
  }
  return err instanceof Error ? err.message : String(err);
}

async function findRunning(brand: Brand): Promise<BatchRunRow | undefined> {
  const { data } = await getSupabaseAdmin()
    .from('batch_runs')
    .select('*')
    .eq('brand', brand)
    .eq('status', 'running')
    .maybeSingle();
  return (data as BatchRunRow | null) ?? undefined;
}

/** INSERTs the lock row. Returns the raw outcome so callers can classify. */
async function tryInsert(brand: Brand): Promise<
  { ok: true; runId: string; startedAt: number } | { ok: false; code?: string; message: string }
> {
  const runId = randomUUID();
  const startedAt = Date.now();

  try {
    const { error } = await getSupabaseAdmin()
      .from('batch_runs')
      .insert({ id: runId, brand, status: 'running', started_at: startedAt });

    if (error) {
      return { ok: false, code: pgCode(error), message: pgMessage(error) };
    }
    return { ok: true, runId, startedAt };
  } catch (err) {
    // Thrown (not returned) — e.g. the client could not be constructed at all.
    return { ok: false, code: pgCode(err), message: pgMessage(err) };
  }
}

/**
 * Attempts to claim the single running slot for `brand`.
 * Never throws: the caller always gets a verdict it can act on.
 */
export async function claimBatchRun(brand: Brand): Promise<BatchRunClaim> {
  const first = await tryInsert(brand);

  if (first.ok) {
    return { status: 'claimed', runId: first.runId, startedAt: first.startedAt };
  }

  if (first.code !== '23505') {
    // Missing table (42P01), RLS, permissions, network — the lock is
    // unavailable. Report it; the caller decides (we proceed, loudly).
    return { status: 'unavailable', reason: `${first.code ?? 'no-code'}: ${first.message}` };
  }

  // Slot taken. Is the holder still alive?
  let running: BatchRunRow | undefined;
  try {
    running = await findRunning(brand);
  } catch {
    running = undefined;
  }

  const ageMs = running ? Date.now() - Number(running.started_at) : undefined;

  if (running && ageMs !== undefined && ageMs > STALE_RUN_MS) {
    // Retire the corpse, guarded on the exact row we read so a concurrent
    // finalize cannot be clobbered into a false 'error'.
    try {
      await getSupabaseAdmin()
        .from('batch_runs')
        .update({
          status: 'error',
          finished_at: Date.now(),
          note: `stale: no finalize within ${Math.round(STALE_RUN_MS / 60000)} min`,
        })
        .eq('id', running.id)
        .eq('status', 'running');
    } catch {
      /* best effort — fall through to a single retry */
    }

    const retry = await tryInsert(brand);
    if (retry.ok) {
      return { status: 'claimed', runId: retry.runId, startedAt: retry.startedAt };
    }
    return {
      status: 'busy',
      runId: running.id,
      startedAt: Number(running.started_at),
      ...(ageMs !== undefined ? { ageMs } : {}),
      staleRetired: true,
    };
  }

  return {
    status: 'busy',
    ...(running ? { runId: running.id, startedAt: Number(running.started_at) } : {}),
    ...(ageMs !== undefined ? { ageMs } : {}),
  };
}

/** Closes out a claimed run. Best effort — never throws. */
export async function finishBatchRun(
  runId: string,
  status: 'done' | 'error',
  opts: { queued?: number; note?: string } = {},
): Promise<{ ok: boolean; warning?: string }> {
  try {
    const { error } = await getSupabaseAdmin()
      .from('batch_runs')
      .update({
        status,
        finished_at: Date.now(),
        queued: opts.queued ?? null,
        note: opts.note ?? null,
      })
      .eq('id', runId);

    if (error) {
      return { ok: false, warning: `batch_runs finalize failed: ${pgMessage(error)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, warning: `batch_runs finalize threw: ${pgMessage(err)}` };
  }
}

/** Forces a stuck 'running' row closed. Used by the setup UI's escape hatch. */
export async function forceReleaseRun(
  brand: Brand,
): Promise<{ ok: boolean; released: number; error?: string }> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from('batch_runs')
      .update({
        status: 'error',
        finished_at: Date.now(),
        note: 'released by operator from /setup',
      })
      .eq('brand', brand)
      .eq('status', 'running')
      .select('id');

    if (error) return { ok: false, released: 0, error: pgMessage(error) };
    return { ok: true, released: Array.isArray(data) ? data.length : 0 };
  } catch (err) {
    return { ok: false, released: 0, error: pgMessage(err) };
  }
}

export interface RecentRunsResult {
  ok: boolean;
  runs: BatchRunRow[];
  error?: string;
}

/** Most recent runs, newest first. Used by /setup and available for /api/status. */
export async function listRecentRuns(limit = 10): Promise<RecentRunsResult> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from('batch_runs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(limit);

    if (error) return { ok: false, runs: [], error: pgMessage(error) };
    return { ok: true, runs: (data ?? []) as BatchRunRow[] };
  } catch (err) {
    return { ok: false, runs: [], error: pgMessage(err) };
  }
}
