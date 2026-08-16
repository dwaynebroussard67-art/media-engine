// tests/stage3.test.ts
// Regression pins for Stage 3 fixes:
//
//  1. Orchestrator rotation bug — `lastUsedFreshTextIndex ?? 0` forced every
//     production batch to base index 0 AND skipped the persisted
//     lane_rotation_state advance (same base re-rendered forever). Overrides
//     must pass through ONLY when defined.
//  2. Orchestrator merch lane now derives tag-overlap query tags from the
//     merch query, making the gallery_reuse hierarchy level reachable.
//  3. Shared review_queue row mapper restores merchSource/sourceDetail
//     (previously dropped — the ReviewCard merch badge could never show).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — orchestrator touches Supabase and the lane generators.
// ---------------------------------------------------------------------------

vi.mock('../src/lib/supabaseClient', () => ({
  getSupabaseAdmin: vi.fn(),
  verifyUserJwt: vi.fn(),
  _resetSupabaseAdminForTesting: vi.fn(),
  SupabaseNotConfiguredError: class SupabaseNotConfiguredError extends Error {},
}));

vi.mock('../src/lib/lanes/freshTextCard', () => ({
  NoFreshTextBaseError: class NoFreshTextBaseError extends Error {},
  generateFreshTextCard: vi.fn(),
}));

vi.mock('../src/lib/lanes/recombination', () => ({
  NoEligibleBaseError: class NoEligibleBaseError extends Error {},
  generateRecombinationPost: vi.fn(),
}));

vi.mock('../src/lib/merch/sourcing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/merch/sourcing')>();
  return { ...actual, findMerchandiseCandidate: vi.fn() };
});

import { getSupabaseAdmin } from '../src/lib/supabaseClient';
import { assembleReviewBatch, deriveMerchQueryTags } from '../src/lib/orchestrator';
import { generateFreshTextCard } from '../src/lib/lanes/freshTextCard';
import { generateRecombinationPost } from '../src/lib/lanes/recombination';
import { findMerchandiseCandidate } from '../src/lib/merch/sourcing';
import { queueRowToReviewItem } from '../src/lib/review/queueRow';
import type {
  AssetStore,
} from '../src/lib/permanentAssets';
import type { GalleryAsset, RenderedItem, ReviewItem } from '../src/types/media';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFakeDb() {
  const inserted: Array<Record<string, unknown>> = [];
  const client = {
    from(table: string) {
      if (table === 'review_queue') {
        return {
          insert: async (row: Record<string, unknown>) => {
            inserted.push(row);
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { client, inserted };
}

function makeAsset(overrides: Partial<GalleryAsset> = {}): GalleryAsset {
  return {
    id: 'a1',
    url: 'https://example.com/a.png',
    brand: 'misfit',
    category: 'art',
    forSale: false,
    source: 'seed',
    addedAt: 1000,
    permanent: true,
    ...overrides,
  };
}

function makeRenderedItem(lane: 'fresh_text_card' | 'recombination'): RenderedItem {
  return {
    id: `item-${lane}`,
    imageUrl: 'https://example.com/rendered.png',
    brand: 'misfit',
    generationLane: lane,
    sourceData: { text: 'He makes all things new. Even you.' },
    createdAt: 1,
  };
}

const emptyAssetStore: AssetStore = {
  get: vi.fn().mockResolvedValue(undefined),
  insert: vi.fn().mockResolvedValue(undefined),
  list: vi.fn().mockResolvedValue([]),
};

function baseDeps() {
  return {
    assetStore: emptyAssetStore,
    textBank: { pick: vi.fn().mockResolvedValue('line') },
    renderer: { render: vi.fn().mockResolvedValue({ url: 'https://example.com/r.png' }) },
    catalogClient: { search: vi.fn().mockResolvedValue([]) },
    galleryMatcher: { findClosest: vi.fn().mockReturnValue(undefined) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Orchestrator — rotation overrides must stay test-only
// ---------------------------------------------------------------------------

describe('assembleReviewBatch — rotation override pass-through', () => {
  beforeEach(() => {
    vi.mocked(generateFreshTextCard).mockResolvedValue(makeRenderedItem('fresh_text_card'));
    vi.mocked(generateRecombinationPost).mockResolvedValue(makeRenderedItem('recombination'));
    vi.mocked(findMerchandiseCandidate).mockResolvedValue({
      source: 'gallery_reuse',
      asset: makeAsset(),
      detail: 'reused asset: a1 (tag overlap confidence: 1.00)',
    });
  });

  it('does NOT inject a rotation override when none is supplied (persistence stays live)', async () => {
    const db = makeFakeDb();
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as never);

    await assembleReviewBatch('misfit', baseDeps());

    // The whole point: no `lastUsedIndex` key → lanes read and advance their
    // persisted rotation state (lane_rotation_state / rotation_state).
    const freshCall = vi.mocked(generateFreshTextCard).mock.calls[0];
    const recombCall = vi.mocked(generateRecombinationPost).mock.calls[0];
    expect(freshCall[0]).toBe('misfit');
    expect(freshCall[1]).not.toHaveProperty('lastUsedIndex');
    expect(recombCall[0]).toBe('misfit');
    expect(recombCall[1]).not.toHaveProperty('lastUsedIndex');
  });

  it('passes explicitly supplied overrides through verbatim', async () => {
    const db = makeFakeDb();
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as never);

    await assembleReviewBatch('misfit', {
      ...baseDeps(),
      lastUsedFreshTextIndex: 4,
      lastUsedRecombinationIndex: 2,
    });

    expect(vi.mocked(generateFreshTextCard).mock.calls[0][1].lastUsedIndex).toBe(4);
    expect(vi.mocked(generateRecombinationPost).mock.calls[0][1].lastUsedIndex).toBe(2);
  });

  it('derives tag-overlap query tags from the merch query and passes them through', async () => {
    const db = makeFakeDb();
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as never);

    await assembleReviewBatch('misfit', baseDeps());

    // Default merch query for misfit is 'misfit tee'.
    const merchCall = vi.mocked(findMerchandiseCandidate).mock.calls[0];
    expect(merchCall[0]).toBe('misfit');
    expect(merchCall[1].queryTags).toEqual(['misfit', 'tee']);
  });

  it('queues one review_queue row per successful lane', async () => {
    const db = makeFakeDb();
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as never);

    const result = await assembleReviewBatch('misfit', baseDeps());

    expect(result.queued).toBe(3);
    expect(db.inserted).toHaveLength(3);
    const lanes = db.inserted.map((r) => r.lane).sort();
    expect(lanes).toEqual(['fresh_text_card', 'procedural', 'recombination']);
  });
});

// ---------------------------------------------------------------------------
// deriveMerchQueryTags — pure
// ---------------------------------------------------------------------------

describe('deriveMerchQueryTags', () => {
  it('splits a merch query into lowercase word tokens', () => {
    expect(deriveMerchQueryTags('misfit tee')).toEqual(['misfit', 'tee']);
  });

  it('strips punctuation from tokens', () => {
    expect(deriveMerchQueryTags('Forge Hoodie!  (heavy)')).toEqual([
      'forge',
      'hoodie',
      'heavy',
    ]);
  });

  it('returns an empty list for blank input', () => {
    expect(deriveMerchQueryTags('   ')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// queueRowToReviewItem — shared row mapper
// ---------------------------------------------------------------------------

describe('queueRowToReviewItem', () => {
  it('maps a plain generation-lane row', () => {
    const item = queueRowToReviewItem({
      id: 'i1',
      image_url: 'https://example.com/i.png',
      brand: 'misfit',
      lane: 'fresh_text_card',
      source_data: { text: 'He makes all things new.' },
      oracle_result: { passed: true, reasons: [], checkedAt: 1 },
      merch_meta: null,
      queued_at: 5,
    });

    expect(item.id).toBe('i1');
    expect(item.imageUrl).toBe('https://example.com/i.png');
    expect(item.brand).toBe('misfit');
    expect(item.generationLane).toBe('fresh_text_card');
    expect(item.createdAt).toBe(5);
    expect(item.sourceData.text).toBe('He makes all things new.');
  });

  it('restores merchSource and sourceDetail from merch_meta (badge can render)', () => {
    const item = queueRowToReviewItem({
      id: 'i2',
      image_url: 'https://example.com/i.png',
      brand: 'forge',
      lane: 'procedural',
      source_data: {},
      oracle_result: { passed: true, reasons: [], checkedAt: 2 },
      merch_meta: { source: 'catalog_search', productUrl: 'https://printify.example/p/1' },
      queued_at: 9,
    });

    expect(item.merchSource).toBe('catalog_search');
    expect(item.sourceDetail).toContain('catalog_search');
    expect(item.sourceDetail).toContain('printify.example');
  });

  it('drops an unrecognized merch source value instead of trusting it', () => {
    const item = queueRowToReviewItem({
      id: 'i3',
      image_url: 'https://example.com/i.png',
      brand: 'misfit',
      lane: 'procedural',
      source_data: {},
      oracle_result: { passed: true, reasons: [], checkedAt: 3 },
      merch_meta: { source: 'dark_magic' },
      queued_at: 10,
    });

    expect(item.merchSource).toBeUndefined();
  });

  it('survives a garbage row with safe defaults (never crashes the UI)', () => {
    const item: ReviewItem = queueRowToReviewItem({});

    expect(item.brand).toBe('misfit');
    expect(item.generationLane).toBe('procedural');
    expect(item.imageUrl).toBe('');
    expect(item.createdAt).toBe(0);
    expect(item.oracleResult.passed).toBe(false);
    expect(item.oracleResult.reasons).toContain('oracle_result_missing');
  });
});
