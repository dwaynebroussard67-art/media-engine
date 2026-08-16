// src/lib/merch/tagMatcher.ts
//
// Implements GalleryMatcher from src/lib/merch/sourcing.ts.
//
// Confidence = |intersection of query tags and asset tags| / |query tags|.
// Returns undefined if no assets have ANY tag overlap with the query.
//
// IMPORTANT: This is a TAG OVERLAP heuristic, NOT visual similarity.
// Never present it as visual similarity. The label "tag overlap" must
// appear wherever confidence scores from this module surface in the UI.
//
// Requires: gallery_assets.tags column (supabase/migrations/002_tags.sql).

import type { GalleryMatcher } from './sourcing';
import type { GalleryAsset, AssetCategory } from '../../types/media';

// The GalleryMatcher interface from sourcing.ts (reproduced here for clarity,
// do not rename):
//   findClosest(
//     assets: GalleryAsset[],
//     query: { category?: AssetCategory; tags?: string[] }
//   ): { asset: GalleryAsset; confidence: number } | undefined

export const tagOverlapMatcher: GalleryMatcher = {
  findClosest(
    assets: GalleryAsset[],
    query: { category?: AssetCategory; tags?: string[] }
  ): { asset: GalleryAsset; confidence: number } | undefined {
    const queryTags = query.tags ?? [];

    // If caller provides no query tags, confidence is undefined for all assets —
    // return undefined rather than picking arbitrarily.
    if (queryTags.length === 0) return undefined;

    // Filter by category first if provided.
    const candidates = query.category
      ? assets.filter((a) => a.category === query.category)
      : assets;

    if (candidates.length === 0) return undefined;

    let best: { asset: GalleryAsset; confidence: number } | undefined;

    for (const asset of candidates) {
      // GalleryAsset.tags flows from the gallery_assets.tags column (added by
      // migration 002) via the AssetStore row mapper. Assets without tags
      // score zero overlap and never match.
      const assetTags: readonly string[] = asset.tags ?? [];

      const intersection = queryTags.filter((t) => assetTags.includes(t));
      const confidence = intersection.length / queryTags.length;

      if (confidence > 0 && (!best || confidence > best.confidence)) {
        best = { asset, confidence };
      }
    }

    return best;
  },
};
