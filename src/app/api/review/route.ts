// src/app/api/review/route.ts
//
// GET /api/review?brand=misfit&page=1&pageSize=20
// Returns pending review_queue items, oldest first, paginated.
//
// AUTH (2026-10-15, red-team finding F-06): reads are no longer public. The
// endpoint used to be world-readable, which meant unreleased brand copy, image
// URLs and queue internals were one guessed URL away, and /api/gallery exposes
// the whole asset store with no auth at all. Reads now require the same writer
// allowlist as every write — the review page already only fetched with a
// session, so this costs the operator nothing.
//
// The allowlist fails closed: an EMPTY GALLERY_WRITER_IDS means nobody reads,
// which is the correct default for a shared Supabase project.
//
// NOTE: Oracle-failed items (oracle_result.passed === false) are excluded
// from the default view. D can inspect them explicitly with ?includeRejected=true.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, verifyUserJwt } from '../../../lib/supabaseClient';

const VALID_BRANDS = new Set(['misfit', 'forge']);
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function parseWriterIds(): string[] {
  return (process.env.GALLERY_WRITER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // ── Auth: writer allowlist only (fails closed on an empty list) ─────────
  const authHeader = req.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return NextResponse.json({ error: 'Authorization header required' }, { status: 401 });
  }

  let user: { id: string; email?: string } | null;
  try {
    user = await verifyUserJwt(token);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[review/route GET] verifyUserJwt threw:', message);
    return NextResponse.json({ error: `JWT verification failed: ${message}` }, { status: 500 });
  }
  if (!user) {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
  }

  const writerIds = parseWriterIds();
  if (writerIds.length === 0 || !writerIds.includes(user.id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = req.nextUrl;

  const brand = searchParams.get('brand');
  if (!brand || !VALID_BRANDS.has(brand)) {
    return NextResponse.json(
      { error: 'brand query param must be "misfit" or "forge"' },
      { status: 400 }
    );
  }

  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, parseInt(searchParams.get('pageSize') ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE)
  );
  const includeRejected = searchParams.get('includeRejected') === 'true';

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const db = getSupabaseAdmin();

  // Build query.
  let query = db
    .from('review_queue')
    .select('*', { count: 'exact' })
    .eq('brand', brand)
    .eq('status', 'pending')
    .order('queued_at', { ascending: true })
    .range(from, to);

  // Exclude oracle-failed items from default view.
  // oracle_result is jsonb; filter on the nested passed field.
  if (!includeRejected) {
    query = query.eq('oracle_result->>passed', 'true');
  }

  const { data, error, count } = await query;

  if (error) {
    console.error('[review/route GET]', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    items: data ?? [],
    total: count ?? 0,
    page,
    pageSize,
  });
}
