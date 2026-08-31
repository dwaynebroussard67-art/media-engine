// src/app/api/status/route.ts
//
// GET /api/status — one-shot status payload for the home dashboard.
//
// Posture: public read, same as GET /api/review (D is the sole operator;
// add auth if that ever changes). Exposes config presence as BOOLEANS only —
// never secret values.
//
// Failure posture: this endpoint never throws wholesale. Each section
// degrades independently and its error surfaces in `errors` — the dashboard
// must render even when the backend is down or unconfigured. Silent failure
// is forbidden; invisible failure is worse.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '../../../lib/supabaseClient';
import type { Brand } from '../../../types/media';

// ── Response shape ────────────────────────────────────────────────────────────

interface BrandReviewStatus {
  pending: number;
  oracleRejected: number;
}

interface StatusPayload {
  ok: boolean;
  config: {
    supabaseServer: boolean;  // SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
    supabaseBrowser: boolean; // NEXT_PUBLIC_SUPABASE_URL + ANON key
    printify: boolean;        // PRINTIFY_API_KEY + PRINTIFY_SHOP_ID
    cronSecret: boolean;      // CRON_SECRET
    galleryWriters: boolean;  // GALLERY_WRITER_IDS non-empty
  };
  review: Record<Brand, BrandReviewStatus> | null;
  gallery: { misfit: number; forge: number; shared: number; total: number } | null;
  decisions: {
    total: number;
    last24h: number;
    recent: Array<{
      itemId: string;
      decision: 'post' | 'remix' | 'reject';
      brand: Brand;
      lane: string;
      decidedAt: number;
    }>;
  } | null;
  remixQueue: number | null;
  rotation: {
    rotationState: Array<{ brand: string; lastUsedAssetId: string | null; lastUsedIndex: number }>;
    textRotationState: Array<{ brand: string; lastUsedIndex: number }>;
    laneRotationState: Array<{ scope: string; lastUsedIndex: number }>;
  } | null;
  errors: Record<string, string>;
}

// ── Query-chain boundary type ─────────────────────────────────────────────────
// No generated Database types exist for misfit-backend, so read chains are
// untyped at this boundary — the documented `any`-equivalent exception.
// The structural shape is exactly what this route uses; the fake in
// tests/statusRoute.test.ts implements the same shape.

interface QueryResult {
  data?: Array<Record<string, unknown>> | null;
  count?: number | null;
  error: { message: string } | null;
}

type QueryChain = {
  eq(col: string, val: string | number | boolean): QueryChain;
  gte(col: string, val: string | number): QueryChain;
  order(col: string, opts?: { ascending?: boolean }): QueryChain;
  limit(n: number): QueryChain;
} & PromiseLike<QueryResult>;

function from(db: SupabaseClient, table: string): QueryChain {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db.from(table).select('*') as any;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function flag(...names: string[]): boolean {
  return names.every((n) => typeof process.env[n] === 'string' && process.env[n] !== '');
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Head-only exact count — cheap (no rows transferred). Throws on DB error. */
async function headCount(
  db: SupabaseClient,
  table: string,
  build?: (q: QueryChain) => QueryChain
): Promise<number> {
  let q: QueryChain = db
    .from(table)
    .select('*', { count: 'exact', head: true }) as unknown as QueryChain;
  if (build) q = build(q);
  const { count, error } = await q;
  if (error) throw new Error(`[${table}] ${error.message}`);
  return count ?? 0;
}

// ── Sections (each isolated — one failing never sinks the others) ─────────────

async function reviewSection(db: SupabaseClient): Promise<StatusPayload['review']> {
  const brands: Brand[] = ['misfit', 'forge'];
  const out = {} as Record<Brand, BrandReviewStatus>;
  for (const b of brands) {
    // Same filter semantics as GET /api/review: pending + oracle_result->>passed.
    const pending = await headCount(db, 'review_queue', (q) =>
      q.eq('brand', b).eq('status', 'pending').eq('oracle_result->>passed', 'true')
    );
    const oracleRejected = await headCount(db, 'review_queue', (q) =>
      q.eq('brand', b).eq('status', 'pending').eq('oracle_result->>passed', 'false')
    );
    out[b] = { pending, oracleRejected };
  }
  return out;
}

async function gallerySection(db: SupabaseClient): Promise<StatusPayload['gallery']> {
  const misfit = await headCount(db, 'gallery_assets', (q) => q.eq('brand', 'misfit'));
  const forge = await headCount(db, 'gallery_assets', (q) => q.eq('brand', 'forge'));
  const shared = await headCount(db, 'gallery_assets', (q) => q.eq('brand', 'shared'));
  return { misfit, forge, shared, total: misfit + forge + shared };
}

async function decisionsSection(db: SupabaseClient): Promise<StatusPayload['decisions']> {
  const total = await headCount(db, 'media_decisions');
  const last24h = await headCount(db, 'media_decisions', (q) =>
    q.gte('decided_at', Date.now() - 24 * 60 * 60 * 1000)
  );

  let q: QueryChain = db
    .from('media_decisions')
    .select('id,item_id,decision,brand,lane,decided_at') as unknown as QueryChain;
  q = q.order('decided_at', { ascending: false }).limit(8);

  const { data, error } = await q;
  if (error) throw new Error(`[media_decisions] ${error.message}`);

  const recent = (data ?? []).map((row) => ({
    itemId: String(row.item_id),
    decision: row.decision as 'post' | 'remix' | 'reject',
    brand: row.brand as Brand,
    lane: String(row.lane),
    decidedAt: Number(row.decided_at),
  }));

  return { total, last24h, recent };
}

async function remixSection(db: SupabaseClient): Promise<number> {
  return headCount(db, 'remix_queue');
}

async function rotationSection(db: SupabaseClient): Promise<StatusPayload['rotation']> {
  const [rotState, textState, laneState] = await Promise.all([
    from(db, 'rotation_state'),
    from(db, 'text_rotation_state'),
    from(db, 'lane_rotation_state'),
  ]);

  // Empty result (table not migrated yet) is fine — show empty lists.
  // An explicit error is not — surface it.
  const firstError = [rotState, textState, laneState].find((r) => r.error)?.error;
  if (firstError) throw new Error(`[rotation_state] ${firstError.message}`);

  return {
    rotationState: (rotState.data ?? []).map((r) => ({
      brand: String(r.brand),
      lastUsedAssetId: r.last_used_asset_id == null ? null : String(r.last_used_asset_id),
      lastUsedIndex: Number(r.last_used_index),
    })),
    textRotationState: (textState.data ?? []).map((r) => ({
      brand: String(r.brand),
      lastUsedIndex: Number(r.last_used_index),
    })),
    laneRotationState: (laneState.data ?? []).map((r) => ({
      scope: String(r.scope),
      lastUsedIndex: Number(r.last_used_index),
    })),
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  const payload: StatusPayload = {
    ok: true,
    config: {
      supabaseServer: flag('SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'),
      supabaseBrowser: flag('NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'),
      printify: flag('PRINTIFY_API_KEY', 'PRINTIFY_SHOP_ID'),
      cronSecret: flag('CRON_SECRET'),
      galleryWriters: flag('GALLERY_WRITER_IDS'),
    },
    review: null,
    gallery: null,
    decisions: null,
    remixQueue: null,
    rotation: null,
    errors: {},
  };

  // Config-only response when Supabase isn't wired up — no DB calls to make.
  if (payload.config.supabaseServer) {
    const db = getSupabaseAdmin();

    const sections: Array<[string, () => Promise<void>]> = [
      ['review', async () => { payload.review = await reviewSection(db); }],
      ['gallery', async () => { payload.gallery = await gallerySection(db); }],
      ['decisions', async () => { payload.decisions = await decisionsSection(db); }],
      ['remixQueue', async () => { payload.remixQueue = await remixSection(db); }],
      ['rotation', async () => { payload.rotation = await rotationSection(db); }],
    ];

    for (const [name, run] of sections) {
      try {
        await run();
      } catch (err) {
        payload.errors[name] = errMessage(err);
      }
    }

    payload.ok = Object.keys(payload.errors).length === 0;
  } else {
    payload.errors.config =
      'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set on this deployment — live counts unavailable.';
  }

  return NextResponse.json(payload, { status: 200 });
}
