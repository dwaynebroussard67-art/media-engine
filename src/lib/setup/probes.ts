// src/lib/setup/probes.ts
//
// Server-side probes behind /api/setup. Everything here is read-only except
// the storage round-trip, which writes ONE throwaway object and deletes it
// again — nothing here ever touches gallery_assets, media_decisions or
// review_queue. That is a hard rule: setup tooling must never write to an
// append-only table.
//
// Every probe returns a verdict plus the evidence it was derived from. No
// probe throws to the caller: a probe that cannot answer says so and says why.

import { randomUUID } from 'crypto';
import { getSupabaseAdmin } from '../supabaseClient';
import { printifyClient } from '../merch/printifyClient';
import { runStep, type ProbeStep } from '../probeStep';

const BUCKET = 'media-engine';

// ── Database ──────────────────────────────────────────────────────────────────

export interface TableProbeRow {
  table: string;
  /** Which migration/file creates it — so the fix instruction is unambiguous. */
  createdBy: string;
  required: boolean;
  ok: boolean;
  count?: number;
  error?: string;
}

export interface DatabaseProbe {
  ok: boolean;
  tables: TableProbeRow[];
  /** The dossier's one known-unverified live check: the jsonb path filter. */
  jsonbFilter: { ok: boolean; detail: string; pendingPassed?: number; pendingRejected?: number };
  warnings: string[];
}

const TABLES: Array<{ table: string; createdBy: string; required: boolean }> = [
  { table: 'gallery_assets', createdBy: 'supabase/schema.sql', required: true },
  { table: 'rotation_state', createdBy: 'supabase/schema.sql', required: true },
  { table: 'review_queue', createdBy: 'supabase/schema.sql', required: true },
  { table: 'media_decisions', createdBy: 'supabase/schema.sql', required: true },
  { table: 'remix_queue', createdBy: 'supabase/schema.sql', required: true },
  { table: 'text_rotation_state', createdBy: 'migrations/002_tags.sql', required: true },
  { table: 'lane_rotation_state', createdBy: 'migrations/003_lane_rotation.sql', required: true },
  { table: 'batch_runs', createdBy: 'migrations/004_batch_runs.sql', required: false },
];

function errMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message?: unknown }).message ?? 'unknown error');
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Head-only count per table. A missing table surfaces as a PostgREST error
 * naming the table — which is exactly the instruction D needs.
 */
export async function probeDatabase(): Promise<DatabaseProbe> {
  const db = getSupabaseAdmin();
  const warnings: string[] = [];
  const tables: TableProbeRow[] = [];

  for (const spec of TABLES) {
    try {
      const { count, error } = await db
        .from(spec.table)
        .select('*', { count: 'exact', head: true });

      if (error) {
        tables.push({ ...spec, ok: false, error: errMessage(error) });
      } else {
        tables.push({ ...spec, ok: true, count: count ?? 0 });
      }
    } catch (err) {
      tables.push({ ...spec, ok: false, error: errMessage(err) });
    }
  }

  // ── The jsonb path filter ────────────────────────────────────────────────
  // Dossier §7.5 / DEBUG-REPORT: `oracle_result->>passed` is used by
  // GET /api/review and the status dashboard and was never verified against
  // live PostgREST. Verify it here, once, visibly.
  let jsonbFilter: DatabaseProbe['jsonbFilter'] = {
    ok: false,
    detail: 'not attempted — review_queue is not reachable',
  };

  try {
    const passed = await db
      .from('review_queue')
      .select('*', { count: 'exact', head: true })
      .eq('oracle_result->>passed', 'true');

    const rejected = await db
      .from('review_queue')
      .select('*', { count: 'exact', head: true })
      .eq('oracle_result->>passed', 'false');

    if (passed.error || rejected.error) {
      const msg = errMessage(passed.error ?? rejected.error);
      jsonbFilter = {
        ok: false,
        detail: `PostgREST rejected the jsonb path filter: ${msg}. GET /api/review and the dashboard's pending counts depend on it — both are broken until this works.`,
      };
      warnings.push(
        'The oracle_result->>passed filter failed on live PostgREST. GET /api/review returns 500 and the dashboard shows a review error.',
      );
    } else {
      jsonbFilter = {
        ok: true,
        detail: `jsonb path filter works: ${passed.count ?? 0} pending item(s) passed the oracle, ${rejected.count ?? 0} were rejected by it.`,
        pendingPassed: passed.count ?? 0,
        pendingRejected: rejected.count ?? 0,
      };
      if ((rejected.count ?? 0) > 0) {
        warnings.push(
          `${rejected.count} item(s) are sitting in the queue REJECTED by the oracle and hidden from the default review view. They are not lost — toggle "show oracle-rejected" on /review (red-team finding F-05).`,
        );
      }
    }
  } catch (err) {
    jsonbFilter = { ok: false, detail: errMessage(err) };
  }

  const requiredMissing = tables.filter((t) => t.required && !t.ok);

  return {
    ok: requiredMissing.length === 0 && jsonbFilter.ok,
    tables,
    jsonbFilter,
    warnings,
  };
}

/** Per-brand eligible base counts — what the two generation lanes need. */
export interface BaseAssetCounts {
  ok: boolean;
  byBrand: Record<string, { freshTextBases: number; recombinationBases: number }>;
  error?: string;
}

export async function probeBaseAssets(): Promise<BaseAssetCounts> {
  const db = getSupabaseAdmin();
  const byBrand: BaseAssetCounts['byBrand'] = {};

  try {
    const { data, error } = await db
      .from('gallery_assets')
      .select('brand,category');

    if (error) return { ok: false, byBrand, error: errMessage(error) };

    const rows = (data ?? []) as Array<{ brand?: unknown; category?: unknown }>;

    for (const brand of ['misfit', 'forge'] as const) {
      const relevant = rows.filter(
        (r) => r.brand === brand || r.brand === 'shared',
      );
      byBrand[brand] = {
        freshTextBases: relevant.filter(
          (r) => r.category === 'atmosphere' || r.category === 'art',
        ).length,
        recombinationBases: relevant.filter((r) => r.category !== 'logo').length,
      };
    }

    return { ok: true, byBrand };
  } catch (err) {
    return { ok: false, byBrand, error: errMessage(err) };
  }
}

// ── Storage ───────────────────────────────────────────────────────────────────

export interface StorageProbe {
  ok: boolean;
  steps: ProbeStep[];
  warnings: string[];
}

/**
 * Round-trips a throwaway object through the `media-engine` bucket:
 * service-role write → public URL → anonymous HTTPS read → delete.
 * This is the check that catches "bucket doesn't exist", "bucket is private",
 * and "service role key is actually the anon key" in one press.
 */
export async function probeStorage(): Promise<StorageProbe> {
  const db = getSupabaseAdmin();
  const steps: ProbeStep[] = [];
  const warnings: string[] = [];
  const path = `_setup/probe-${randomUUID()}.txt`;
  const body = `media-engine setup probe ${new Date().toISOString()}`;
  let publicUrl: string | undefined;

  const upload = await runStep('storage_upload', async () => {
    const { error } = await db.storage
      .from(BUCKET)
      .upload(path, Buffer.from(body), { contentType: 'text/plain', upsert: false });
    if (error) throw new Error(error.message);
    const { data } = db.storage.from(BUCKET).getPublicUrl(path);
    if (!data?.publicUrl) throw new Error('getPublicUrl returned no URL');
    publicUrl = data.publicUrl;
    return `${path} → ${data.publicUrl}`;
  });
  steps.push(upload.step);

  if (upload.ok && publicUrl) {
    const read = await runStep('public_read', async () => {
      const res = await fetch(publicUrl as string);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const text = await res.text();
      if (!text.includes('media-engine setup probe')) {
        throw new Error('fetched the object but the body did not match');
      }
      return `HTTP ${res.status}, body matched`;
    });
    steps.push(read.step);

    if (!read.ok) {
      warnings.push(
        'The bucket is not publicly readable. Every lane fetches its base image over the public URL, so renders WILL fail until the bucket is PUBLIC (Supabase → Storage → media-engine → Settings → Public bucket).',
      );
    }
  } else {
    warnings.push(
      'Storage write failed. Check: bucket "media-engine" exists; SUPABASE_SERVICE_ROLE_KEY is the service-role secret (not the anon key); the key belongs to the same project as SUPABASE_URL.',
    );
  }

  const cleanup = await runStep('cleanup', async () => {
    const { error } = await db.storage.from(BUCKET).remove([path]);
    if (error) throw new Error(error.message);
    return `removed ${path}`;
  });
  steps.push(cleanup.step);
  if (!cleanup.ok) {
    warnings.push(
      `Could not delete the probe object ${path} — delete it by hand if you care. It is 40 bytes of text; nothing references it.`,
    );
  }

  return { ok: steps.every((s) => s.ok), steps, warnings };
}

// ── Printify ──────────────────────────────────────────────────────────────────

export interface PrintifyProbe {
  ok: boolean;
  ms: number;
  resultCount?: number;
  sample?: string;
  error?: string;
  warnings: string[];
}

/**
 * One real catalog search. The merch lane's tier 2; if this fails the lane
 * reports CatalogUnavailableError (by design — an outage must never silently
 * degrade into paid AI generation). Exercises exactly the production client.
 */
export async function probePrintify(query: string): Promise<PrintifyProbe> {
  const warnings: string[] = [];
  const start = Date.now();

  try {
    const results = await printifyClient.search(query, 'apparel');
    const ms = Date.now() - start;

    if (results.length === 0) {
      warnings.push(
        `The search returned zero products for "${query}". That is NOT an outage — an empty catalog result legitimately falls through to the ai_touchup tier, which is the paid last resort. Widen the query or check the shop has products.`,
      );
    }

    return {
      ok: true,
      ms,
      resultCount: results.length,
      ...(results[0] ? { sample: `${results[0].id} → ${results[0].url}` } : {}),
      warnings,
    };
  } catch (err) {
    const ms = Date.now() - start;
    const message = errMessage(err);
    warnings.push(
      'A catalog failure raises CatalogUnavailableError in the merch lane and the merch lane reports status "error" — it will NOT fall through to AI. Fix the key/shop id, or accept a merch-less batch.',
    );
    return { ok: false, ms, error: message, warnings };
  }
}
