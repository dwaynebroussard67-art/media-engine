// tests/sourcingTags.test.ts
//
// Regression tests for the merch gallery_reuse tier.
//
// Bugs pinned here:
//   1. findMerchandiseCandidate called the GalleryMatcher WITHOUT query
//      tags — the tag-overlap matcher returns undefined for tagless queries
//      by contract, so gallery reuse could never fire and the strict
//      hierarchy silently degenerated to catalog-or-AI.
//   2. supabaseAssetStore dropped the migration-002 `tags` column in
//      rowToAsset, so even a correct query could never score an asset.
//
// These tests exercise the REAL sourcing + tagOverlapMatcher modules —
// no mocks for the units under test.

import { describe, it, expect } from 'vitest';

import { findMerchandiseCandidate } from '../src/lib/merch/sourcing';
import { tagOverlapMatcher } from '../src/lib/merch/tagMatcher';
import type { GalleryAsset } from '../src/types/media';

function makeArt(id: string, tags: string[], addedAt = 1000): GalleryAsset {
  return {
    id,
    url: `https://storage.example.com/${id}.png`,
    brand: 'misfit',
    category: 'art',
    forSale: false,
    source: 'seed',
    addedAt,
    permanent: true,
    // tags rides along via the documented row-boundary intersection type —
    // exactly how the Supabase store surfaces migration-002 tags.
    ...(tags.length > 0 ? { tags } : {}),
  } as GalleryAsset & { tags?: string[] };
}

describe('findMerchandiseCandidate — gallery reuse with tag overlap', () => {
  it('derives query tags from merchQuery and returns gallery_reuse above threshold', async () => {
    const asset = makeArt('tagged-art', ['misfit', 'tee']);

    const result = await findMerchandiseCandidate('misfit', {
      assetStore: {
        get: async () => undefined,
        insert: async () => undefined,
        list: async () => [asset],
      },
      galleryMatcher: tagOverlapMatcher,
      merchQuery: 'misfit tee',
      matchThreshold: 0.5,
    });

    expect(result.source).toBe('gallery_reuse');
    expect(result.asset?.id).toBe('tagged-art');
  });

  it('passes the derived tags to the matcher (matcher must never be called tagless)', async () => {
    let seenTags: string[] | undefined;

    const result = await findMerchandiseCandidate('misfit', {
      assetStore: {
        get: async () => undefined,
        insert: async () => undefined,
        list: async () => [],
      },
      galleryMatcher: {
        findClosest: (_assets, opts) => {
          seenTags = opts.tags;
          return undefined;
        },
      },
      merchQuery: 'Forge Hoodie',
      matchThreshold: 0.5,
    });

    // Lowercased word split of the merch query — case-insensitive overlap.
    expect(seenTags).toEqual(['forge', 'hoodie']);
    expect(result.source).toBe('ai_touchup'); // no assets, no catalog → exhausted
  });

  it('still falls through to catalog_search when tagged assets do not meet the threshold', async () => {
    const asset = makeArt('unrelated-art', ['ocean']);

    const result = await findMerchandiseCandidate('misfit', {
      assetStore: {
        get: async () => undefined,
        insert: async () => undefined,
        list: async () => [asset],
      },
      galleryMatcher: tagOverlapMatcher,
      catalogClient: {
        search: async () => [{ id: 'tee-1', url: 'https://printify.example.com/tee-1' }],
      },
      merchQuery: 'misfit tee',
      matchThreshold: 0.5,
    });

    // 'ocean' overlaps none of ['misfit','tee'] → confidence 0 → below threshold.
    expect(result.source).toBe('catalog_search');
  });
});
