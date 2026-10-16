// tests/batchLock.test.ts
//
// Pins the single-flight batch lock (red-team finding F-01) and the /api/batch
// behaviour built on it.
//
// The bug this prevents: rotation pointers are read-modify-write, so two
// overlapping batches for one brand read the same index, pick the same base and
// advance to the same next index — duplicate renders against an append-only
// gallery, permanently skipped assets, duplicate catalog spend. The cron and
// the phone button are both live triggers, so overlap is normal operation.
//
// Behaviours pinned:
//   1. Free slot       → claimed.
//   2. 23505 + live    → busy (and the route answers 409, orchestrator NOT run).
//   3. 23505 + stale   → the corpse is retired and the claim is retried once.
//   4. Lock unusable   → 'unavailable' (batch still runs, LOUDLY) — a missing
//                        migration must not be able to stop D's own pipeline,
//                        but it must never be silent either.
//   5. Finalize failures never throw into the route.

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface RunRow {
  id: string;
  brand: string;
  status: string;
  started_at: number;
  finished_at: number | null;
  queued: number | null;
  note: string | null;
}

interface InsertError {
  code?: string;
  message: string;
}

interface FakeOptions {
  runs: RunRow[];
  /** Errors returned by successive insert() calls; the last one repeats. */
  insertErrorQueue?: Array<InsertError | null>;
  throwOnFrom?: boolean;
}

const updates: Array<{ filters: Array<[string, unknown]>; patch: Record<string, unknown> }> = [];
const inserts: Array<Record<string, unknown>> = [];

function makeFake(opts: FakeOptions) {
  const queue = opts.insertErrorQueue ? [...opts.insertErrorQueue] : [];

  const match = (filters: Array<[string, unknown]>) =>
    opts.runs.filter((r) =>
      filters.every(([c, v]) => (r as unknown as Record<string, unknown>)[c] === v),
    );

  function chain(patch: Record<string, unknown> | null) {
    const filters: Array<[string, unknown]> = [];
    const api = {
      eq(col: string, val: unknown) {
        filters.push([col, val]);
        return api;
      },
      order() {
        return api;
      },
      limit() {
        return api;
      },
      select() {
        return api;
      },
      maybeSingle() {
        if (patch) throw new Error('maybeSingle after update is not used by this code');
        return Promise.resolve({ data: match(filters)[0] ?? null, error: null });
      },
      then(
        resolve: (v: unknown) => unknown,
        reject?: (e: unknown) => unknown,
      ): PromiseLike<unknown> {
        if (patch) {
          updates.push({ filters: [...filters], patch });
          const matched = match(filters);
          for (const row of matched) Object.assign(row, patch);
          return Promise.resolve({ data: matched.map((m) => ({ id: m.id })), error: null }).then(
            resolve,
            reject,
          );
        }
        return Promise.resolve({ data: match(filters), error: null }).then(resolve, reject);
      },
    };
    return api;
  }

  return {
    from(table: string) {
      if (table !== 'batch_runs') throw new Error(`unexpected table ${table}`);
      if (opts.throwOnFrom) throw new Error('supabase client not configured');

      return {
        insert(row: Record<string, unknown>) {
          inserts.push(row);
          const queued = queue.length > 1 ? queue.shift() ?? null : (queue[0] ?? null);
          if (queued) return Promise.resolve({ error: queued });
          opts.runs.push({
            id: String(row.id),
            brand: String(row.brand),
            status: String(row.status),
            started_at: Number(row.started_at),
            finished_at: null,
            queued: null,
            note: null,
          });
          return Promise.resolve({ error: null });
        },
        select() {
          return chain(null);
        },
        update(patch: Record<string, unknown>) {
          return chain(patch);
        },
      };
    },
  };
}

const state: { client: unknown } = { client: null };
const assembleReviewBatch = vi.fn();
const verifyUserJwt = vi.fn();

vi.mock('../src/lib/supabaseClient', () => ({
  getSupabaseAdmin: () => state.client,
  verifyUserJwt: (...args: unknown[]) => verifyUserJwt(...args),
  _resetSupabaseAdminForTesting: vi.fn(),
}));

vi.mock('../src/lib/orchestrator', () => ({
  assembleReviewBatch: (...args: unknown[]) => assembleReviewBatch(...args),
}));

import { claimBatchRun, finishBatchRun, STALE_RUN_MS } from '../src/lib/batch/batchLock';
import { NextRequest } from 'next/server';

const BATCH_URL = 'https://media-engine.example.com/api/batch?brand=misfit';

function liveRun(ageMs: number): RunRow {
  return {
    id: 'run-live',
    brand: 'misfit',
    status: 'running',
    started_at: Date.now() - ageMs,
    finished_at: null,
    queued: null,
    note: null,
  };
}

describe('claimBatchRun', () => {
  beforeEach(() => {
    inserts.length = 0;
    updates.length = 0;
  });

  it('claims a free slot', async () => {
    const runs: RunRow[] = [];
    state.client = makeFake({ runs });

    const claim = await claimBatchRun('misfit');
    expect(claim.status).toBe('claimed');
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('running');
  });

  it('refuses when a live run holds the slot', async () => {
    const runs = [liveRun(60_000)];
    state.client = makeFake({ runs, insertErrorQueue: [{ code: '23505', message: 'duplicate key' }] });

    const claim = await claimBatchRun('misfit');
    expect(claim.status).toBe('busy');
    if (claim.status === 'busy') {
      expect(claim.runId).toBe('run-live');
      expect(claim.ageMs).toBeGreaterThan(50_000);
    }
    expect(updates).toHaveLength(0); // nothing was retired
  });

  it('retires a stale corpse and retries the claim once', async () => {
    const runs = [liveRun(STALE_RUN_MS + 60_000)];
    // First insert collides (slot held), the retry after retirement succeeds.
    state.client = makeFake({
      runs,
      insertErrorQueue: [{ code: '23505', message: 'duplicate key' }, null],
    });

    const claim = await claimBatchRun('misfit');
    expect(claim.status).toBe('claimed');
    expect(updates.some((u) => u.patch.status === 'error')).toBe(true);
    expect(runs.filter((r) => r.status === 'running')).toHaveLength(1);
    expect(runs.find((r) => r.status === 'error')?.note).toContain('stale');
  });

  it('reports unavailable (never throws) when the table or client is missing', async () => {
    state.client = makeFake({ runs: [], throwOnFrom: true });
    const claim = await claimBatchRun('misfit');
    expect(claim.status).toBe('unavailable');
  });

  it('reports unavailable for a non-23505 database error', async () => {
    state.client = makeFake({
      runs: [],
      insertErrorQueue: [{ code: '42P01', message: 'relation "batch_runs" does not exist' }],
    });
    const claim = await claimBatchRun('misfit');
    expect(claim.status).toBe('unavailable');
    if (claim.status === 'unavailable') expect(claim.reason).toContain('42P01');
  });
});

describe('finishBatchRun', () => {
  it('closes the row out and never throws', async () => {
    const runs = [liveRun(1000)];
    state.client = makeFake({ runs });

    const result = await finishBatchRun('run-live', 'done', { queued: 3 });
    expect(result.ok).toBe(true);
    expect(runs[0].status).toBe('done');
    expect(runs[0].queued).toBe(3);
  });

  it('returns a warning instead of throwing when the client explodes', async () => {
    state.client = { from: () => { throw new Error('boom'); } };
    const result = await finishBatchRun('run-live', 'error');
    expect(result.ok).toBe(false);
    expect(result.warning).toContain('boom');
  });
});

describe('/api/batch with the lock', () => {
  const OLD = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    inserts.length = 0;
    updates.length = 0;
    process.env.CRON_SECRET = 'cron-secret';
    verifyUserJwt.mockResolvedValue(null);
    assembleReviewBatch.mockResolvedValue({ batchId: 'b1', queued: 2, laneOutcomes: {} });
  });

  it('answers 409 and does NOT run the batch when another run holds the slot', async () => {
    state.client = makeFake({
      runs: [liveRun(120_000)],
      insertErrorQueue: [{ code: '23505', message: 'duplicate key' }],
    });

    const { GET } = await import('../src/app/api/batch/route');
    const res = await GET(
      new NextRequest(BATCH_URL, { method: 'GET', headers: { authorization: 'Bearer cron-secret' } }),
    );
    const body = (await res.json()) as { error: string; ageMinutes: number };

    expect(res.status).toBe(409);
    expect(body.error).toBe('batch_already_running');
    expect(body.ageMinutes).toBeGreaterThan(1);
    expect(assembleReviewBatch).not.toHaveBeenCalled();
    process.env = { ...OLD };
  });

  it('runs anyway when the lock is unavailable, and says so in the response', async () => {
    state.client = makeFake({ runs: [], insertErrorQueue: [{ code: '42P01', message: 'no table' }] });

    const { GET } = await import('../src/app/api/batch/route');
    const res = await GET(
      new NextRequest(BATCH_URL, { method: 'GET', headers: { authorization: 'Bearer cron-secret' } }),
    );
    const body = (await res.json()) as { lock: { status: string; reason?: string } };

    expect(res.status).toBe(200);
    expect(body.lock.status).toBe('unavailable');
    expect(body.lock.reason).toContain('42P01');
    expect(assembleReviewBatch).toHaveBeenCalled();
    process.env = { ...OLD };
  });

  it('finalizes the claimed row as done after a successful batch', async () => {
    const runs: RunRow[] = [];
    state.client = makeFake({ runs });

    const { GET } = await import('../src/app/api/batch/route');
    const res = await GET(
      new NextRequest(BATCH_URL, { method: 'GET', headers: { authorization: 'Bearer cron-secret' } }),
    );
    const body = (await res.json()) as { lock: { status: string; finalized: boolean } };

    expect(res.status).toBe(200);
    expect(body.lock.status).toBe('held');
    expect(body.lock.finalized).toBe(true);
    expect(runs[0].status).toBe('done');
    expect(runs[0].queued).toBe(2);
    process.env = { ...OLD };
  });

  it('finalizes the claimed row as error when the batch throws', async () => {
    const runs: RunRow[] = [];
    state.client = makeFake({ runs });
    assembleReviewBatch.mockRejectedValue(new Error('renderer exploded'));

    const { GET } = await import('../src/app/api/batch/route');
    const res = await GET(
      new NextRequest(BATCH_URL, { method: 'GET', headers: { authorization: 'Bearer cron-secret' } }),
    );

    expect(res.status).toBe(500);
    expect(runs[0].status).toBe('error');
    expect(runs[0].note).toContain('renderer exploded');
    process.env = { ...OLD };
  });
});
