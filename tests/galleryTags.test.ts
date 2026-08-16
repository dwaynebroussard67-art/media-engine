// tests/galleryTags.test.ts
// Pins the tags data flow added in Stage 3:
//
//   gallery_assets.tags (migration 002) → AssetStore.list() → GalleryAsset.tags
//   → tagOverlapMatcher → gallery_reuse merch candidates.
//
// Before this fix the store's row mapper dropped the tags column, so the
// matcher always saw `undefined` tags and the gallery-reuse hierarchy level
// could never match anything.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/supabaseClient', () => ({
  getSupabaseAdmin: vi.fn(),
  verifyUserJwt: vi.fn(),
  _resetSupabaseAdminForTesting: vi.fn(),
  SupabaseNotConfiguredError: class SupabaseNotConfiguredError extends Error {},
}));

import { getSupabaseAdmin } from '../src/lib/supabaseClient';
import { supabaseAssetStore } from '../src/lib/permanentAssets';
import { tagOverlapMatcher } from '../src/lib/merch/tagMatcher';
import type { GalleryAsset } from '../src/types/media';

/** Awaitable fake of the supabase-js query chain (select → eq → await). */
function fakeSelectChain(rows: Array<Record<string, unknown>>) {
  const chain = {
    eq: vi.fn(() => chain),
    then: (resolve: (value: { data: unknown[]; error: null }) => void) =>
      resolve({ data: rows, error: null }),
  };
  return chain;
}

const dbRow = {
  id: 'a1',
  url: 'https://example.com/a.png',
  brand: 'misfit',
  category: 'art',
  for_sale: false,
  source: 'seed',
  original_template_id: null,
  added_at: 1000,
  permanent: true,
  tags: ['misfit', 'tee'],
};

beforeEach(() => vi.clearAllMocks());

describe('gallery tags data flow', () => {
  it('AssetStore.list maps the tags column onto GalleryAsset.tags', async () => {
    const client = {
      from: vi.fn((table: string) => {
        expect(table).toBe('gallery_assets');
        return { select: vi.fn(() => fakeSelectChain([dbRow])) };
      }),
    };
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as never);

    const assets = await supabaseAssetStore.list({ brand: 'misfit' });
    expect(assets).toHaveLength(1);
    expect(assets[0].tags).toEqual(['misfit', 'tee']);
  });

  it('AssetStore.insert writes tags to the row', async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const client = {
      from: vi.fn((table: string) => {
        expect(table).toBe('gallery_assets');
        return {
          insert: async (row: Record<string, unknown>) => {
            inserted.push(row);
            return { error: null };
          },
        };
      }),
    };
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as never);

    const asset: GalleryAsset = {
      id: 'a2',
      url: 'https://example.com/b.png',
      brand: 'forge',
      category: 'art',
      forSale: false,
      source: 'seed',
      addedAt: 2000,
      permanent: true,
      tags: ['forge', 'hoodie'],
    };
    await supabaseAssetStore.insert(asset);

    expect(inserted).toHaveLength(1);
    expect(inserted[0].tags).toEqual(['forge', 'hoodie']);
  });

  it('tagOverlapMatcher can now match assets returned by the real store shape', () => {
    const asset: GalleryAsset = {
      id: 'a1',
      url: 'https://example.com/a.png',
      brand: 'misfit',
      category: 'art',
      forSale: false,
      source: 'seed',
      addedAt: 1000,
      permanent: true,
      tags: ['misfit', 'tee'],
    };

    const match = tagOverlapMatcher.findClosest([asset], {
      category: 'art',
      tags: ['misfit', 'tee'],
    });

    expect(match).toBeDefined();
    expect(match?.asset.id).toBe('a1');
    expect(match?.confidence).toBe(1.0);
  });

  it('assets without tags score zero overlap and never match', () => {
    const untagged: GalleryAsset = {
      id: 'a3',
      url: 'https://example.com/c.png',
      brand: 'misfit',
      category: 'art',
      forSale: false,
      source: 'seed',
      addedAt: 3000,
      permanent: true,
      // no tags
    };

    expect(
      tagOverlapMatcher.findClosest([untagged], { tags: ['misfit', 'tee'] })
    ).toBeUndefined();
  });
});
