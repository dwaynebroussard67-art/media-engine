// src/lib/orchestrator.ts
//
// Batch orchestrator: assembles a review batch by running lanes 1a, 1b,
// and merch sourcing, prefiltering every candidate, and inserting passing
// items into review_queue with a shared batch_id.
//
// One lane failing does NOT sink the batch. Per-lane outcomes are recorded.
// Oracle-failed items are inserted with their oracle_result but are not
// shown in the default review view.
//
// Unverified — traced by hand.

import { randomUUID } from 'crypto';
import { getSupabaseAdmin } from './supabaseClient';
import { runPrefilter } from './oracle/prefilter';
import { generateFreshTextCard } from './lanes/freshTextCard';
import { generateRecombinationPost } from './lanes/recombination';
import { findMerchandiseCandidate, CatalogUnavailableError } from './merch/sourcing';
import type { AssetStore } from './permanentAssets';
import type { TextBankProvider } from './textBank';
import type { TextOverlayRenderer } from './lanes/recombination';
import type { ProductCatalogClient, GalleryMatcher } from './merch/sourcing';
import type { Brand, RenderedItem, MerchCandidate } from '../types/media';
import type { OracleResult } from '../types/media';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LaneName = 'fresh_text_card' | 'recombination' | 'merch';

export interface LaneOutcome {
  lane: LaneName;
  status: 'ok' | 'empty' | 'error';
  itemsQueued: number;
  error?: string; // set when status === 'error'
}

export interface BatchResult {
  batchId: string;
  queued: number;
  laneOutcomes: Record<LaneName, LaneOutcome>;
}

// ---------------------------------------------------------------------------
// review_queue insert helper
// ---------------------------------------------------------------------------

interface QueueInsertRow {
  id: string;
  batch_id: string;
  brand: Brand;
  lane: string;
  image_url: string;
  source_data: Record<string, unknown>;
  oracle_result: OracleResult;
  merch_meta: MerchCandidate | null;
  queued_at: number;
  status: 'pending' | 'decided';
  decided_at: null;
}

async function insertQueueRow(row: QueueInsertRow): Promise<void> {
  const db = getSupabaseAdmin();
  const { error } = await db.from('review_queue').insert({
    id: row.id,
    batch_id: row.batch_id,
    brand: row.brand,
    lane: row.lane,
    image_url: row.image_url,
    source_data: row.source_data,
    oracle_result: row.oracle_result,
    merch_meta: row.merch_meta,
    queued_at: row.queued_at,
    status: row.status,
    decided_at: row.decided_at,
  });

  if (error) {
    throw new Error(`review_queue insert failed for item ${row.id}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Merch sourcing helper — wraps findMerchandiseCandidate to produce a
// review item. CatalogUnavailableError surfaces as a lane-level error.
// ---------------------------------------------------------------------------

const DEFAULT_MERCH_QUERY: Record<Brand, string> = {
  misfit: 'misfit tee',
  forge: 'forge hoodie',
};
const DEFAULT_MATCH_THRESHOLD = 0.5;

async function runMerchLane(
  brand: Brand,
  batchId: string,
  deps: {
    assetStore: AssetStore;
    catalogClient: ProductCatalogClient;
    galleryMatcher: GalleryMatcher;
    merchQuery: string;
    matchThreshold: number;
  }
): Promise<LaneOutcome> {
  let candidate: MerchCandidate;
  try {
    candidate = await findMerchandiseCandidate(brand, deps);
  } catch (err) {
    if (err instanceof CatalogUnavailableError) {
      return {
        lane: 'merch',
        status: 'error',
        itemsQueued: 0,
        error: `CatalogUnavailableError: ${err.message}`,
      };
    }
    return {
      lane: 'merch',
      status: 'error',
      itemsQueued: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Merch candidates do not have an imageUrl in the same sense as rendered items;
  // we use the asset url or productUrl as the representative image.
  const imageUrl =
    candidate.asset?.url ??
    candidate.productUrl ??
    (typeof candidate.baseProduct === 'object' &&
     candidate.baseProduct !== null &&
     'url' in candidate.baseProduct &&
     typeof (candidate.baseProduct as { url?: unknown }).url === 'string'
       ? (candidate.baseProduct as { url: string }).url
       : '');

  if (!imageUrl) {
    return {
      lane: 'merch',
      status: 'empty',
      itemsQueued: 0,
    };
  }

  const itemId = randomUUID();
  const oracleResult = runPrefilter({
    imageUrl,
    brand,
    lane: 'procedural', // merch is in the procedural lane for oracle purposes
  });

  await insertQueueRow({
    id: itemId,
    batch_id: batchId,
    brand,
    lane: 'procedural',
    image_url: imageUrl,
    source_data: {},
    oracle_result: oracleResult,
    merch_meta: candidate,
    queued_at: Date.now(),
    status: 'pending',
    decided_at: null,
  });

  return { lane: 'merch', status: 'ok', itemsQueued: 1 };
}

// ---------------------------------------------------------------------------
// Per-generation-lane runner
// ---------------------------------------------------------------------------

async function runGenerationLane(
  laneName: 'fresh_text_card' | 'recombination',
  generate: () => Promise<RenderedItem>,
  batchId: string,
  brand: Brand
): Promise<LaneOutcome> {
  let item: RenderedItem;
  try {
    item = await generate();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Distinguish "nothing to work with" from hard errors.
    const status =
      err instanceof Error &&
      (err.name === 'NoFreshTextBaseError' || err.name === 'NoEligibleBaseError')
        ? 'empty'
        : 'error';
    return { lane: laneName, status, itemsQueued: 0, error: msg };
  }

  // Determine overlay text for oracle from sourceData.
  const overlayText =
    typeof item.sourceData.text === 'string' ? item.sourceData.text : undefined;

  const oracleResult = runPrefilter({
    imageUrl: item.imageUrl,
    brand: item.brand,
    lane: item.generationLane,
    overlayText,
  });

  await insertQueueRow({
    id: item.id,
    batch_id: batchId,
    brand,
    lane: item.generationLane,
    image_url: item.imageUrl,
    source_data: item.sourceData,
    oracle_result: oracleResult,
    merch_meta: null,
    queued_at: Date.now(),
    status: 'pending',
    decided_at: null,
  });

  return { lane: laneName, status: 'ok', itemsQueued: 1 };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function assembleReviewBatch(
  brand: Brand,
  deps: {
    assetStore: AssetStore;
    textBank: TextBankProvider;
    renderer: TextOverlayRenderer;
    catalogClient: ProductCatalogClient;
    galleryMatcher: GalleryMatcher;
    lastUsedFreshTextIndex?: number;
    lastUsedRecombinationIndex?: number;
    merchQuery?: string;
    matchThreshold?: number;
  }
): Promise<BatchResult> {
  const batchId = randomUUID();

  const [freshTextOutcome, recombinationOutcome, merchOutcome] = await Promise.allSettled([
    runGenerationLane(
      'fresh_text_card',
      () =>
        generateFreshTextCard(brand, {
          assetStore: deps.assetStore,
          textBank: deps.textBank,
          renderer: deps.renderer,
          lastUsedIndex: deps.lastUsedFreshTextIndex ?? 0,
        }),
      batchId,
      brand
    ),
    runGenerationLane(
      'recombination',
      () =>
        generateRecombinationPost(brand, {
          assetStore: deps.assetStore,
          textBank: deps.textBank,
          renderer: deps.renderer,
        }),
      batchId,
      brand
    ),
    runMerchLane(brand, batchId, {
      assetStore: deps.assetStore,
      catalogClient: deps.catalogClient,
      galleryMatcher: deps.galleryMatcher,
      merchQuery: deps.merchQuery ?? DEFAULT_MERCH_QUERY[brand],
      matchThreshold: deps.matchThreshold ?? DEFAULT_MATCH_THRESHOLD,
    }),
  ]);

  // Unwrap settled results — each lane runner already returns LaneOutcome on
  // its own errors; Promise.allSettled rejection here means a programming bug.
  function unwrap(settled: PromiseSettledResult<LaneOutcome>, lane: LaneName): LaneOutcome {
    if (settled.status === 'fulfilled') return settled.value;
    return {
      lane,
      status: 'error',
      itemsQueued: 0,
      error: `Unhandled rejection: ${settled.reason instanceof Error ? settled.reason.message : String(settled.reason)}`,
    };
  }

  const outcomes: Record<LaneName, LaneOutcome> = {
    fresh_text_card: unwrap(freshTextOutcome, 'fresh_text_card'),
    recombination: unwrap(recombinationOutcome, 'recombination'),
    merch: unwrap(merchOutcome, 'merch'),
  };

  const queued = Object.values(outcomes).reduce((n, o) => n + o.itemsQueued, 0);

  return { batchId, queued, laneOutcomes: outcomes };
}
