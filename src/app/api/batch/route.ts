// src/app/api/batch/route.ts
//
// POST /api/batch        — trigger a review batch assembly manually.
// GET  /api/batch        — Vercel cron entry point.
//
// CRITICAL: Vercel cron jobs fire HTTP GET requests (they cannot be
// configured to POST via vercel.json), and when a CRON_SECRET env var is
// set on the project, Vercel automatically sends it as an
// `Authorization: Bearer <CRON_SECRET>` header. An earlier version of this
// route only exported POST and only accepted a custom `x-cron-secret`
// header — so every scheduled run died with 405 / 401. Both are accepted
// now, plus the Bearer form Vercel actually uses.
//
// Auth summary (either satisfies):
//   - `Authorization: Bearer <CRON_SECRET>`   (what Vercel cron sends)
//   - `x-cron-secret: <CRON_SECRET>`          (manual curl convenience)
//   - `Authorization: Bearer <JWT>` of a GALLERY_WRITER_IDS member (manual)
//
// Brand resolution: JSON body (`{"brand":"misfit"}`) first, then the
// `?brand=` query param (used by manual GET/POST calls). If neither is
// given, BOTH brands are assembled in one run — so a single cron entry
// covers the whole engine.
//
// export const runtime = 'nodejs' — orchestrator imports sharpRenderer which
// uses sharp; not edge-compatible.

export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { verifyUserJwt } from '../../../lib/supabaseClient';
import { assembleReviewBatch } from '../../../lib/orchestrator';
import { supabaseAssetStore } from '../../../lib/permanentAssets';
import { supabaseTextBankProvider } from '../../../lib/textBank';
import { sharpRenderer } from '../../../lib/render/sharpRenderer';
import { printifyClient } from '../../../lib/merch/printifyClient';
import { tagOverlapMatcher } from '../../../lib/merch/tagMatcher';
import type { Brand } from '../../../types/media';

const VALID_BRANDS: ReadonlySet<string> = new Set(['misfit', 'forge']);
const ALL_BRANDS: readonly Brand[] = ['misfit', 'forge'];

function parseWriterIds(): string[] {
  return (process.env.GALLERY_WRITER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Matches a bare CRON_SECRET value (as sent by Vercel) or "Bearer <secret>". */
function isCronBearer(headerValue: string | null): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || !headerValue) return false;
  const trimmed = headerValue.trim();
  return trimmed === cronSecret || trimmed === `Bearer ${cronSecret}`;
}

async function isAuthorized(req: NextRequest): Promise<boolean> {
  // 1. Cron secret — via x-cron-secret header or Authorization header
  //    (Bearer <CRON_SECRET> is what Vercel sends for cron invocations).
  if (isCronBearer(req.headers.get('x-cron-secret'))) return true;
  if (isCronBearer(req.headers.get('authorization'))) return true;

  // 2. Manual trigger — allowlisted writer JWT.
  const authHeader = req.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return false;

  try {
    const user = await verifyUserJwt(token);
    if (!user) return false;
    const writerIds = parseWriterIds();
    return writerIds.length > 0 && writerIds.includes(user.id);
  } catch {
    // Env not configured for JWT verification (e.g. missing anon key).
    return false;
  }
}

/**
 * Extracts the requested brand(s). Body first, then query param, then all.
 * Invalid brand values are an error rather than silently running everything.
 */
function resolveBrands(req: NextRequest, body: unknown): Brand[] | { error: string } {
  let brandRaw: unknown;

  if (
    body !== null &&
    typeof body === 'object' &&
    'brand' in body &&
    typeof (body as Record<string, unknown>).brand === 'string'
  ) {
    brandRaw = (body as Record<string, unknown>).brand;
  } else {
    brandRaw = req.nextUrl.searchParams.get('brand');
  }

  if (brandRaw === null || brandRaw === undefined) return [...ALL_BRANDS];
  if (VALID_BRANDS.has(String(brandRaw))) return [String(brandRaw) as Brand];
  return { error: 'brand must be "misfit" or "forge" (or omitted for both)' };
}

async function runBatch(brands: readonly Brand[]): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const brand of brands) {
    const result = await assembleReviewBatch(brand, {
      assetStore: supabaseAssetStore,
      textBank: supabaseTextBankProvider,
      renderer: sharpRenderer,
      catalogClient: printifyClient,
      galleryMatcher: tagOverlapMatcher,
    });
    results.push({ brand, ...result });
  }
  return results;
}

async function handle(req: NextRequest, expectJsonBody: boolean): Promise<NextResponse> {
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Parse body (POST carries JSON; GET cron requests carry none).
  let body: unknown = null;
  if (expectJsonBody) {
    const contentType = req.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      try {
        body = await req.json();
      } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
    }
  }

  const brands = resolveBrands(req, body);
  if (!Array.isArray(brands)) {
    return NextResponse.json({ error: brands.error }, { status: 400 });
  }

  try {
    const results = await runBatch(brands);
    return NextResponse.json({ batches: results }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[batch/route] assembleReviewBatch threw:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Manual trigger with a JSON body: POST /api/batch {"brand":"misfit"} */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return handle(req, true);
}

/** Vercel cron entry point: GET /api/batch (optionally ?brand=misfit) */
export async function GET(req: NextRequest): Promise<NextResponse> {
  return handle(req, false);
}
