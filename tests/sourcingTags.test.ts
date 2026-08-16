// tests/sourcingTags.test.ts
// Pins the merch sourcing query-tags pass-through:
//
//   - queryTags (derived from the merch query by the orchestrator) must
//     reach the gallery matcher as `tags` — otherwise the gallery_reuse
//     hierarchy level can never match.
//   - The reuse detail string must carry the "tag overlap" label wherever
//     the matcher's confidence surfaces (dossier rule, section 5.13).

import { describe, it, expect, vi } from 'vitest';
import { findMerchandiseCandidate } from '../src/lib/merch/sourcing';
import type { GalleryMatcher } from '../src/lib/merch/sourcing';
import type { GalleryAsset } from '../src/types/media';

function makeAsset(overrides: Partial<GalleryAsset> = {}): GalleryAsset {
  return {
    id: 'art-1',
    url: 'https://example.com/art.png',
    brand: 'misfit',
    category: 'art',
    forSale: false,
    source: 'seed',
    addedAt: 1000,
    permanent: true,
    ...overrides,
  };
}

describe('findMerchandiseCandidate — query tag pass-through', () => {
  it('passes queryTags into the matcher and labels the result "tag overlap"', async () => {
    const art = makeAsset();
    const findClosest = vi.fn().mockReturnValue({ asset: art, confidence: 1 });
    const matcher: GalleryMatcher = { findClosest };

    const candidate = await findMerchandiseCandidate('misfit', {
      assetStore: {
        get: vi.fn(),
        insert: vi.fn(),
        list: vi.fn().mockResolvedValue([art]),
      },
      galleryMatcher: matcher,
      merchQuery: 'misfit tee',
      matchThreshold: 0.5,
      queryTags: ['misfit', 'tee'],
    });

    expect(findClosest).toHaveBeenCalledWith([art], {
      category: 'art',
      tags: ['misfit', 'tee'],
    });
    expect(candidate.source).toBe('gallery_reuse');
    expect(candidate.asset?.id).toBe('art-1');
    expect(candidate.detail).toContain('tag overlap');
  });

  it('without queryTags the matcher is invoked with undefined tags (legacy behavior preserved)', async () => {
    const findClosest = vi.fn().mockReturnValue(undefined);
    const matcher: GalleryMatcher = { findClosest };

    const candidate = await findMerchandiseCandidate('forge', {
      assetStore: {
        get: vi.fn(),
        insert: vi.fn(),
        list: vi.fn().mockResolvedValue([]),
      },
      galleryMatcher: matcher,
      catalogClient: {
        search: vi.fn().mockResolvedValue([
          { id: 'p-9', url: 'https://printify.example/p/9.png' },
        ]),
      },
      merchQuery: 'forge hoodie',
      matchThreshold: 0.5,
      // queryTags intentionally omitted
    });

    expect(findClosest).toHaveBeenCalledWith([], { category: 'art', tags: undefined });
    expect(candidate.source).toBe('catalog_search');
  });
});
