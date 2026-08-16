// src/lib/review/queueRow.ts
//
// Single source of truth for mapping a snake_case review_queue row (as
// returned by Supabase) into a domain ReviewItem. Shared by:
//   - src/app/api/review/[id]/route.ts  (server, decision POST)
//   - src/app/review/page.tsx           (client, queue rendering)
//
// Why this file exists: the two sites previously mapped rows independently
// and BOTH dropped `merchSource` from merch_meta — so ReviewCard's merch
// source badge could never display, and the decision handler never saw the
// sourcing metadata. One mapper, tested, used everywhere.
//
// Pure module: imports types only — safe to bundle into client components.

import type { ReviewItem, MerchSourceType, Brand, GenerationLane } from '../../types/media';

const MERCH_SOURCE_VALUES: ReadonlySet<MerchSourceType> = new Set([
  'gallery_reuse',
  'catalog_search',
  'ai_touchup',
]);

const BRAND_VALUES: ReadonlySet<Brand> = new Set(['misfit', 'forge']);

const LANE_VALUES: ReadonlySet<GenerationLane> = new Set([
  'fresh_text_card',
  'recombination',
  'procedural',
  'ai_touchup',
]);

/** Loose snake_case shape of a review_queue row (Supabase returns unknown). */
export interface ReviewQueueRowLike {
  id?: unknown;
  image_url?: unknown;
  brand?: unknown;
  lane?: unknown;
  source_data?: unknown;
  oracle_result?: unknown;
  merch_meta?: unknown;
  queued_at?: unknown;
}

/**
 * Maps a review_queue row to a ReviewItem.
 *
 * Defensive by design: field values are validated against the domain enums
 * and fall back to safe defaults rather than trusting the database blindly.
 * Rows are written by this engine's own orchestrator, but the mapper must
 * never crash the review UI on unexpected data.
 */
export function queueRowToReviewItem(row: ReviewQueueRowLike): ReviewItem {
  const brand: Brand = BRAND_VALUES.has(row.brand as Brand)
    ? (row.brand as Brand)
    : 'misfit';

  const lane: GenerationLane = LANE_VALUES.has(row.lane as GenerationLane)
    ? (row.lane as GenerationLane)
    : 'procedural';

  const merchMeta = row.merch_meta as { source?: unknown } | null | undefined;
  const merchSource =
    merchMeta &&
    typeof merchMeta.source === 'string' &&
    MERCH_SOURCE_VALUES.has(merchMeta.source as MerchSourceType)
      ? (merchMeta.source as MerchSourceType)
      : undefined;

  const sourceDetail =
    merchMeta !== null && merchMeta !== undefined
      ? JSON.stringify(merchMeta)
      : undefined;

  return {
    id: String(row.id ?? ''),
    imageUrl: String(row.image_url ?? ''),
    brand,
    generationLane: lane,
    sourceData:
      row.source_data !== null &&
      row.source_data !== undefined &&
      typeof row.source_data === 'object'
        ? (row.source_data as Record<string, unknown>)
        : {},
    createdAt: Number(row.queued_at ?? 0),
    oracleResult: (row.oracle_result ?? {
      passed: false,
      reasons: ['oracle_result_missing'],
      checkedAt: 0,
    }) as ReviewItem['oracleResult'],
    ...(merchSource ? { merchSource } : {}),
    ...(sourceDetail ? { sourceDetail } : {}),
  };
}
