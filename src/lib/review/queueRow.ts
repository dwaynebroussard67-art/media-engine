// src/lib/review/queueRow.ts
//
// ONE mapper from a `review_queue` row to the domain `ReviewItem`.
//
// Why this file exists (red-team finding, 2026-10-15): the merch_meta →
// (merchSource, sourceDetail) mapping was fixed twice already (DEBUG-REPORT
// Bug 5) because it lived in two places — the review page and
// /api/review/[id]. The setup/verification tooling needs the same mapping, so
// a third and fourth copy would have been written. Copies of this logic is
// exactly how the badge silently disappeared the first time. Now there is one
// implementation and every caller imports it.
//
// Row-boundary posture: Supabase returns untyped rows here (no generated
// Database types exist for misfit-backend), so narrowing happens at this
// boundary and nowhere else. No `any` — the row shape is declared structurally.

import type { ReviewItem, OracleResult } from '../../types/media';

/**
 * Structural shape of a `review_queue` row as returned by PostgREST.
 * Only the fields this mapper reads are declared.
 */
export interface ReviewQueueRow {
  id: string;
  brand: string;
  lane: string;
  image_url: string;
  source_data?: unknown;
  oracle_result?: unknown;
  merch_meta?: unknown;
  queued_at: number;
  status?: string;
  batch_id?: string;
}

export interface MerchMetaFields {
  merchSource?: ReviewItem['merchSource'];
  sourceDetail?: string;
}

/**
 * Extracts the two display fields ReviewCard needs from a `merch_meta`
 * (MerchCandidate) column value. Returns an empty object when merch_meta is
 * null / not an object / missing the expected fields — the fields are then
 * simply omitted from the ReviewItem (never fabricated).
 */
export function merchMetaToFields(merchMeta: unknown): MerchMetaFields {
  const merch =
    merchMeta !== null && typeof merchMeta === 'object'
      ? (merchMeta as { source?: unknown; detail?: unknown })
      : null;

  const merchSource =
    merch && typeof merch.source === 'string'
      ? (merch.source as ReviewItem['merchSource'])
      : undefined;

  const sourceDetail =
    merch && typeof merch.detail === 'string' ? merch.detail : undefined;

  return {
    ...(merchSource ? { merchSource } : {}),
    ...(sourceDetail ? { sourceDetail } : {}),
  };
}

/**
 * Rebuilds a ReviewItem from a queue row.
 *
 * brand / lane / oracle_result are narrowed by casts, not validated: the
 * Postgres layer constrains brand and lane with CHECK constraints and the
 * orchestrator is the only writer of oracle_result. Validating them here
 * would be theater — the DB is the authority.
 */
export function queueRowToReviewItem(row: ReviewQueueRow): ReviewItem {
  return {
    id: row.id,
    imageUrl: row.image_url,
    brand: row.brand as ReviewItem['brand'],
    generationLane: row.lane as ReviewItem['generationLane'],
    sourceData: (row.source_data ?? {}) as Record<string, unknown>,
    createdAt: row.queued_at,
    oracleResult: (row.oracle_result ?? {
      passed: false,
      reasons: ['oracle_result_missing'],
      checkedAt: 0,
    }) as OracleResult,
    ...merchMetaToFields(row.merch_meta),
  };
}
