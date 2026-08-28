// tests/regressions.test.ts
//
// Regression tests for the 2026-08 debug pass. Each test pins a production
// bug that was invisible to typecheck and the existing suites:
//
//   1. Orchestrator must NOT default lastUsedFreshTextIndex to 0 — the lane
//      treats a defined index as a test override and skips reading AND
//      persisting lane_rotation_state, which froze fresh-text rotation on
//      the first base forever.
//
// Supabase, lane generators, and merch sourcing are mocked; no env needed.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateFreshTextCard = vi.fn();
const generateRecombinationPost = vi.fn();
const findMerchandiseCandidate = vi.fn();

vi.mock('../src/lib/lanes/freshTextCard', () => ({
  generateFreshTextCard: (...args: unknown[]) => generateFreshTextCard(...args),
}));

vi.mock('../src/lib/lanes/recombination', () => ({
  generateRecombinationPost: (...args: unknown[]) => generateRecombinationPost(...args),
}));

vi.mock('../src/lib/merch/sourcing', () => ({
  findMerchandiseCandidate: (...args: unknown[]) => findMerchandiseCandidate(...args),
  CatalogUnavailableError: class CatalogUnavailableError extends Error {
    constructor(cause: string) {
      super(`catalog unavailable: ${cause}`);
      this.name = 'CatalogUnavailableError';
    }
  },
}));

vi.mock('../src/lib/supabaseClient', () => ({
  getSupabaseAdmin: vi.fn(() => ({
    from: () => ({
      insert: () => Promise.resolve({ error: null }),
    }),
  })),
  verifyUserJwt: vi.fn(),
  _resetSupabaseAdminForTesting: vi.fn(),
}));

function makeItem(lane: string) {
  return {
    id: `item-${lane}-${Math.random().toString(36).slice(2, 8)}`,
    imageUrl: 'https://storage.example.com/rendered/x.webp',
    brand: 'misfit' as const,
    generationLane: lane,
    sourceData: { text: 'Still here. Still held.' },
    createdAt: Date.now(),
  };
}

// Minimal typed stubs — the real lane modules are mocked, so these are
// never exercised; they only satisfy assembleReviewBatch's signature.
const baseDeps = () => ({
  assetStore: {
    get: async () => undefined,
    insert: async () => undefined,
    list: async () => [],
  },
  textBank: { pick: async () => 'stub line' },
  renderer: { render: async () => ({ url: 'https://stub.example.com/x.webp' }) },
  catalogClient: { search: async () => [] },
  galleryMatcher: { findClosest: () => undefined },
});

describe('assembleReviewBatch — fresh-text rotation passthrough (regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generateFreshTextCard.mockResolvedValue(makeItem('fresh_text_card'));
    generateRecombinationPost.mockResolvedValue(makeItem('recombination'));
    findMerchandiseCandidate.mockResolvedValue({
      source: 'catalog_search',
      productUrl: 'https://printify.example.com/p1',
      detail: 'catalog product: p1',
    });
  });

  it('passes NO lastUsedIndex override when the caller provides none — the lane must read AND persist lane_rotation_state itself', async () => {
    const { assembleReviewBatch } = await import('../src/lib/orchestrator');

    await assembleReviewBatch('misfit', baseDeps());

    expect(generateFreshTextCard).toHaveBeenCalledTimes(1);
    const depsArg = generateFreshTextCard.mock.calls[0][1] as {
      lastUsedIndex?: number;
    };
    // `undefined` is the contract: the lane reads lane_rotation_state and
    // advances it after a successful render. A defined value (0 included)
    // silently disables persistence.
    expect(depsArg.lastUsedIndex).toBeUndefined();
  });

  it('passes an explicit lastUsedFreshTextIndex override through untouched', async () => {
    const { assembleReviewBatch } = await import('../src/lib/orchestrator');

    await assembleReviewBatch('misfit', { ...baseDeps(), lastUsedFreshTextIndex: 3 });

    const depsArg = generateFreshTextCard.mock.calls[0][1] as {
      lastUsedIndex?: number;
    };
    expect(depsArg.lastUsedIndex).toBe(3);
  });

  it('a batch with all three lanes still queues all items and reports outcomes', async () => {
    const { assembleReviewBatch } = await import('../src/lib/orchestrator');

    const result = await assembleReviewBatch('misfit', baseDeps());

    expect(result.queued).toBe(3);
    expect(result.laneOutcomes.fresh_text_card.status).toBe('ok');
    expect(result.laneOutcomes.recombination.status).toBe('ok');
    expect(result.laneOutcomes.merch.status).toBe('ok');
  });
});
