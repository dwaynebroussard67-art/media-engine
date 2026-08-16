// src/app/api/review/[id]/route.ts
//
// POST /api/review/:id  — body: { decision: 'post'|'remix'|'reject' }
// Auth: Bearer JWT in GALLERY_WRITER_IDS.
//
// Maps FinalityViolationError → 409 with both decisions in the body.
// Idempotent replay (same decision) → 200 with the existing record.

import { NextRequest, NextResponse } from 'next/server';
import { verifyUserJwt, getSupabaseAdmin, SupabaseNotConfiguredError } from '../../../../lib/supabaseClient';
import { handleReviewDecision, FinalityViolationError } from '../../../../lib/review/reviewQueue';
import { queueRowToReviewItem } from '../../../../lib/review/queueRow';
import type { ReviewDecision } from '../../../../types/media';

const VALID_DECISIONS: ReadonlySet<string> = new Set(['post', 'remix', 'reject']);

function notConfiguredResponse(err: unknown): NextResponse | null {
  if (err instanceof SupabaseNotConfiguredError) {
    return NextResponse.json({ error: err.message }, { status: 503 });
  }
  return null;
}

function parseWriterIds(): string[] {
  return (process.env.GALLERY_WRITER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await context.params;
  // Auth.
  const authHeader = req.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return NextResponse.json({ error: 'Authorization header required' }, { status: 401 });
  }

  let user: { id: string; email?: string } | null;
  try {
    user = await verifyUserJwt(token);
  } catch (err) {
    const configured = notConfiguredResponse(err);
    if (configured) return configured;
    throw err;
  }
  if (!user) {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
  }

  const writerIds = parseWriterIds();
  // Empty list = nobody can write. Fails closed.
  if (writerIds.length === 0 || !writerIds.includes(user.id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Parse body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const decision =
    body !== null &&
    typeof body === 'object' &&
    'decision' in body &&
    typeof (body as Record<string, unknown>).decision === 'string'
      ? (body as Record<string, unknown>).decision
      : null;

  if (!decision || !VALID_DECISIONS.has(decision as string)) {
    return NextResponse.json(
      { error: 'body.decision must be "post", "remix", or "reject"' },
      { status: 400 }
    );
  }

  // Load queue row.
  let db: ReturnType<typeof getSupabaseAdmin>;
  try {
    db = getSupabaseAdmin();
  } catch (err) {
    const configured = notConfiguredResponse(err);
    if (configured) return configured;
    throw err;
  }
  const { data: row, error: fetchError } = await db
    .from('review_queue')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }

  if (!row) {
    return NextResponse.json({ error: 'Review item not found' }, { status: 404 });
  }

  // Reconstruct ReviewItem from queue row via the shared mapper —
  // merchSource/sourceDetail are restored from merch_meta so the decision
  // handler sees the same item the operator reviewed.
  const item = queueRowToReviewItem({
    id: row.id,
    image_url: row.image_url,
    brand: row.brand,
    lane: row.lane,
    source_data: row.source_data,
    oracle_result: row.oracle_result,
    merch_meta: row.merch_meta,
    queued_at: row.queued_at,
  });

  // Call the decision handler.
  try {
    const record = await handleReviewDecision(item, decision as ReviewDecision);
    return NextResponse.json(record, { status: 200 });
  } catch (err) {
    if (err instanceof FinalityViolationError) {
      return NextResponse.json(
        {
          error: 'already_decided',
          requested: err.requested,
          existing: err.existing,
          itemId: err.itemId,
        },
        { status: 409 }
      );
    }

    const message = err instanceof Error ? err.message : String(err);
    console.error(`[review/${id}] handleReviewDecision threw:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}