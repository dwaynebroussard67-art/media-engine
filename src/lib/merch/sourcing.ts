// src/lib/merch/sourcing.ts
// Hierarchical merchandise candidate resolution.
//
// Priority order (strict):
//   1. Gallery reuse        — prefer existing owned art above confidence threshold.
//   2. Catalog blank search — query the product catalog for a printable base.
//   3. AI touch-up          — last resort; explicitly logged as such.
//
// Failure handling (invariant: AI touch-up is a deliberate, cost-incurring
// LAST RESORT — it is reached only when the hierarchy is genuinely exhausted):
//   Empty catalog results  = hierarchy exhausted -> ai_touchup, explicitly.
//   Catalog client ERRORS  = unknown state       -> CatalogUnavailableError.
//     An outage must never silently convert into paid AI generation; the
//     orchestrator surfaces the error and D decides whether to retry or
//     explicitly invoke the AI path. Refuse-rather-than-err.

import type { AssetStore } from '../permanentAssets';

export class CatalogUnavailableError extends Error {
  constructor(cause: string) {
    super(
      `Catalog search failed ("${cause}"). Refusing to auto-fall-through to ` +
      `AI touch-up on unknown catalog state; retry or invoke AI explicitly.`,
    );
    this.name = 'CatalogUnavailableError';
  }
}
import type { Brand, GalleryAsset, MerchCandidate } from '../../types/media';

// ── Dependency interfaces ─────────────────────────────────────────────────────

export interface ProductCatalogClient {
  search(
    query: string,
    category: string,
  ): Promise<Array<{ id: string; url: string }>>;
}

export interface GalleryMatcher {
  findClosest(
    assets: GalleryAsset[],
    opts: { category?: string; tags?: string[] },
  ): { asset: GalleryAsset; confidence: number } | undefined;
}

export interface MerchSourcingDeps {
  assetStore: AssetStore;
  galleryMatcher: GalleryMatcher;
  catalogClient?: ProductCatalogClient;
  merchQuery: string;
  matchThreshold: number;
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function findMerchandiseCandidate(
  brand: Brand,
  deps: MerchSourcingDeps,
): Promise<MerchCandidate> {

  // ── Step 1: Gallery reuse ─────────────────────────────────────────────────
  const artAssets = await deps.assetStore.list({ brand, category: 'art' });
  const closestMatch = deps.galleryMatcher.findClosest(artAssets, {
    category: 'art',
  });

  if (
    closestMatch !== undefined &&
    closestMatch.confidence >= deps.matchThreshold
  ) {
    return {
      source: 'gallery_reuse',
      asset:  closestMatch.asset,
      detail: `reused asset: ${closestMatch.asset.id} (confidence: ${closestMatch.confidence.toFixed(2)})`,
    };
  }

  // ── Step 2: Product catalog search ───────────────────────────────────────
  if (deps.catalogClient !== undefined) {
    let catalogResults: Array<{ id: string; url: string }>;

    try {
      catalogResults = await deps.catalogClient.search(deps.merchQuery, 'apparel');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new CatalogUnavailableError(message);
    }

    if (catalogResults.length > 0) {
      const product = catalogResults[0];
      return {
        source:             'catalog_search',
        productUrl:         product.url,
        baseProduct:        product,
        needsDesignOverlay: true,
        detail:             `catalog product: ${product.id}`,
      };
    }

    // Empty result set: fall through to ai_touchup below.
  }

  // ── Step 3: AI touch-up (conscious last resort) ───────────────────────────
  return {
    source:             'ai_touchup',
    needsDesignOverlay: true,
    detail:             'ai_touchup: gallery and catalog exhausted. AI generation required.',
  };
}
