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
      // GalleryAsset.tags is not in the Stage 1 type definition — it was added
      // by migration 002_tags.sql. We access it via a type assertion because
      // the base type cannot be changed without touching frozen types.
      // This is the documented `any` exception at Supabase row boundaries.
      const assetTags: string[] =
        (asset as unknown as { tags?: string[] }).tags ?? [];

      const intersection = queryTags.filter((t) => assetTags.includes(t));
      const confidence = intersection.length / queryTags.length;

      if (confidence > 0 && (!best || confidence > best.confidence)) {
        best = { asset, confidence };
      }
    }

    return best;
  },
};
