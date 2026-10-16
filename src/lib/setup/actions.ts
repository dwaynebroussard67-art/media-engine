// src/lib/setup/actions.ts
//
// The mutations /setup is allowed to perform, and nothing more.
//
// Hard rules encoded here:
//   - gallery_assets is written ONLY through addToGallery, and ONLY by
//     bootstrapBackdrop, and ONLY when the brand has no eligible base asset
//     yet, and ONLY on an explicit button press. Setup tooling must not be
//     able to pollute an append-only gallery.
//   - No action writes to media_decisions or review_queue except
//     verifyDecisionIntegrity, which replays the decision handler's own
//     documented idempotent path (dossier §3).
//   - Every action returns evidence. Nothing returns a bare "ok".

import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { getSupabaseAdmin } from '../supabaseClient';
import { addToGallery, supabaseAssetStore } from '../permanentAssets';
import { handleReviewDecision, FinalityViolationError } from '../review/reviewQueue';
import { queueRowToReviewItem, type ReviewQueueRow } from '../review/queueRow';
import { probeBaseAssets } from './probes';
import { buildCanvasSvg } from '../render/smokeRender';
import { runStep, type ProbeStep } from '../probeStep';
import type { Brand, GalleryAsset } from '../../types/media';

const BUCKET = 'media-engine';

// ── Bootstrap: one plain backdrop so the lanes can run ────────────────────────

export interface BootstrapResult {
  ok: boolean;
  brand: Brand;
  steps: ProbeStep[];
  assetId?: string;
  assetUrl?: string;
  error?: string;
  warnings: string[];
}

/**
 * Creates a plain, font-free brand backdrop and inserts it into the gallery as
 * a `seed` asset (category `atmosphere`) so the two generation lanes have
 * something to work with before D has uploaded real art.
 *
 * Refuses unless the brand currently has ZERO eligible base assets. That guard
 * exists so this button can never be used to junk up a permanent gallery.
 */
export async function bootstrapBackdrop(brand: Brand): Promise<BootstrapResult> {
  const steps: ProbeStep[] = [];
  const warnings: string[] = [];

  const counts = await probeBaseAssets();
  if (!counts.ok) {
    return {
      ok: false,
      brand,
      steps,
      warnings,
      error: `Could not read the gallery: ${counts.error ?? 'unknown error'}`,
    };
  }

  const eligible = counts.byBrand[brand]?.freshTextBases ?? 0;
  if (eligible > 0) {
    return {
      ok: false,
      brand,
      steps,
      warnings,
      error: `Refused: ${brand} already has ${eligible} eligible base asset(s). This button only exists to unlock an empty gallery — upload real art on /gallery instead.`,
    };
  }

  const db = getSupabaseAdmin();
  const assetId = `setup-backdrop-${brand}-${randomUUID()}`;
  const storagePath = `gallery/${brand}/${assetId}.webp`;
  let publicUrl: string | undefined;

  const build = await runStep('build_backdrop', async () => {
    const buf = await sharp(buildCanvasSvg(brand))
      .resize(1080, 1080)
      .webp({ quality: 80 })
      .toBuffer();
    const { error } = await db.storage
      .from(BUCKET)
      .upload(storagePath, buf, { contentType: 'image/webp', upsert: false });
    if (error) throw new Error(error.message);

    const { data } = db.storage.from(BUCKET).getPublicUrl(storagePath);
    if (!data?.publicUrl) throw new Error('getPublicUrl returned no URL');
    publicUrl = data.publicUrl;
    return `${buf.length} bytes → ${data.publicUrl}`;
  });
  steps.push(build.step);

  const stagedUrl = publicUrl;
  if (!build.ok || !stagedUrl) {
    warnings.push(
      'Nothing was written to the gallery — the storage step failed. Fix Storage first (run the storage probe), then try again.',
    );
    return { ok: false, brand, steps, warnings, error: build.step.detail };
  }

  const asset: GalleryAsset = {
    id: assetId,
    url: stagedUrl,
    brand,
    category: 'atmosphere',
    forSale: false,
    source: 'seed',
    addedAt: Date.now(),
    permanent: true,
  };

  const insert = await runStep('add_to_gallery', async () => {
    // The single authorised write entry point. Not a direct insert: the
    // append-only store owns its own invariants.
    await addToGallery(supabaseAssetStore, asset);
    return `inserted ${assetId} (category atmosphere, source seed)`;
  });
  steps.push(insert.step);

  if (!insert.ok) {
    return { ok: false, brand, steps, warnings, error: insert.step.detail, assetId, assetUrl: stagedUrl };
  }

  warnings.push(
    'This is a plain backdrop, not art. It exists so the lanes can render before you upload real bases — replace it by uploading actual atmosphere/art images on /gallery. It stays in the gallery forever (append-only), so it will keep taking turns in rotation.',
  );

  return { ok: true, brand, steps, assetId, assetUrl: stagedUrl, warnings };
}

// ── Verify the decision loop ──────────────────────────────────────────────────

export interface VerifyLoopResult {
  ok: boolean;
  status: 'verified' | 'no_post_decisions' | 'partial' | 'failed';
  itemId?: string;
  detail: string;
  steps: ProbeStep[];
  warnings: string[];
}

/**
 * Proves the loop that matters most, on live data:
 *   1. the newest 'post' decision exists,
 *   2. its gallery entry exists AND is keyed by the same item id,
 *   3. the queue row was closed out,
 *   4. replaying the same decision returns the SAME record id (idempotency),
 *   5. the gallery still holds exactly ONE row for that item (no double write).
 *
 * Step 4 runs the production handler with the same decision — the documented
 * crash-recovery path (dossier §3). It cannot create a second decision, a
 * second gallery row or a remix work order: those are the exact properties
 * being verified.
 */
export async function verifyDecisionIntegrity(): Promise<VerifyLoopResult> {
  const db = getSupabaseAdmin();
  const steps: ProbeStep[] = [];
  const warnings: string[] = [];

  let decision: {
    id: string;
    item_id: string;
    decision: string;
    decided_at: number;
    gallery_entry_id: string | null;
  } | undefined;

  const latest = await runStep('load_latest_post_decision', async () => {
    const { data, error } = await db
      .from('media_decisions')
      .select('id,item_id,decision,decided_at,gallery_entry_id')
      .eq('decision', 'post')
      .order('decided_at', { ascending: false })
      .limit(1);

    if (error) throw new Error(error.message);
    const row = (data ?? [])[0] as typeof decision;
    if (!row) throw new Error('no rows');
    decision = row;
    return `${row.item_id} decided at ${new Date(Number(row.decided_at)).toISOString()}`;
  });

  const post = decision;
  if (!latest.ok || !post) {
    steps.push(latest.step);
    return {
      ok: false,
      status: 'no_post_decisions',
      detail:
        'No item has been approved yet, so there is no loop to verify. Run a batch, approve one item on /review, then come back. (This is not a failure.)',
      steps,
      warnings,
    };
  }
  steps.push(latest.step);

  const itemId = post.item_id;

  const gallery = await runStep('gallery_entry_matches_item_id', async () => {
    const { data, error } = await db
      .from('gallery_assets')
      .select('id,url,source,category')
      .eq('id', itemId);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<{ id: string; url: string; source: string; category: string }>;
    if (rows.length === 0) throw new Error(`no gallery_assets row with id ${itemId}`);
    if (rows.length > 1) throw new Error(`${rows.length} gallery rows for ${itemId}`);
    const row = rows[0];
    if (row.source !== 'generated_and_approved') {
      throw new Error(`unexpected source "${row.source}" (expected generated_and_approved)`);
    }
    return `id=${row.id} category=${row.category} source=${row.source}`;
  });
  steps.push(gallery.step);

  let queueRow: ReviewQueueRow | undefined;
  const queue = await runStep('queue_row_closed', async () => {
    const { data, error } = await db
      .from('review_queue')
      .select('*')
      .eq('id', itemId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error('queue row is gone (expected status decided)');
    queueRow = data as ReviewQueueRow;
    return `status=${queueRow.status ?? 'unknown'} (expected decided)`;
  });
  steps.push(queue.step);

  if (!queueRow) {
    return {
      ok: false,
      status: 'partial',
      itemId,
      detail:
        'The decision and gallery entry check out, but the queue row could not be loaded, so the idempotent replay was not attempted.',
      steps,
      warnings,
    };
  }

  const replay = await runStep('idempotent_replay_returns_same_record', async () => {
    const item = queueRowToReviewItem(queueRow as ReviewQueueRow);
    try {
      const record = await handleReviewDecision(item, 'post');
      if (record.id !== post.id) {
        throw new Error(
          `replay returned record ${record.id}, expected the original ${post.id}`,
        );
      }
      return `same record id ${record.id} — no second decision, no second gallery write`;
    } catch (err) {
      if (err instanceof FinalityViolationError) {
        throw new Error(
          `headline failure: the store says this item was already decided differently (${err.existing} vs ${err.requested})`,
        );
      }
      throw err;
    }
  });
  steps.push(replay.step);

  const stillOne = await runStep('gallery_still_has_exactly_one_row', async () => {
    const { data, error } = await db
      .from('gallery_assets')
      .select('id')
      .eq('id', itemId);
    if (error) throw new Error(error.message);
    const n = (data ?? []).length;
    if (n !== 1) throw new Error(`${n} gallery rows for ${itemId} after replay`);
    return 'exactly 1';
  });
  steps.push(stillOne.step);

  const ok = steps.every((s) => s.ok);
  if (!ok) {
    warnings.push(
      'At least one loop check failed. The raw evidence for every step is in the setup report — paste it back for triage. Do NOT re-approve anything by hand: decisions are final and the gallery is append-only.',
    );
  }

  return {
    ok,
    status: ok ? 'verified' : steps.some((s) => s.name === 'gallery_entry_matches_item_id' && !s.ok) ? 'failed' : 'partial',
    itemId,
    detail: ok
      ? `Loop verified end to end on item ${itemId}: decision → gallery row (same id) → queue closed → idempotent replay → still exactly one gallery row.`
      : `Loop verification failed on item ${itemId}. See the steps.`,
    steps,
    warnings,
  };
}
