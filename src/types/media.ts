// src/types/media.ts
// Single source of truth for all domain types.
// No runtime code lives here — pure type declarations only.

export type Brand = 'misfit' | 'forge';

export type AssetBrand = Brand | 'shared';

export type AssetCategory =
  | 'logo'
  | 'apparel'
  | 'art'
  | 'atmosphere'
  | 'approved_post';

export type AssetSource = 'seed' | 'generated_and_approved';

export interface GalleryAsset {
  readonly id: string;
  readonly url: string;
  readonly brand: AssetBrand;
  readonly category: AssetCategory;
  readonly forSale: boolean;
  readonly source: AssetSource;
  readonly originalTemplateId?: string;
  readonly addedAt: number;
  readonly permanent: true;
}

export type GenerationLane =
  | 'fresh_text_card'
  | 'recombination'
  | 'procedural'
  | 'ai_touchup';

export interface RenderedItem {
  readonly id: string;
  readonly imageUrl: string;
  readonly brand: Brand;
  readonly generationLane: GenerationLane;
  readonly templateId?: string;
  readonly sourceData: Record<string, unknown>;
  readonly createdAt: number;
}

export type ReviewDecision = 'post' | 'remix' | 'reject';

export type MerchSourceType =
  | 'gallery_reuse'
  | 'catalog_search'
  | 'ai_touchup';

export interface OracleResult {
  readonly passed: boolean;
  readonly reasons: readonly string[];
  readonly checkedAt: number;
}

export interface ReviewItem extends RenderedItem {
  readonly oracleResult: OracleResult;
  readonly merchSource?: MerchSourceType;
  readonly sourceDetail?: string;
}

export interface MerchCandidate {
  readonly source: MerchSourceType;
  readonly asset?: GalleryAsset;
  readonly productUrl?: string;
  readonly baseProduct?: unknown;
  readonly needsDesignOverlay?: boolean;
  readonly detail: string;
}

export interface DecisionRecord {
  readonly id: string;
  readonly itemId: string;
  readonly decision: ReviewDecision;
  readonly decidedAt: number;
  readonly brand: Brand;
  readonly lane: GenerationLane;
  readonly oracleResult: OracleResult;
  readonly galleryEntryId?: string;
}

// ============================================================
// Asset filter shape used by AssetStore.list()
// Defined here to keep the store interface self-documenting.
// ============================================================
export interface AssetFilter {
  brand?: AssetBrand;
  category?: AssetCategory;
}
