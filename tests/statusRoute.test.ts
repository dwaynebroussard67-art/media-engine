// tests/statusRoute.test.ts
//
// Tests for GET /api/status — the dashboard status endpoint.
//
// Pinned behaviors:
//   1. Happy path: all sections populated, ok=true.
//   2. Per-section error isolation: one section failing (e.g. the
//      oracle_result->>passed filter misbehaving on live PostgREST) must
//      NOT sink the payload — the section is null, the error surfaces in
//      `errors`, and every other section still loads. The dashboard must
//      render even when the backend is partially broken.
//   3. No Supabase env: config-only response, no DB calls, errors.config set.
//   4. Config flags are presence booleans derived from env names.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Thenable fake of the Supabase query builder ───────────────────────────────
// Supports the exact chain shapes /api/status uses:
//   .select('*', { count:'exact', head:true }) [.eq(...)] [.gte(...)]  → count
//   .select(cols).order(...).limit(n)                                  → rows
//   .select(cols)                                                      → rows

interface TableMock {
  count?: number;
  countError?: string | null;
  rows?: unknown[];
  listError?: string | null;
}

type Result = { data?: unknown; count?: number | null; error: { message: string } | null };

class FakeQuery implements PromiseLike<Result> {
  private head = false;
  constructor(private readonly table: TableMock) {}

  select(_cols: string, opts?: { count?: string; head?: boolean }): this {
    if (opts?.head) this.head = true;
    return this;
  }
  eq(): this {
    return this;
  }
  gte(): this {
    return this;
  }
  order(): this {
    return this;
  }
  limit(): this {
    return this;
  }
  then<R1 = Result, R2 = never>(
    onFulfilled?: ((value: Result) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): PromiseLike<R1 | R2> {
    const result: Result = this.head
      ? { count: this.table.count ?? 0, error: this.table.countError ? { message: this.table.countError } : null }
      : { data: this.table.rows ?? [], error: this.table.listError ? { message: this.table.listError } : null };
    return Promise.resolve(result).then(onFulfilled, onRejected);
  }
}

function makeDb(tables: Record<string, TableMock>) {
  return {
    from: (name: string) => {
      const t = tables[name];
      if (!t) throw new Error(`unexpected table ${name}`);
      return new FakeQuery(t);
    },
  };
}

const state = { db: makeDb({}) };

vi.mock('../src/lib/supabaseClient', () => ({
  getSupabaseAdmin: () => state.db,
  verifyUserJwt: vi.fn(),
  _resetSupabaseAdminForTesting: vi.fn(),
}));

import { GET } from '../src/app/api/status/route';

const happyTables: Record<string, TableMock> = {
  review_queue: { count: 3 },
  gallery_assets: { count: 24 },
  media_decisions: {
    count: 57,
    rows: [
      { item_id: 'i1', decision: 'post', brand: 'misfit', lane: 'recombination', decided_at: 1000 },
    ],
  },
  remix_queue: { count: 2 },
  rotation_state: { rows: [{ brand: 'misfit', last_used_asset_id: 'a1', last_used_index: 4 }] },
  text_rotation_state: { rows: [{ brand: 'forge', last_used_index: 2 }] },
  lane_rotation_state: { rows: [{ scope: 'fresh_text_card:misfit', last_used_index: 6 }] },
};

describe('GET /api/status', () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://x.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://x.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    process.env.PRINTIFY_API_KEY = 'pk';
    process.env.PRINTIFY_SHOP_ID = 'shop';
    process.env.CRON_SECRET = 'cron';
    process.env.GALLERY_WRITER_IDS = 'writer-1';
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it('returns ok:true with all sections populated on the happy path', async () => {
    state.db = makeDb(happyTables) as never;

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.errors).toEqual({});
    expect(body.review.misfit).toEqual({ pending: 3, oracleRejected: 3 });
    expect(body.gallery.total).toBe(72); // 24 × 3 brand head-counts
    expect(body.decisions.total).toBe(57);
    expect(body.decisions.recent[0]).toMatchObject({ itemId: 'i1', decision: 'post' });
    expect(body.remixQueue).toBe(2);
    expect(body.rotation.laneRotationState[0]).toEqual({
      scope: 'fresh_text_card:misfit',
      lastUsedIndex: 6,
    });
  });

  it('isolates a failing section: review breaks, everything else still loads', async () => {
    state.db = makeDb({
      ...happyTables,
      review_queue: { countError: 'column oracle_result->>passed does not exist' },
    }) as never;

    const res = await GET();
    const body = await res.json();

    expect(body.ok).toBe(false);
    expect(body.errors.review).toContain('review_queue');
    expect(body.gallery).not.toBeNull();
    expect(body.decisions).not.toBeNull();
    expect(body.remixQueue).toBe(2);
    expect(body.rotation).not.toBeNull();
  });

  it('returns a config-only payload (no DB access) when Supabase env is unset', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    let dbCalled = false;
    state.db = {
      from: () => {
        dbCalled = true;
        throw new Error('DB must not be touched without env');
      },
    } as never;

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(dbCalled).toBe(false);
    expect(body.config.supabaseServer).toBe(false);
    expect(body.errors.config).toContain('SUPABASE_URL');
    expect(body.review).toBeNull();
  });

  it('exposes config flags as booleans only, from env presence', async () => {
    delete process.env.PRINTIFY_API_KEY;
    delete process.env.CRON_SECRET;
    state.db = makeDb(happyTables) as never;

    const body = (await (await GET()).json()) as { config: Record<string, boolean> };

    expect(body.config).toEqual({
      supabaseServer: true,
      supabaseBrowser: true,
      printify: false,
      cronSecret: false,
      galleryWriters: true,
    });
  });
});
