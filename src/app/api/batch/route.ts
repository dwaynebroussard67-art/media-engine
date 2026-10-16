// src/app/api/batch/route.ts
//
// /api/batch — triggers a review batch assembly.
// Auth: GALLERY_WRITER_IDS (same as gallery upload) OR CRON_SECRET.
// Cron: vercel.json → Vercel cron invokes this endpoint with an HTTP **GET**
// and — when the CRON_SECRET env var is set — automatically attaches
// `Authorization: Bearer <CRON_SECRET>`. Vercel cron cannot send custom
// headers or a body, so the brand comes from the query string
// (/api/batch?brand=misfit) and the secret is accepted either as the
// standard Bearer header or as a manual x-cron-secret header.
//
// Single-flight lock (2026-10-15, red-team finding F-01): rotation state is
// read-modify-write, so two overlapping batches for one brand used to pick the
// same base asset and advance the same pointer — duplicate renders against an
// append-only gallery, permanently skipped assets, duplicate spend. Every run
// now claims a `batch_runs` row (migration 004) first; a second concurrent
// claim for the same brand gets 409 `batch_already_running` with the age of the
// live run. If migration 004 is not applied yet the batch still runs, but the
// response carries lock.status = 'unavailable' with the reason and the operator
// sees it in /setup — degrade loudly, never silently.
//
// export const runtime = 'nodejs' — orchestrator imports sharpRenderer which
// uses sharp; not edge-compatible.

export const runtime = 'nodejs';

import { timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { verifyUserJwt, getSupabaseAdmin } from '../../../lib/supabaseClient';
import { assembleReviewBatch } from '../../../lib/orchestrator';
import { supabaseAssetStore } from '../../../lib/permanentAssets';
import { supabaseTextBankProvider } from '../../../lib/textBank';
import { sharpRenderer } from '../../../lib/render/sharpRenderer';
import { printifyClient } from '../../../lib/merch/printifyClient';
import { tagOverlapMatcher } from '../../../lib/merch/tagMatcher';
import { claimBatchRun, finishBatchRun } from '../../../lib/batch/batchLock';
import type { Brand } from '../../../types/media';

const VALID_BRANDS: ReadonlySet<string> = new Set(['misfit', 'forge']);

function parseWriterIds(): string[] {
  return (process.env.GALLERY_WRITER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Constant-time secret comparison. `===` on a shared secret leaks prefix
 * length through timing; cheap to do properly, so it is done properly.
 * Length is compared first (timingSafeEqual throws on unequal buffers) — the
 * length of a valid secret is not itself secret.
 */
function secretMatches(provided: string | null, expected: string): boolean {
  if (provided === null) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isCronRequest(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  // Vercel cron: `Authorization: Bearer <CRON_SECRET>` (automatic).
  // Manual/other schedulers: `x-cron-secret: <CRON_SECRET>`.
  const authHeader = req.headers.get('authorization');
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  return (
    secretMatches(bearer, cronSecret) ||
    secretMatches(req.headers.get('x-cron-secret'), cronSecret)
  );
}

async function runBatch(req: NextRequest): Promise<NextResponse> {
  // Auth: cron secret OR writer JWT.
  let authed = false;

  if (isCronRequest(req)) {
    authed = true;
  } else {
    const authHeader = req.headers.get('authorization') ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (token) {
      let user: { id: string; email?: string } | null;
      try {
        user = await verifyUserJwt(token);
      } catch (err) {
        // A thrown JWT check (e.g. Supabase unreachable) must surface as a
        // visible, logged 500 — not an unhandled route crash.
        const message = err instanceof Error ? err.message : String(err);
        console.error('[batch/route] verifyUserJwt threw:', message);
        return NextResponse.json(
          { error: `JWT verification failed: ${message}` },
          { status: 500 }
        );
      }
      if (user) {
        const writerIds = parseWriterIds();
        if (writerIds.length > 0 && writerIds.includes(user.id)) {
          authed = true;
        }
      }
    }
  }

  if (!authed) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Brand: query string FIRST (Vercel cron sends no body — vercel.json
  // passes /api/batch?brand=misfit), JSON body as a fallback for manual
  // POST callers.
  let brand: string | null = req.nextUrl.searchParams.get('brand');

  if (!brand) {
    let body: unknown = null;
    try {
      body = await req.json();
    } catch {
      body = null; // no/invalid body — brand may still come from the query
    }

    brand =
      body !== null &&
      typeof body === 'object' &&
      'brand' in body &&
      typeof (body as Record<string, unknown>).brand === 'string'
        ? ((body as Record<string, unknown>).brand as string)
        : null;
  }

  if (!brand || !VALID_BRANDS.has(brand)) {
    return NextResponse.json(
      { error: 'brand must be "misfit" or "forge" (?brand= query param or body.brand)' },
      { status: 400 }
    );
  }

  const typedBrand = brand as Brand;

  // ── Single-flight claim ────────────────────────────────────────────────────
  const claim = await claimBatchRun(typedBrand);

  if (claim.status === 'busy') {
    const ageMinutes =
      claim.ageMs === undefined ? undefined : Math.round(claim.ageMs / 60000);
    console.warn(
      `[batch/route] refused overlapping ${typedBrand} batch — run ${
        claim.runId ?? '(unknown)'
      } has been running for ${ageMinutes ?? '?'} min`
    );
    return NextResponse.json(
      {
        error: 'batch_already_running',
        brand: typedBrand,
        runId: claim.runId ?? null,
        startedAt: claim.startedAt ?? null,
        ageMinutes: ageMinutes ?? null,
        staleRetired: claim.staleRetired ?? false,
        hint:
          'Only one batch per brand may run at a time — rotation state is read-modify-write and overlapping runs corrupt it. ' +
          'If this run is dead (killed mid-batch) it is retired automatically after 15 minutes, or release it from /setup.',
      },
      { status: 409 }
    );
  }

  const lockStatus: Record<string, unknown> =
    claim.status === 'claimed'
      ? { status: 'held', runId: claim.runId }
      : {
          status: 'unavailable',
          reason: claim.reason,
          hint:
            'batch_runs is missing or unreachable, so this run was NOT protected against overlap. ' +
            'Apply supabase/migrations/004_batch_runs.sql (seed it from /setup).',
        };

  if (claim.status === 'unavailable') {
    console.error(
      `[batch/route] running ${typedBrand} batch WITHOUT a single-flight lock: ${claim.reason}`
    );
  }

  try {
    const result = await assembleReviewBatch(typedBrand, {
      assetStore: supabaseAssetStore,
      textBank: supabaseTextBankProvider,
      renderer: sharpRenderer,
      catalogClient: printifyClient,
      galleryMatcher: tagOverlapMatcher,
    });

    let finalizeWarning: string | undefined;
    if (claim.status === 'claimed') {
      const finalize = await finishBatchRun(claim.runId, 'done', {
        queued: result.queued,
      });
      if (!finalize.ok) {
        finalizeWarning = finalize.warning;
        console.error(`[batch/route] ${finalize.warning ?? 'finalize failed'}`);
      }
    }

    return NextResponse.json(
      {
        ...result,
        lock: {
          ...lockStatus,
          finalized: claim.status === 'claimed' ? !finalizeWarning : null,
        },
        ...(finalizeWarning ? { warning: finalizeWarning } : {}),
      },
      { status: 200 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[batch/route] assembleReviewBatch threw:', message);

    if (claim.status === 'claimed') {
      const finalize = await finishBatchRun(claim.runId, 'error', { note: message });
      if (!finalize.ok) console.error(`[batch/route] ${finalize.warning ?? ''}`);
    }

    return NextResponse.json({ error: message, lock: lockStatus }, { status: 500 });
  }
}

// Vercel cron sends GET — this is the primary entry point.
export async function GET(req: NextRequest): Promise<NextResponse> {
  return runBatch(req);
}

// Manual triggers may POST (body.brand as fallback for the query param).
export async function POST(req: NextRequest): Promise<NextResponse> {
  return runBatch(req);
}
