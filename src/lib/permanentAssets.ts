// src/lib/permanentAssets.ts
// Append-only gallery asset store with a Supabase backend.
//
// Key invariants:
//   - Assets are never modified or deleted after insertion.
//   - Duplicate inserts throw DuplicateAssetError (idempotency sentinel).
//   - onPostApproved silently absorbs duplicate calls (safe re-run behaviour).
//   - addToGallery is the single public write entry point.

import { getSupabaseAdmin } from './supabaseClient';
import type {
  GalleryAsset,
  ReviewItem,
  Brand,
  AssetBrand,
  AssetCategory,
  AssetSource,
  AssetFilter,
} from '../types/media';

// ── Error types ───────────────────────────────────────────────────────────────

export class DuplicateAssetError extends Error {
  public readonly assetId: string;

  constructor(id: string) {
    super(
      `Gallery asset "${id}" already exists. ` +
      `The gallery store is append-only and does not permit overwrites.`,
    );
    this.name = 'DuplicateAssetError';
    this.assetId = id;
  }
}

// ── Store interface ───────────────────────────────────────────────────────────

export interface AssetStore {
  get(id: string): Promise<GalleryAsset | undefined>;
  insert(asset: GalleryAsset): Promise<void>;
  list(filter?: AssetFilter): Promise<GalleryAsset[]>;
}

// ── Row → domain mapper ───────────────────────────────────────────────────────

function rowToAsset(row: Record<string, unknown>): GalleryAsset {
  return {
    id:                 row.id as string,
    url:                row.url as string,
    brand:              row.brand as AssetBrand,
    category:           row.category as AssetCategory,
    forSale:            row.for_sale as boolean,
    source:             row.source as AssetSource,
    originalTemplateId: (row.original_template_id as string | null) ?? undefined,
    addedAt:            Number(row.added_at),
    permanent:          true,
  };
}

// ── Supabase implementation ───────────────────────────────────────────────────

export const supabaseAssetStore: AssetStore = {
  async get(id: string): Promise<GalleryAsset | undefined> {
    const { data, error } = await getSupabaseAdmin()
      .from('gallery_assets')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      throw new Error(`[AssetStore.get] Database error: ${error.message}`);
    }

    return data ? rowToAsset(data as Record<string, unknown>) : undefined;
  },

  async insert(asset: GalleryAsset): Promise<void> {
    const { error } = await getSupabaseAdmin().from('gallery_assets').insert({
      id:                   asset.id,
      url:                  asset.url,
      brand:                asset.brand,
      category:             asset.category,
      for_sale:             asset.forSale,
      source:               asset.source,
      original_template_id: asset.originalTemplateId ?? null,
      added_at:             asset.addedAt,
      permanent:            true,
    });

    if (error) {
      // PostgreSQL unique-violation code
      if (error.code === '23505') {
        throw new DuplicateAssetError(asset.id);
      }
      throw new Error(`[AssetStore.insert] Database error: ${error.message}`);
    }
  },

  async list(filter?: AssetFilter): Promise<GalleryAsset[]> {
    let query = getSupabaseAdmin().from('gallery_assets').select('*');

    if (filter?.brand !== undefined) {
      query = query.eq('brand', filter.brand);
    }
    if (filter?.category !== undefined) {
      query = query.eq('category', filter.category);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`[AssetStore.list] Database error: ${error.message}`);
    }

    return (data ?? []).map((row) =>
      rowToAsset(row as Record<string, unknown>),
    );
  },
};

// ── Public write API ──────────────────────────────────────────────────────────

/**
 * Inserts a validated GalleryAsset into the store.
 * Throws DuplicateAssetError if the asset ID already exists.
 * This is the single authorised write entry point for the gallery.
 */
export async function addToGallery(
  store: AssetStore,
  asset: GalleryAsset,
): Promise<void> {
  await store.insert(asset);
}

/**
 * Feedback loop triggered when a review decision is 'post'.
 * Converts the approved ReviewItem into a permanent GalleryAsset.
 *
 * Idempotent: if the item was already approved (e.g. network retry),
 * the duplicate insert is caught and silently ignored.
 *
 * Uses item.id as the asset ID to guarantee a stable, queryable link
 * between the decision record and the gallery entry.
 */
export async function onPostApproved(
  store: AssetStore,
  item: ReviewItem,
): Promise<void> {
  const asset: GalleryAsset = {
    id:                 item.id,
    url:                item.imageUrl,
    brand:              item.brand,
    category:           'approved_post',
    forSale:            false,
    source:             'generated_and_approved',
    originalTemplateId: item.templateId,
    addedAt:            Date.now(),
    permanent:          true,
  };

  try {
    await store.insert(asset);
  } catch (err) {
    if (err instanceof DuplicateAssetError) {
      // Re-approving an already-approved item is a safe no-op.
      // This covers network retries and operator double-clicks.
      return;
    }
    throw err;
  }
}
