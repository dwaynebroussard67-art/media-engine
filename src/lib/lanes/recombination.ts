// src/lib/lanes/recombination.ts
// Lane 1b: Sequential recombination of existing gallery assets with fresh text.
//
// Selection strategy:
//   Assets are sorted by addedAt (ascending), forming a stable ordered queue.
//   The rotation pointer advances one step per run, wrapping at the end.
//   This guarantees every asset gets an equal turn before any repeats.
//
// State persistence:
//   The rotation pointer lives in `rotation_state` (upsertable, not append-only).
//   Each successful run atomically advances the pointer after the render
//   completes — not before — to avoid advancing on a failed render.

import { randomUUID } from 'crypto';
import { getSupabaseAdmin } from '../supabaseClient';
import type { AssetStore } from '../permanentAssets';
import type { Brand, GalleryAsset, RenderedItem } from '../../types/media';

// ── Error types ───────────────────────────────────────────────────────────────

export class NoEligibleBaseError extends Error {
  public readonly brand: Brand;

  constructor(brand: Brand) {
    super(
      `No eligible recombination base found for brand "${brand}". ` +
      `Seed the gallery with at least one non-logo asset before running this lane.`,
    );
    this.name = 'NoEligibleBaseError';
    this.brand = brand;
  }
}

// ── Dependency interfaces ─────────────────────────────────────────────────────

export interface TextBankProvider {
  // May be sync (Stage 1 in-memory banks) or async (Stage 2 DB-rotated banks).
  pick(brand: Brand): string | Promise<string>;
}

export interface TextOverlayRenderer {
  render(
    baseUrl: string,
    text: string,
    brand: Brand,
  ): Promise<{ url: string }>;
}

// ── Rotation state helpers ────────────────────────────────────────────────────

export async function getLastUsedIndex(brand: Brand): Promise<number> {
  const { data, error } = await getSupabaseAdmin()
    .from('rotation_state')
    .select('last_used_index')
    .eq('brand', brand)
    .maybeSingle();

  if (error) {
    throw new Error(`[rotationState.get] Database error: ${error.message}`);
  }

  // -1 signals "never run before"; the selector will advance to index 0.
  return data?.last_used_index ?? -1;
}

export async function advanceRotation(
  brand: Brand,
  assetId: string,
  index: number,
): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from('rotation_state')
    .upsert(
      {
        brand,
        last_used_asset_id: assetId,
        last_used_index:    index,
        updated_at:         Date.now(),
      },
      { onConflict: 'brand' },
    );

  if (error) {
    throw new Error(`[rotationState.advance] Database error: ${error.message}`);
  }
}

// ── Core selection logic (pure, deterministic, easily unit-tested) ─────────────

export function selectDeterministicBase(
  eligible: GalleryAsset[],
  lastUsedIndex: number,
): { base: GalleryAsset; nextIndex: number } {
  if (eligible.length === 0) {
    // Caller is responsible for providing a non-empty list.
    // generateRecombinationPost checks this and throws NoEligibleBaseError;
    // throwing a typed error here aids direct unit testing of this function.
    throw new RangeError(
      'selectDeterministicBase called with an empty eligible asset list.',
    );
  }

  // Sort ascending by addedAt to form a stable, reproducible queue.
  const sorted = [...eligible].sort((a, b) => a.addedAt - b.addedAt);
  // JS % yields negatives for negative operands. lastUsedIndex comes from
  // rotation_state in the DB; corrupted or hand-edited state (< -1) would make
  // sorted[nextIndex] undefined and crash downstream. Normalize defensively.
  const n = sorted.length;
  const nextIndex = (((lastUsedIndex + 1) % n) + n) % n;

  return { base: sorted[nextIndex], nextIndex };
}

// ── Orchestration entry point ─────────────────────────────────────────────────

export async function generateRecombinationPost(
  brand: Brand,
  deps: {
    assetStore: AssetStore;
    textBank: TextBankProvider;
    renderer: TextOverlayRenderer;
  },
): Promise<RenderedItem> {
  // Gather eligible bases: brand-specific + shared, excluding logos.
  const [brandAssets, sharedAssets] = await Promise.all([
    deps.assetStore.list({ brand }),
    deps.assetStore.list({ brand: 'shared' }),
  ]);

  const eligible = [...brandAssets, ...sharedAssets].filter(
    (a) => a.category !== 'logo',
  );

  if (eligible.length === 0) {
    throw new NoEligibleBaseError(brand);
  }

  const lastIndex = await getLastUsedIndex(brand);
  const { base, nextIndex } = selectDeterministicBase(eligible, lastIndex);

  const text = await deps.textBank.pick(brand);

  // Render first; only advance the rotation pointer on success.
  const rendered = await deps.renderer.render(base.url, text, brand);

  await advanceRotation(brand, base.id, nextIndex);

  return {
    id:             randomUUID(),
    imageUrl:       rendered.url,
    brand,
    generationLane: 'recombination',
    templateId:     base.originalTemplateId ?? base.id,
    sourceData:     { baseImageId: base.id, text },
    createdAt:      Date.now(),
  };
}
