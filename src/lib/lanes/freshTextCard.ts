// src/lib/lanes/freshTextCard.ts

import { randomUUID } from 'crypto';
import { selectDeterministicBase } from './recombination';
import { getLaneRotationIndex, advanceLaneRotation } from '../laneRotation';
import type { AssetStore } from '../permanentAssets';
import type { TextBankProvider } from '../textBank';
import type { TextOverlayRenderer } from './recombination';
import type { Brand, RenderedItem } from '../../types/media';

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

export class NoFreshTextBaseError extends Error {
  constructor(public readonly brand: Brand) {
    super(
      `No eligible base assets (category: atmosphere or art) found for brand "${brand}" ` +
        `in fresh text card lane`
    );
    this.name = 'NoFreshTextBaseError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Lane implementation
// ---------------------------------------------------------------------------

/**
 * Generates a fresh text card:
 *   1. Lists gallery assets for the brand (brand-specific + shared) with
 *      category `atmosphere` or `art`.
 *   2. Selects a base deterministically via selectDeterministicBase.
 *      Rotation is PERSISTED per lane+brand in lane_rotation_state
 *      (migration 003) under scope `fresh_text_card:{brand}` — without
 *      persistence every batch would re-render the same base forever.
 *   3. Picks text from the text bank (persistent rotation via text_rotation_state).
 *   4. Renders via sharpRenderer.
 *   5. Returns a RenderedItem with lane `fresh_text_card`.
 *
 * Throws NoFreshTextBaseError if no eligible assets exist.
 * Propagates EmptyTextBankError from the text bank.
 * Propagates BaseImageFetchError / RenderUploadError from the renderer.
 */
export async function generateFreshTextCard(
  brand: Brand,
  deps: {
    assetStore: AssetStore;
    textBank: TextBankProvider;
    renderer: TextOverlayRenderer;
    lastUsedIndex?: number; // test override; production reads lane_rotation_state
  }
): Promise<RenderedItem> {
  const { assetStore, textBank, renderer } = deps;
  const scope = `fresh_text_card:${brand}`;
  const lastUsedIndex =
    deps.lastUsedIndex ?? (await getLaneRotationIndex(scope));

  // 1. Collect eligible assets: brand-specific and shared, atmosphere or art only.
  const [brandAssets, sharedAssets] = await Promise.all([
    assetStore.list({ brand }),
    assetStore.list({ brand: 'shared' }),
  ]);

  const eligible = [...brandAssets, ...sharedAssets].filter(
    (a) => a.category === 'atmosphere' || a.category === 'art'
  );

  if (eligible.length === 0) {
    throw new NoFreshTextBaseError(brand);
  }

  // 2. Deterministic base selection.
  // selectDeterministicBase throws RangeError on empty — we guard above so
  // this is defense-in-depth only.
  let base: (typeof eligible)[number];
  let nextIndex: number;
  try {
    ({ base, nextIndex } = selectDeterministicBase(eligible, lastUsedIndex));
  } catch (err) {
    if (err instanceof RangeError) {
      throw new NoFreshTextBaseError(brand);
    }
    throw err;
  }

  // 3. Pick text.
  const text = await textBank.pick(brand);

  // 4. Render.
  const { url } = await renderer.render(base.url, text, brand);

  // 5. Advance rotation only on render success (skip when a test injected
  // an explicit index — tests own their state).
  if (deps.lastUsedIndex === undefined) {
    await advanceLaneRotation(scope, nextIndex);
  }

  // 6. Assemble RenderedItem.
  const item: RenderedItem = {
    id: randomUUID(),
    imageUrl: url,
    brand,
    generationLane: 'fresh_text_card',
    templateId: base.id,
    sourceData: {
      baseImageId: base.id,
      text,
    },
    createdAt: Date.now(),
  };

  return item;
}
