// src/app/api/batch/route.ts
//
// POST /api/batch — triggers a review batch assembly.
// Auth: GALLERY_WRITER_IDS (same as gallery upload) OR CRON_SECRET header.
// Cron: vercel.json → POST /api/batch with header x-cron-secret: $CRON_SECRET.
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
  return req.headers.get('x-cron-secret') === cronSecret;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Auth: cron secret OR writer JWT.
  let authed = false;

  if (isCronRequest(req)) {
    authed = true;
  } else {
    const authHeader = req.headers.get('authorization') ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (token) {
      const user = await verifyUserJwt(token);
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

  // Parse body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const brand =
    body !== null &&
    typeof body === 'object' &&
    'brand' in body &&
    typeof (body as Record<string, unknown>).brand === 'string'
      ? (body as Record<string, unknown>).brand
      : null;

  if (!brand || !VALID_BRANDS.has(brand as string)) {
    return NextResponse.json(
      { error: 'body.brand must be "misfit" or "forge"' },
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
