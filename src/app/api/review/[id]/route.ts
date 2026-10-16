// src/app/api/review/[id]/route.ts
//
// POST /api/review/:id  — body: { decision: 'post'|'remix'|'reject' }
// Auth: Bearer JWT in GALLERY_WRITER_IDS.
//
// Maps FinalityViolationError → 409 with both decisions in the body.
// Idempotent replay (same decision) → 200 with the existing record.

import { NextRequest, NextResponse } from 'next/server';
import { verifyUserJwt, getSupabaseAdmin } from '../../../../lib/supabaseClient';
import { handleReviewDecision, FinalityViolationError } from '../../../../lib/review/reviewQueue';
import { queueRowToReviewItem, type ReviewQueueRow } from '../../../../lib/review/queueRow';
import type { ReviewItem, ReviewDecision } from '../../../../types/media';

const VALID_DECISIONS: ReadonlySet<string> = new Set(['post', 'remix', 'reject']);

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

  const user = await verifyUserJwt(token);
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
  const db = getSupabaseAdmin();
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

  // Reconstruct ReviewItem from the queue row via the ONE shared mapper
  // (src/lib/review/queueRow.ts). This mapping used to be copy-pasted here and
  // in the review page, which is precisely how merchSource stopped being set
  // and the merch badge disappeared (DEBUG-REPORT Bug 5).
  const item: ReviewItem = queueRowToReviewItem(row as unknown as ReviewQueueRow);

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