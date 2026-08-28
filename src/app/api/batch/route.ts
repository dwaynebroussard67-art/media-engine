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
// export const runtime = 'nodejs' — orchestrator imports sharpRenderer which
// uses sharp; not edge-compatible.

export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { verifyUserJwt, getSupabaseAdmin } from '../../../lib/supabaseClient';
import { assembleReviewBatch } from '../../../lib/orchestrator';
import { supabaseAssetStore } from '../../../lib/permanentAssets';
import { supabaseTextBankProvider } from '../../../lib/textBank';
import { sharpRenderer } from '../../../lib/render/sharpRenderer';
import { printifyClient } from '../../../lib/merch/printifyClient';
import { tagOverlapMatcher } from '../../../lib/merch/tagMatcher';
import type { Brand } from '../../../types/media';

const VALID_BRANDS: ReadonlySet<string> = new Set(['misfit', 'forge']);

function parseWriterIds(): string[] {
  return (process.env.GALLERY_WRITER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isCronRequest(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  // Vercel cron: `Authorization: Bearer <CRON_SECRET>` (automatic).
  // Manual/other schedulers: `x-cron-secret: <CRON_SECRET>`.
  return (
    req.headers.get('authorization') === `Bearer ${cronSecret}` ||
    req.headers.get('x-cron-secret') === cronSecret
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

  try {
    const result = await assembleReviewBatch(brand as Brand, {
      assetStore: supabaseAssetStore,
      textBank: supabaseTextBankProvider,
      renderer: sharpRenderer,
      catalogClient: printifyClient,
      galleryMatcher: tagOverlapMatcher,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[batch/route] assembleReviewBatch threw:', message);
    return NextResponse.json({ error: message }, { status: 500 });
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
