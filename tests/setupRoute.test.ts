// tests/setupRoute.test.ts
//
// Tests for /api/setup and the probes behind it.
//
// Pinned behaviours:
//   1. Auth matrix. `whoami` is the ONE action a merely-authenticated caller
//      may run — that escape hatch is what makes day-one setup possible
//      (without it, the allowlist gate locks you out of the screen that tells
//      you the value to put in the allowlist). Everything else requires the
//      writer allowlist, and an EMPTY allowlist means nobody: fails closed.
//   2. The database probe surfaces table-level failures and the
//      `oracle_result->>passed` jsonb filter failure WITHOUT throwing.
//   3. The storage probe reports a non-public bucket as a failure with the fix.
//   4. Bad input is rejected before any work happens.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Fake PostgREST/storage surface ───────────────────────────────────────────

interface FakeState {
  counts: Record<string, number>;
  errors: Record<string, string | null>;
  rows: Record<string, unknown[]>;
  storageUploadError?: string | null;
  throwOnFrom?: string | null;
}

const state: FakeState = { counts: {}, errors: {}, rows: {} };

function fakeClient() {
  return {
    from(table: string) {
      if (state.throwOnFrom === table) throw new Error(`client exploded on ${table}`);
      const filters: Array<[string, unknown]> = [];
      const api = {
        select(_cols: string, opts?: { head?: boolean }) {
          api._head = Boolean(opts?.head);
          return api;
        },
        _head: false,
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
        maybeSingle() {
          return Promise.resolve({
            data: (state.rows[table] ?? [])[0] ?? null,
            error: state.errors[table] ? { message: state.errors[table] as string } : null,
          });
        },
        then(
          resolve: (v: unknown) => unknown,
          reject?: (e: unknown) => unknown,
        ): PromiseLike<unknown> {
          const err = state.errors[table];
          // Any filter mentioning the jsonb path is the PostgREST check under
          // test; the fake fails it when the state says so.
          const isJsonb = filters.some(([c]) => c.includes('oracle_result'));
          const result = err
            ? { data: null, count: null, error: { message: err } }
            : api._head
              ? { count: state.counts[table] ?? 0, data: null, error: null }
              : { data: state.rows[table] ?? [], count: null, error: null };
          if (isJsonb && state.errors['jsonb']) {
            return Promise.resolve({
              data: null,
              count: null,
              error: { message: state.errors['jsonb'] as string },
            }).then(resolve, reject);
          }
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return api;
    },
    storage: {
      from() {
        return {
          upload: () =>
            Promise.resolve({ error: state.storageUploadError ? { message: state.storageUploadError } : null }),
          remove: () => Promise.resolve({ error: null }),
          getPublicUrl: (path: string) => ({
            data: { publicUrl: `https://proj.supabase.co/storage/v1/object/public/media-engine/${path}` },
          }),
        };
      },
    },
  };
}

const verifyUserJwt = vi.fn();
const printifySearch = vi.fn();

vi.mock('../src/lib/supabaseClient', () => ({
  getSupabaseAdmin: () => fakeClient(),
  verifyUserJwt: (...args: unknown[]) => verifyUserJwt(...args),
  _resetSupabaseAdminForTesting: vi.fn(),
}));

vi.mock('../src/lib/merch/printifyClient', () => ({
  printifyClient: { search: (...args: unknown[]) => printifySearch(...args) },
}));

import { NextRequest } from 'next/server';

const USER = { id: 'user-123', email: 'd@example.com' };

function req(body: unknown, opts: { token?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return new NextRequest('https://media-engine.example.com/api/setup', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

const OLD_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...OLD_ENV };
  process.env.SUPABASE_URL = 'https://proj.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
  process.env.GALLERY_WRITER_IDS = '';
  delete (state as Partial<FakeState>).storageUploadError;
  state.counts = {};
  state.errors = {};
  state.rows = {};
  verifyUserJwt.mockResolvedValue(USER);
  printifySearch.mockResolvedValue([]);
});

afterEach(() => {
  process.env = { ...OLD_ENV };
});

describe('POST /api/setup — auth matrix', () => {
  it('400s on an unknown action', async () => {
    const { POST } = await import('../src/app/api/setup/route');
    const res = await POST(req({ action: 'drop-everything' }, { token: 't' }));
    expect(res.status).toBe(400);
  });

  it('401s without a token', async () => {
    const { POST } = await import('../src/app/api/setup/route');
    const res = await POST(req({ action: 'probe-db' }));
    expect(res.status).toBe(401);
  });

  it('401s on an invalid token', async () => {
    verifyUserJwt.mockResolvedValue(null);
    const { POST } = await import('../src/app/api/setup/route');
    const res = await POST(req({ action: 'probe-db' }, { token: 'bad' }));
    expect(res.status).toBe(401);
  });

  it('answers whoami WITHOUT the allowlist, and hands back the env line', async () => {
    const { POST } = await import('../src/app/api/setup/route');
    const res = await POST(req({ action: 'whoami' }, { token: 't' }));
    const body = (await res.json()) as {
      ok: boolean;
      userId: string;
      inAllowlist: boolean;
      envLine: string;
      allowlistCount: number;
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.userId).toBe('user-123');
    expect(body.inAllowlist).toBe(false);
    expect(body.allowlistCount).toBe(0);
    expect(body.envLine).toBe('GALLERY_WRITER_IDS=user-123');
  });

  it('403s (allowlist empty) on every other action, and says why', async () => {
    const { POST } = await import('../src/app/api/setup/route');
    const res = await POST(req({ action: 'probe-db' }, { token: 't' }));
    const body = (await res.json()) as { error: string; hint: string };

    expect(res.status).toBe(403);
    expect(body.error).toBe('forbidden_allowlist_empty');
    expect(body.hint).toContain('redeploy');
  });

  it('403s when the account is not in a non-empty allowlist', async () => {
    process.env.GALLERY_WRITER_IDS = 'someone-else';
    const { POST } = await import('../src/app/api/setup/route');
    const res = await POST(req({ action: 'probe-db' }, { token: 't' }));
    const body = (await res.json()) as { error: string; userId: string };

    expect(res.status).toBe(403);
    expect(body.error).toBe('forbidden_not_allowlisted');
    expect(body.userId).toBe('user-123');
  });

  it('runs the database probe for an allowlisted writer', async () => {
    process.env.GALLERY_WRITER_IDS = 'user-123';
    state.counts = { gallery_assets: 4, rotation_state: 1, text_rotation_state: 1, lane_rotation_state: 1, review_queue: 2, media_decisions: 3, remix_queue: 0, batch_runs: 1 };
    state.rows = { gallery_assets: [{ brand: 'misfit', category: 'atmosphere' }] };

    const { POST } = await import('../src/app/api/setup/route');
    const res = await POST(req({ action: 'probe-db' }, { token: 't' }));
    const body = (await res.json()) as {
      ok: boolean;
      database: { ok: boolean; tables: Array<{ table: string; ok: boolean; count?: number }>; jsonbFilter: { ok: boolean } };
      bases: { byBrand: Record<string, { freshTextBases: number }> };
    };

    expect(res.status).toBe(200);
    expect(body.database.ok).toBe(true);
    expect(body.database.tables.find((t) => t.table === 'batch_runs')?.ok).toBe(true);
    expect(body.database.tables.find((t) => t.table === 'gallery_assets')?.count).toBe(4);
    expect(body.bases.byBrand.misfit.freshTextBases).toBe(1);
  });
});

describe('probes — failure directions are visible, never thrown', () => {
  it('reports a missing table with the migration that creates it', async () => {
    process.env.GALLERY_WRITER_IDS = 'user-123';
    state.errors = { lane_rotation_state: 'relation "public.lane_rotation_state" does not exist' };

    const { POST } = await import('../src/app/api/setup/route');
    const res = await POST(req({ action: 'probe-db' }, { token: 't' }));
    const body = (await res.json()) as {
      database: { ok: boolean; tables: Array<{ table: string; ok: boolean; error?: string; createdBy: string }> };
    };

    expect(res.status).toBe(200);
    const row = body.database.tables.find((t) => t.table === 'lane_rotation_state');
    expect(row?.ok).toBe(false);
    expect(row?.createdBy).toContain('003');
    expect(body.database.ok).toBe(false);
  });

  it('flags the unverified jsonb path filter when PostgREST rejects it', async () => {
    process.env.GALLERY_WRITER_IDS = 'user-123';
    state.errors = { jsonb: 'unexpected ">" in path' };

    const { POST } = await import('../src/app/api/setup/route');
    const res = await POST(req({ action: 'probe-db' }, { token: 't' }));
    const body = (await res.json()) as {
      database: { jsonbFilter: { ok: boolean; detail: string } };
    };

    expect(body.database.jsonbFilter.ok).toBe(false);
    expect(body.database.jsonbFilter.detail).toContain('GET /api/review');
  });

  it('reports a non-public bucket as a failure with the fix attached', async () => {
    process.env.GALLERY_WRITER_IDS = 'user-123';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
    });
    vi.stubGlobal('fetch', fetchMock);

    const { POST } = await import('../src/app/api/setup/route');
    const res = await POST(req({ action: 'probe-storage' }, { token: 't' }));
    const body = (await res.json()) as {
      ok: boolean;
      storage: { ok: boolean; steps: Array<{ name: string; ok: boolean }>; warnings: string[] };
    };

    expect(res.status).toBe(200);
    expect(body.storage.ok).toBe(false);
    expect(body.storage.steps.find((s) => s.name === 'public_read')?.ok).toBe(false);
    expect(body.storage.warnings.join(' ')).toContain('PUBLIC');
    vi.unstubAllGlobals();
  });

  it('classifies a catalog outage without throwing (sourcing converts it later)', async () => {
    process.env.GALLERY_WRITER_IDS = 'user-123';
    printifySearch.mockRejectedValue(new Error('Printify API returned HTTP 401'));

    const { POST } = await import('../src/app/api/setup/route');
    const res = await POST(req({ action: 'probe-printify', query: 'misfit tee' }, { token: 't' }));
    const body = (await res.json()) as { ok: boolean; printify: { ok: boolean; error?: string } };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.printify.error).toContain('401');
  });
});

describe('POST /api/setup — input validation', () => {
  beforeEach(() => {
    process.env.GALLERY_WRITER_IDS = 'user-123';
  });

  it('400s on smoke-render without a brand', async () => {
    const { POST } = await import('../src/app/api/setup/route');
    const res = await POST(req({ action: 'smoke-render' }, { token: 't' }));
    const body = (await res.json()) as { error: string };
    expect(res.status).toBe(400);
    expect(body.error).toContain('brand');
  });

  it('400s on bootstrap-backdrop with an unknown brand', async () => {
    const { POST } = await import('../src/app/api/setup/route');
    const res = await POST(req({ action: 'bootstrap-backdrop', brand: 'nike' }, { token: 't' }));
    expect(res.status).toBe(400);
  });

  it('409s when the backdrop is refused because the gallery is not empty', async () => {
    state.rows = {
      gallery_assets: [{ brand: 'misfit', category: 'art' }],
    };

    const { POST } = await import('../src/app/api/setup/route');
    const res = await POST(req({ action: 'bootstrap-backdrop', brand: 'misfit' }, { token: 't' }));
    const body = (await res.json()) as { ok: boolean; error: string };

    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.error).toContain('Refused');
  });

  it('returns a non-fatal "nothing to verify yet" verdict for the loop check', async () => {
    state.rows = { media_decisions: [] };

    const { POST } = await import('../src/app/api/setup/route');
    const res = await POST(req({ action: 'verify-loop' }, { token: 't' }));
    const body = (await res.json()) as { status: string; detail: string };

    expect(res.status).toBe(200);
    expect(body.status).toBe('no_post_decisions');
    expect(body.detail).toContain('not a failure');
  });
});
