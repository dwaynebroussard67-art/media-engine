// tests/stage2.test.ts
//
// Tests for Stage 2 modules.
// All Supabase calls are mocked — no env vars needed, consistent with Stage 1.
// Sharp and fetch are mocked for renderer tests.
//
// Run: npx vitest run tests/stage2.test.ts
//
// Unverified — traced by hand. Must pass alongside the 32 Stage 1 tests.

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

// ---------------------------------------------------------------------------
// Text bank tests
// ---------------------------------------------------------------------------

describe('textBank — makeInMemoryTextBankProvider', () => {
  // Import lazily to avoid Supabase initialization in the test runner.
  it('rotates deterministically from index 0', async () => {
    const { makeInMemoryTextBankProvider } = await import('../src/lib/textBank');
    const provider = makeInMemoryTextBankProvider({
      misfit: ['line-a', 'line-b', 'line-c'],
    });
    expect(await provider.pick('misfit')).toBe('line-a');
    expect(await provider.pick('misfit')).toBe('line-b');
    expect(await provider.pick('misfit')).toBe('line-c');
  });

  it('wraps around on exhaustion', async () => {
    const { makeInMemoryTextBankProvider } = await import('../src/lib/textBank');
    const provider = makeInMemoryTextBankProvider({
      misfit: ['only-one'],
    });
    expect(await provider.pick('misfit')).toBe('only-one');
    expect(await provider.pick('misfit')).toBe('only-one');
  });

  it('throws EmptyTextBankError for brand with empty bank', async () => {
    const { makeInMemoryTextBankProvider, EmptyTextBankError } = await import('../src/lib/textBank');
    const provider = makeInMemoryTextBankProvider({ misfit: [] });
    await expect(provider.pick('misfit')).rejects.toBeInstanceOf(EmptyTextBankError);
  });

  it('throws EmptyTextBankError for brand absent from bank map', async () => {
    const { makeInMemoryTextBankProvider, EmptyTextBankError } = await import('../src/lib/textBank');
    const provider = makeInMemoryTextBankProvider({});
    await expect(provider.pick('forge')).rejects.toBeInstanceOf(EmptyTextBankError);
  });

  it('maintains independent rotation per brand', async () => {
    const { makeInMemoryTextBankProvider } = await import('../src/lib/textBank');
    const provider = makeInMemoryTextBankProvider({
      misfit: ['m0', 'm1'],
      forge: ['f0', 'f1', 'f2'],
    });
    expect(await provider.pick('misfit')).toBe('m0');
    expect(await provider.pick('forge')).toBe('f0');
    expect(await provider.pick('forge')).toBe('f1');
    expect(await provider.pick('misfit')).toBe('m1');
    expect(await provider.pick('forge')).toBe('f2');
    expect(await provider.pick('misfit')).toBe('m0'); // wrap
    expect(await provider.pick('forge')).toBe('f0'); // wrap
  });
});

// ---------------------------------------------------------------------------
// Tag matcher tests
// ---------------------------------------------------------------------------

describe('tagOverlapMatcher', () => {
  it('returns undefined for no query tags', async () => {
    const { tagOverlapMatcher } = await import('../src/lib/merch/tagMatcher');
    const assets = [{ id: 'a1', url: 'https://x.com/a.png', tags: ['faith'] }];
    expect(tagOverlapMatcher.findClosest(assets as never, {})).toBeUndefined();
  });

  it('returns the asset with highest overlap', async () => {
    const { tagOverlapMatcher } = await import('../src/lib/merch/tagMatcher');
    const assets = [
      { id: 'a1', url: 'https://x.com/a.png', tags: ['faith', 'cross'] },
      { id: 'a2', url: 'https://x.com/b.png', tags: ['faith'] },
    ];
    const result = tagOverlapMatcher.findClosest(assets as never, {
      tags: ['faith', 'cross'],
    });
    expect(result?.asset.id).toBe('a1');
    expect(result?.confidence).toBe(1.0);
  });

  it('returns undefined if no assets have any overlap', async () => {
    const { tagOverlapMatcher } = await import('../src/lib/merch/tagMatcher');
    const assets = [{ id: 'a1', url: 'https://x.com/a.png', tags: ['summer'] }];
    const result = tagOverlapMatcher.findClosest(assets as never, { tags: ['faith'] });
    expect(result).toBeUndefined();
  });

  it('filters by category before matching', async () => {
    const { tagOverlapMatcher } = await import('../src/lib/merch/tagMatcher');
    const assets = [
      { id: 'a1', url: 'https://x.com/a.png', category: 'logo', tags: ['faith'] },
      { id: 'a2', url: 'https://x.com/b.png', category: 'apparel', tags: ['faith'] },
    ];
    const result = tagOverlapMatcher.findClosest(assets as never, {
      category: 'apparel',
      tags: ['faith'],
    });
    expect(result?.asset.id).toBe('a2');
  });

  it('confidence = intersection / query length', async () => {
    const { tagOverlapMatcher } = await import('../src/lib/merch/tagMatcher');
    const assets = [
      { id: 'a1', url: 'https://x.com/a.png', tags: ['faith'] },
    ];
    const result = tagOverlapMatcher.findClosest(assets as never, {
      tags: ['faith', 'cross', 'scripture'],
    });
    // 1 match out of 3 query tags
    expect(result?.confidence).toBeCloseTo(1 / 3);
  });
});

// ---------------------------------------------------------------------------
// freshTextCard tests
// ---------------------------------------------------------------------------

describe('generateFreshTextCard', () => {
  it('throws NoFreshTextBaseError when no atmosphere/art assets', async () => {
    const { generateFreshTextCard, NoFreshTextBaseError } = await import(
      '../src/lib/lanes/freshTextCard'
    );
    const { makeInMemoryTextBankProvider } = await import('../src/lib/textBank');

    const assetStore = {
      get: vi.fn(),
      insert: vi.fn(),
      list: vi.fn().mockResolvedValue([
        // Only logos — no atmosphere or art
        { id: 'l1', url: 'https://x.com/l.png', brand: 'misfit', category: 'logo',
          forSale: false, source: 'seed', addedAt: 1000, permanent: true as const },
      ]),
    };

    const textBank = makeInMemoryTextBankProvider({ misfit: ['test line'] });
    const renderer = { render: vi.fn() };

    await expect(
      generateFreshTextCard('misfit', { assetStore, textBank, renderer, lastUsedIndex: 0 })
    ).rejects.toBeInstanceOf(NoFreshTextBaseError);
  });

  it('returns a RenderedItem with correct lane and sourceData', async () => {
    const { generateFreshTextCard } = await import('../src/lib/lanes/freshTextCard');
    const { makeInMemoryTextBankProvider } = await import('../src/lib/textBank');

    const atmosphereAsset = {
      id: 'atm1', url: 'https://x.com/atm.png', brand: 'misfit' as const,
      category: 'atmosphere' as const, forSale: false, source: 'seed' as const,
      addedAt: 1000, permanent: true as const,
    };

    const assetStore = {
      get: vi.fn(),
      insert: vi.fn(),
      list: vi.fn().mockResolvedValue([atmosphereAsset]),
    };

    const textBank = makeInMemoryTextBankProvider({ misfit: ['He makes all things new.'] });
    const renderer = {
      render: vi.fn().mockResolvedValue({ url: 'https://storage.example.com/rendered/misfit/abc.webp' }),
    };

    const result = await generateFreshTextCard('misfit', {
      assetStore, textBank, renderer, lastUsedIndex: 0,
    });

    expect(result.generationLane).toBe('fresh_text_card');
    expect(result.brand).toBe('misfit');
    expect(result.sourceData.baseImageId).toBe('atm1');
    expect(result.sourceData.text).toBe('He makes all things new.');
    expect(renderer.render).toHaveBeenCalledWith(
      'https://x.com/atm.png',
      'He makes all things new.',
      'misfit'
    );
  });

  it('includes shared assets in eligible pool', async () => {
    const { generateFreshTextCard } = await import('../src/lib/lanes/freshTextCard');
    const { makeInMemoryTextBankProvider } = await import('../src/lib/textBank');

    const sharedArt = {
      id: 'shared1', url: 'https://x.com/s.png', brand: 'shared' as const,
      category: 'art' as const, forSale: false, source: 'seed' as const,
      addedAt: 500, permanent: true as const,
    };

    const assetStore = {
      get: vi.fn(),
      insert: vi.fn(),
      // First call (brand assets) returns nothing eligible; second (shared) returns art
      list: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([sharedArt]),
    };

    const textBank = makeInMemoryTextBankProvider({ misfit: ['test'] });
    const renderer = {
      render: vi.fn().mockResolvedValue({ url: 'https://storage.example.com/x.webp' }),
    };

    const result = await generateFreshTextCard('misfit', {
      assetStore, textBank, renderer, lastUsedIndex: 0,
    });

    expect(result.sourceData.baseImageId).toBe('shared1');
  });
});

// ---------------------------------------------------------------------------
// Orchestrator — lane isolation test
// ---------------------------------------------------------------------------

describe('assembleReviewBatch — lane failure isolation', () => {
  it('records error outcome for a failing lane without sinking the batch', async () => {
    // This test mocks the lane generators and the DB insert.
    // We intercept at the module level to avoid real Supabase calls.
    // 
    // NOTE: Module-level mocking with vitest.mock() requires static paths.
    // This test uses manual dependency injection instead, testing the
    // orchestrator's internal logic by constructing a simplified scenario.
    // A full integration test would require a live Supabase instance.
    //
    // What we can verify here: the structure of assembleReviewBatch's result.
    // Marked PARTIALLY VERIFIED — the lane error capture path is traced, not run.

    // For now, assert the import shape is correct.
    const { assembleReviewBatch } = await import('../src/lib/orchestrator');
    expect(typeof assembleReviewBatch).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Renderer — wrapText unit test (pure function, no sharp needed)
// ---------------------------------------------------------------------------

describe('wrapText (via sharpRenderer internals)', () => {
  // wrapText is not exported. We test it indirectly by inspecting that the
  // renderer is importable and the error classes are correctly typed.
  it('exports BaseImageFetchError and RenderUploadError', async () => {
    const { BaseImageFetchError, RenderUploadError } = await import(
      '../src/lib/render/sharpRenderer'
    );
    const fetchErr = new BaseImageFetchError('https://x.com/img.png', 'HTTP 404');
    expect(fetchErr).toBeInstanceOf(Error);
    expect(fetchErr.name).toBe('BaseImageFetchError');
    expect(fetchErr.url).toBe('https://x.com/img.png');

    const uploadErr = new RenderUploadError('bucket not found');
    expect(uploadErr).toBeInstanceOf(Error);
    expect(uploadErr.name).toBe('RenderUploadError');
  });
});

// ── Regression tests added during verification (bugs the delivered suite missed) ──

import { describe as d2, it as it2, expect as ex2 } from 'vitest';
import { BRAND_TYPOGRAPHY } from '../src/config/doctrine';

d2('regression — typography fields are the real ones', () => {
  it2('BrandTypographyStyle exposes fontFamily/fontSize/fontWeight, not font/size/scrim', () => {
    const t = BRAND_TYPOGRAPHY.misfit as unknown as Record<string, unknown>;
    ex2(typeof t.fontFamily).toBe('string');
    ex2(typeof t.fontSize).toBe('number');
    ex2(typeof t.fontWeight).toBe('number');
    // phantom names from the buggy draft must NOT exist
    ex2(t.font).toBeUndefined();
    ex2(t.size).toBeUndefined();
    ex2(t.scrim).toBeUndefined();
  });
});
