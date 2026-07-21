// src/lib/review/reviewQueue.ts
// Human review decision handler.
//
// Design: decision INSERT first, side effects second, with idempotent replay.
//
//   Why INSERT-first:
//     Two concurrent handlers can both pass the pre-check. The unique index
//     on media_decisions(item_id) makes the INSERT the authoritative gate —
//     exactly one racer wins, and the loser's side effects NEVER fire. This
//     matters when the racers carry contradictory decisions (post vs remix):
//     side-effects-first would execute both against an append-only gallery.
//
//   Why idempotent replay (the crash-window fix):
//     If the process dies after the INSERT but before side effects complete,
//     a naive finality gate would block the retry forever, leaving a decision
//     that says 'post' with no gallery entry. Instead, a repeat call with the
//     SAME decision completes any missing side effects and returns the
//     existing record. A repeat with a DIFFERENT decision throws
//     FinalityViolationError. No reconciliation job needed — retrying the
//     original call is the reconciliation.
//
//   All side effects are idempotent:
//     - onPostApproved absorbs DuplicateAssetError (gallery insert no-op).
//     - remix enqueue treats 23505 on remix_queue(original_item_id) as a no-op.

import { randomUUID } from 'crypto';
import { getSupabaseAdmin } from '../supabaseClient';
import { onPostApproved, supabaseAssetStore } from '../permanentAssets';
import type {
  ReviewItem,
  ReviewDecision,
  DecisionRecord,
} from '../../types/media';

// ── Typed errors ──────────────────────────────────────────────────────────────

export class FinalityViolationError extends Error {
  public readonly itemId: string;
  public readonly requested: ReviewDecision;
  public readonly existing: ReviewDecision;

  constructor(itemId: string, requested: ReviewDecision, existing: ReviewDecision) {
    super(
      `Finality violation: item "${itemId}" was already decided as ` +
      `"${existing}"; a new "${requested}" decision is not permitted. ` +
      `Decisions are append-only and final.`,
    );
    this.name = 'FinalityViolationError';
    this.itemId = itemId;
    this.requested = requested;
    this.existing = existing;
  }
}

// ── Existing-decision lookup ──────────────────────────────────────────────────

interface DecisionRow {
  id: string;
  item_id: string;
  decision: ReviewDecision;
  brand: DecisionRecord['brand'];
  lane: DecisionRecord['lane'];
  oracle_result: DecisionRecord['oracleResult'];
  gallery_entry_id: string | null;
  decided_at: number;
}

export async function getExistingDecision(
  itemId: string,
): Promise<DecisionRecord | null> {
  const { data, error } = await getSupabaseAdmin()
    .from('media_decisions')
    .select('*')
    .eq('item_id', itemId)
    .maybeSingle();

  if (error) {
    throw new Error(
      `[reviewQueue] Finality check failed for item "${itemId}": ${error.message}`,
    );
  }
  if (!data) return null;

  const row = data as DecisionRow;
  return {
    id:             row.id,
    itemId:         row.item_id,
    decision:       row.decision,
    decidedAt:      Number(row.decided_at),
    brand:          row.brand,
    lane:           row.lane,
    oracleResult:   row.oracle_result,
    ...(row.gallery_entry_id ? { galleryEntryId: row.gallery_entry_id } : {}),
  };
}

/** Back-compat boolean form of the finality check. */
export async function hasDecisionBeenRecorded(itemId: string): Promise<boolean> {
  return (await getExistingDecision(itemId)) !== null;
}

// ── Idempotent side effects ───────────────────────────────────────────────────

async function runSideEffects(
  item: ReviewItem,
  decision: ReviewDecision,
  decidedAt: number,
): Promise<void> {
  if (decision === 'post') {
    // Idempotent: DuplicateAssetError is absorbed inside onPostApproved.
    await onPostApproved(supabaseAssetStore, item);

  } else if (decision === 'remix') {
    const { error } = await getSupabaseAdmin()
      .from('remix_queue')
      .insert({
        original_item_id: item.id,
        brand:            item.brand,
        lane:             item.generationLane,
        queued_at:        decidedAt,
        reason:           'operator remix decision',
      });

    // 23505 on remix_queue(original_item_id): work order already exists
    // from a prior attempt — idempotent success.
    if (error && error.code !== '23505') {
      // The decision record already exists; throwing here is SAFE because
      // handleReviewDecision is idempotent — retrying the same call resumes
      // at this side effect and completes it.
      throw new Error(
        `[reviewQueue] Remix enqueue failed for item "${item.id}": ` +
        `${error.message}. Retry the decision to complete the side effect.`,
      );
    }
  }
  // 'reject' has no side effects — the record alone is sufficient.
}

// ── Queue close-out (non-fatal) ───────────────────────────────────────────────

async function closeQueueRow(itemId: string, decidedAt: number): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from('review_queue')
    .update({ status: 'decided', decided_at: decidedAt })
    .eq('id', itemId);

  if (error) {
    // Non-fatal: media_decisions is the source of truth; a stale queue row
    // is cosmetic and self-corrects on the next idempotent replay.
    console.error(
      `[reviewQueue] review_queue status update failed for item "${itemId}" ` +
      `(decision already recorded): ${error.message}`,
    );
  }
}

// ── Decision handler ──────────────────────────────────────────────────────────

export async function handleReviewDecision(
  item: ReviewItem,
  decision: ReviewDecision,
): Promise<DecisionRecord> {

  // ── 1. Finality gate with idempotent replay ─────────────────────────────
  const existing = await getExistingDecision(item.id);
  if (existing) {
    if (existing.decision !== decision) {
      throw new FinalityViolationError(item.id, decision, existing.decision);
    }
    // Same decision re-submitted (double-click, network retry, or crash
    // recovery): complete any missing side effects and return the record.
    await runSideEffects(item, decision, existing.decidedAt);
    await closeQueueRow(item.id, existing.decidedAt);
    return existing;
  }

  // ── 2. Build the record; galleryEntryId written in the INSERT itself ────
  const decidedAt = Date.now();
  const galleryEntryId: string | undefined =
    decision === 'post' ? item.id : undefined;

  const record: DecisionRecord = {
    id:           randomUUID(),
    itemId:       item.id,
    decision,
    decidedAt,
    brand:        item.brand,
    lane:         item.generationLane,
    oracleResult: item.oracleResult,
    ...(galleryEntryId ? { galleryEntryId } : {}),
  };

  // ── 3. Decision INSERT — the authoritative finality gate ────────────────
  const { error: insertError } = await getSupabaseAdmin()
    .from('media_decisions')
    .insert({
      id:               record.id,
      item_id:          record.itemId,
      decision:         record.decision,
      brand:            record.brand,
      lane:             record.lane,
      oracle_result:    record.oracleResult,
      gallery_entry_id: galleryEntryId ?? null,
      decided_at:       record.decidedAt,
    });

  if (insertError) {
    if (insertError.code === '23505') {
      // Lost a check-then-act race. Resolve against what actually landed:
      // same decision → idempotent completion; different → typed violation.
      const winner = await getExistingDecision(item.id);
      if (winner && winner.decision === decision) {
        await runSideEffects(item, decision, winner.decidedAt);
        await closeQueueRow(item.id, winner.decidedAt);
        return winner;
      }
      throw new FinalityViolationError(
        item.id,
        decision,
        winner?.decision ?? decision,
      );
    }
    throw new Error(
      `[reviewQueue] Decision INSERT failed for item "${item.id}": ${insertError.message}`,
    );
  }

  // ── 4. Side effects — only the winning racer reaches this line ─────────
  await runSideEffects(item, decision, decidedAt);

  // ── 5. Close the queue row (non-fatal) ─────────────────────────────────
  await closeQueueRow(item.id, decidedAt);

  return record;
}
