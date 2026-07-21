// tests/mediaEngine.test.ts
// Vitest unit suite for core Media Engine logic.
//
// All tests use in-memory mock adapters — no network calls, no Supabase.
// The mock store's list() filter signature matches the AssetStore interface
// exactly, which was broken in the original (it used Partial<GalleryAsset>).

import { describe, it, expect, beforeEach } from 'vitest';

import {
  addToGallery,
  onPostApproved,
  DuplicateAssetError,
} from '../src/lib/permanentAssets';
import type { AssetStore } from '../src/lib/permanentAssets';

import { runPrefilter } from '../src/lib/oracle/prefilter';

import {
  selectDeterministicBase,
  NoEligibleBaseError,
} from '../src/lib/lanes/recombination';

import { findMerchandiseCandidate, CatalogUnavailableError } from '../src/lib/merch/sourcing';
import type {
  ProductCatalogClient,
  GalleryMatcher,
} from '../src/lib/merch/sourcing';

import type { GalleryAsset, ReviewItem, AssetFilter } from '../src/types/media';

// ── In-memory mock store ──────────────────────────────────────────────────────
// List filter signature intentionally matches the AssetStore interface
// (AssetFilter), not Partial<GalleryAsset>.

class MockAssetStore implements AssetStore {
  private readonly assets = new Map<string, GalleryAsset>();

  async get(id: string): Promise<GalleryAsset | undefined> {
    return this.assets.get(id);
  }

  async insert(asset: GalleryAsset): Promise<void> {
    if (this.assets.has(asset.id)) {
      throw new DuplicateAssetError(asset.id);
    }
    this.assets.set(asset.id, asset);
  }

  async list(filter?: AssetFilter): Promise<GalleryAsset[]> {
    let results = Array.from(this.assets.values());

    if (filter?.brand !== undefined) {
      results = results.filter((a) => a.brand === filter.brand);
    }
    if (filter?.category !== undefined) {
      results = results.filter((a) => a.category === filter.category);
    }

    return results;
  }

  /** Test helper: expose current size for assertions. */
  size(): number {
    return this.assets.size;
  }
}

// ── Shared fixtures ───────────────────────────────────────────────────────────

function makeAsset(overrides: Partial<GalleryAsset> = {}): GalleryAsset {
  return {
    id:        'asset-001',
    url:       'https://example.com/asset.jpg',
    brand:     'misfit',
    category:  'art',
    forSale:   false,
    source:    'seed',
    addedAt:   1_000_000,
    permanent: true,
    ...overrides,
  };
}

function makeReviewItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id:             'review-001',
    imageUrl:       'https://example.com/item.png',
    brand:          'misfit',
    generationLane: 'recombination',
    createdAt:      Date.now(),
    sourceData:     {},
    oracleResult:   { passed: true, reasons: [], checkedAt: Date.now() },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1: AssetStore Immutability
// ─────────────────────────────────────────────────────────────────────────────

describe('AssetStore — immutability invariants', () => {
  let store: MockAssetStore;

  beforeEach(() => {
    store = new MockAssetStore();
  });

  it('inserts a new asset successfully', async () => {
    await addToGallery(store, makeAsset());
    expect(store.size()).toBe(1);
  });

  it('throws DuplicateAssetError on ID collision', async () => {
    const asset = makeAsset();
    await addToGallery(store, asset);

    await expect(addToGallery(store, asset)).rejects.toThrow(DuplicateAssetError);
  });

  it('DuplicateAssetError carries the colliding asset ID', async () => {
    const asset = makeAsset({ id: 'target-id' });
    await addToGallery(store, asset);

    const err = await addToGallery(store, asset).catch((e) => e);
    expect(err).toBeInstanceOf(DuplicateAssetError);
    expect((err as DuplicateAssetError).assetId).toBe('target-id');
  });

  it('onPostApproved inserts an approved_post asset on first call', async () => {
    const item = makeReviewItem({ id: 'item-abc' });
    await onPostApproved(store, item);

    const assets = await store.list();
    expect(assets).toHaveLength(1);
    expect(assets[0].id).toBe('item-abc');
    expect(assets[0].category).toBe('approved_post');
    expect(assets[0].source).toBe('generated_and_approved');
  });

  it('onPostApproved is idempotent — second call is a silent no-op', async () => {
    const item = makeReviewItem();
    await onPostApproved(store, item);
    await expect(onPostApproved(store, item)).resolves.toBeUndefined();
    expect(store.size()).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: Oracle Prefilter
// ─────────────────────────────────────────────────────────────────────────────

describe('Oracle Prefilter — content gate', () => {
  it('passes a clean item with no overlay text', () => {
    const result = runPrefilter({
      imageUrl: 'https://example.com/valid.jpg',
      brand:    'misfit',
      lane:     'recombination',
    });
    expect(result.passed).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it('fails on a malformed imageUrl', () => {
    const result = runPrefilter({
      imageUrl: 'not-a-url',
      brand:    'misfit',
      lane:     'recombination',
    });
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('image_url_empty_or_malformed');
  });

  it('fails on an empty imageUrl', () => {
    const result = runPrefilter({
      imageUrl: '   ',
      brand:    'misfit',
      lane:     'recombination',
    });
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('image_url_empty_or_malformed');
  });

  it('detects all forbidden keywords present in the overlay text', () => {
    const result = runPrefilter({
      imageUrl:    'https://example.com/valid.jpg',
      brand:       'misfit',
      lane:        'recombination',
      overlayText: 'This is a blessed day of hustle and grind',
    });
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('forbidden_keyword_violation:hustle');
    expect(result.reasons).toContain('forbidden_keyword_violation:blessed');
    expect(result.reasons).toContain('forbidden_keyword_violation:grind');
  });

  it('flags theology absence on long text for theology-required lanes', () => {
    const result = runPrefilter({
      imageUrl:    'https://example.com/valid.jpg',
      brand:       'misfit',
      lane:        'recombination', // theology-required
      // 11 words, no misfit voice keywords
      overlayText: 'The quick brown fox jumps over the lazy dog and runs',
    });
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('theology_absence_in_long_text');
  });

  it('does NOT flag theology absence on non-theology lanes', () => {
    const result = runPrefilter({
      imageUrl:    'https://example.com/valid.jpg',
      brand:       'misfit',
      lane:        'procedural', // NOT in THEOLOGY_REQUIRED_LANES
      overlayText: 'The quick brown fox jumps over the lazy dog and runs',
    });
    // May pass or fail for other reasons, but not theology_absence
    expect(result.reasons).not.toContain('theology_absence_in_long_text');
  });

  it('passes a long text that contains a voice keyword on a required lane', () => {
    const result = runPrefilter({
      imageUrl:    'https://example.com/valid.jpg',
      brand:       'misfit',
      lane:        'fresh_text_card',
      // 11 words; contains "survival" — a misfit voice keyword
      overlayText: 'The story of raw survival is written in the scars',
    });
    expect(result.passed).toBe(true);
  });

  it('flags empty overlay text', () => {
    const result = runPrefilter({
      imageUrl:    'https://example.com/valid.jpg',
      brand:       'misfit',
      lane:        'recombination',
      overlayText: '   ',
    });
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('text_overlay_empty');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3: Recombination Selection Engine
// ─────────────────────────────────────────────────────────────────────────────

describe('Recombination — deterministic base selection', () => {
  const assets: GalleryAsset[] = [
    makeAsset({ id: 'a1', addedAt: 10 }),
    makeAsset({ id: 'a2', addedAt: 20 }),
    makeAsset({ id: 'a3', addedAt: 30 }),
  ];

  it('picks index 0 on first run (lastUsedIndex = -1)', () => {
    const { base, nextIndex } = selectDeterministicBase(assets, -1);
    expect(base.id).toBe('a1');
    expect(nextIndex).toBe(0);
  });

  it('advances to index 1 when lastUsedIndex = 0', () => {
    const { base, nextIndex } = selectDeterministicBase(assets, 0);
    expect(base.id).toBe('a2');
    expect(nextIndex).toBe(1);
  });

  it('advances to index 2 when lastUsedIndex = 1', () => {
    const { base, nextIndex } = selectDeterministicBase(assets, 1);
    expect(base.id).toBe('a3');
    expect(nextIndex).toBe(2);
  });

  it('wraps around to index 0 when lastUsedIndex = 2 (end of list)', () => {
    const { base, nextIndex } = selectDeterministicBase(assets, 2);
    expect(base.id).toBe('a1');
    expect(nextIndex).toBe(0);
  });

  it('throws RangeError on an empty eligible list', () => {
    expect(() => selectDeterministicBase([], 0)).toThrow(RangeError);
  });

  it('sorts by addedAt so insertion order does not affect selection order', () => {
    const shuffled: GalleryAsset[] = [
      makeAsset({ id: 'c', addedAt: 30 }),
      makeAsset({ id: 'a', addedAt: 10 }),
      makeAsset({ id: 'b', addedAt: 20 }),
    ];
    const { base } = selectDeterministicBase(shuffled, -1);
    expect(base.id).toBe('a'); // oldest first
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 4: Merchandise Sourcing Hierarchy
// ─────────────────────────────────────────────────────────────────────────────

describe('Merchandise sourcing — hierarchy enforcement', () => {
  let store: MockAssetStore;

  beforeEach(() => {
    store = new MockAssetStore();
  });

  const BASE_DEPS = {
    merchQuery:      'misfit tee',
    matchThreshold:  0.8,
  };

  it('returns gallery_reuse when matcher confidence meets threshold', async () => {
    const asset = makeAsset({ id: 'gallery-art', category: 'art' });
    await store.insert(asset);

    const matcher: GalleryMatcher = {
      findClosest: () => ({ asset, confidence: 0.95 }),
    };

    const result = await findMerchandiseCandidate('misfit', {
      ...BASE_DEPS,
      assetStore:    store,
      galleryMatcher: matcher,
    });

    expect(result.source).toBe('gallery_reuse');
    expect(result.asset?.id).toBe('gallery-art');
  });

  it('does NOT use gallery_reuse when confidence is below threshold', async () => {
    const asset = makeAsset({ id: 'low-confidence-art', category: 'art' });
    await store.insert(asset);

    const matcher: GalleryMatcher = {
      findClosest: () => ({ asset, confidence: 0.5 }), // below 0.8
    };

    const catalogClient: ProductCatalogClient = {
      search: async () => [{ id: 'catalog-tee', url: 'https://printify.com/tee' }],
    };

    const result = await findMerchandiseCandidate('misfit', {
      ...BASE_DEPS,
      assetStore:    store,
      galleryMatcher: matcher,
      catalogClient,
    });

    expect(result.source).toBe('catalog_search');
  });

  it('returns catalog_search when gallery matcher returns undefined', async () => {
    const matcher: GalleryMatcher = {
      findClosest: () => undefined,
    };

    const catalogClient: ProductCatalogClient = {
      search: async () => [{ id: 'printify-tee', url: 'https://printify.com/123' }],
    };

    const result = await findMerchandiseCandidate('misfit', {
      ...BASE_DEPS,
      assetStore:    store,
      galleryMatcher: matcher,
      catalogClient,
    });

    expect(result.source).toBe('catalog_search');
    expect(result.productUrl).toBe('https://printify.com/123');
    expect(result.needsDesignOverlay).toBe(true);
  });

  it('survives corrupted negative rotation state without selecting undefined', async () => {
    const assets = [
      { id: 'a', url: 'https://x/a.png', brand: 'misfit', category: 'art', forSale: false, source: 'seed', addedAt: 1, permanent: true },
      { id: 'b', url: 'https://x/b.png', brand: 'misfit', category: 'art', forSale: false, source: 'seed', addedAt: 2, permanent: true },
    ] as const;
    // lastUsedIndex below -1 models hand-edited or corrupted rotation_state.
    const { base, nextIndex } = selectDeterministicBase([...assets] as any, -5);
    expect(base).toBeDefined();
    expect(nextIndex).toBeGreaterThanOrEqual(0);
    expect(nextIndex).toBeLessThan(assets.length);
  });

  it('falls to ai_touchup when catalog returns an empty array', async () => {
    const matcher: GalleryMatcher = { findClosest: () => undefined };
    const catalogClient: ProductCatalogClient = {
      search: async () => [],
    };

    const result = await findMerchandiseCandidate('misfit', {
      ...BASE_DEPS,
      assetStore:    store,
      galleryMatcher: matcher,
      catalogClient,
    });

    expect(result.source).toBe('ai_touchup');
  });

  it('throws CatalogUnavailableError when catalog client throws — outage must not auto-trigger paid AI', async () => {
    const matcher: GalleryMatcher = { findClosest: () => undefined };
    const catalogClient: ProductCatalogClient = {
      search: async () => { throw new Error('Printify API timed out'); },
    };

    await expect(
      findMerchandiseCandidate('misfit', {
        ...BASE_DEPS,
        assetStore:    store,
        galleryMatcher: matcher,
        catalogClient,
      }),
    ).rejects.toThrow(CatalogUnavailableError);
  });

  it('falls to ai_touchup when no catalog client is provided', async () => {
    const matcher: GalleryMatcher = { findClosest: () => undefined };

    const result = await findMerchandiseCandidate('misfit', {
      ...BASE_DEPS,
      assetStore:    store,
      galleryMatcher: matcher,
      // catalogClient intentionally omitted
    });

    expect(result.source).toBe('ai_touchup');
  });
});
