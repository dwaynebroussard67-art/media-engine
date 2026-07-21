// src/app/api/review/route.ts
//
// GET /api/review?brand=misfit&page=1&pageSize=20
// Returns pending review_queue items, oldest first, paginated.
// No auth required for reads (D is the only user; if this changes, add auth).
//
// NOTE: Oracle-failed items (oracle_result.passed === false) are excluded
// from the default view. D can inspect them explicitly with ?includeRejected=true.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '../../../lib/supabaseClient';

const VALID_BRANDS = new Set(['misfit', 'forge']);
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export async function GET(req: NextRequest): Promise<NextResponse> {
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
