// src/lib/render/smokeRender.ts
//
// SETUP SMOKE RENDER — the "one real render end-to-end" check that no model
// could perform statically (dossier §7.5, item 2 in DEBUG-REPORT's
// still-on-D list).
//
// It deliberately exercises EVERY hop the production render path uses:
//
//   1. build_canvas      sharp creates a real base image (no external art needed)
//   2. upload_base       Storage write with the service key  → public URL
//   3. public_read_base  HTTPS fetch of that public URL (bucket must be PUBLIC)
//   4. composite         the REAL sharpRenderer.render() — fetch → typography
//                        → word wrap → SVG overlay → webp encode → upload
//   5. public_read_final HTTPS fetch of the rendered card
//   6. cleanup           removes the throwaway base (best effort)
//
// What it does NOT do: insert anything into gallery_assets or review_queue.
// The gallery is append-only, so the setup tooling must never write to it
// except through addToGallery (the bootstrap backdrop does exactly that, and
// only on an explicit, separately-labelled button press).
//
// The rendered card is left in Storage under `rendered/{brand}/` so D can look
// at it on the phone. Storage is mutable by design; the DB invariants are not
// touched.
//
// Honest limitation, surfaced in the UI on purpose: this proves the pipeline
// runs and shows which typeface actually came out. librsvg resolves
// font-family through the runtime's fontconfig — if Space Grotesk / IBM Plex
// Mono are not installed in the runtime, the card silently renders in a
// fallback font. The image IS the check: look at it.

export const runtime = 'nodejs';

import sharp from 'sharp';
import { randomUUID } from 'crypto';
import { getSupabaseAdmin } from '../supabaseClient';
import { BRAND_TYPOGRAPHY } from '../../config/doctrine';
import { sharpRenderer } from './sharpRenderer';
import { runStep, type ProbeStep } from '../probeStep';
import type { Brand } from '../../types/media';

export type SmokeStep = ProbeStep;

export interface SmokeRenderResult {
  ok: boolean;
  brand: Brand;
  text: string;
  /** Public URL of the fully rendered card (base + typography overlay). */
  finalUrl?: string;
  /** Byte size of the rendered card as served publicly. */
  finalBytes?: number;
  finalContentType?: string;
  steps: SmokeStep[];
  typography: {
    fontFamily: string;
    fontSize: number;
    fontWeight: number;
    color: string;
    backgroundColor: string | null;
    opacity: number;
    padding: number;
  };
  warnings: string[];
  error?: string;
}

const CANVAS_SIZE = 1080;
const BUCKET = 'media-engine';

/** Font-free brand backdrop — no text, so this step can never depend on fonts. */
export function buildCanvasSvg(brand: Brand, size = CANVAS_SIZE): Buffer {
  const bg = BRAND_TYPOGRAPHY[brand].backgroundColor ?? '#0a0a0a';
  const accent = brand === 'misfit' ? '#10b981' : '#f59e0b';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${bg}"/>
      <stop offset="55%" stop-color="#000000" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="${accent}" stop-opacity="0.22"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" fill="url(#g)"/>
  <rect x="40" y="40" width="${size - 80}" height="${size - 80}"
        fill="none" stroke="${accent}" stroke-opacity="0.55" stroke-width="3" rx="10"/>
</svg>`;
  return Buffer.from(svg);
}

export async function renderSmokeCard(
  brand: Brand,
  text: string,
): Promise<SmokeRenderResult> {
  const typo = BRAND_TYPOGRAPHY[brand];
  const steps: SmokeStep[] = [];
  const warnings: string[] = [];

  const typography = {
    fontFamily: typo.fontFamily,
    fontSize: typo.fontSize,
    fontWeight: typo.fontWeight,
    color: typo.color,
    backgroundColor: typo.backgroundColor,
    opacity: typo.opacity,
    padding: typo.padding,
  };

  const db = getSupabaseAdmin();
  const basePath = `rendered/_setup/base-${randomUUID()}.webp`;
  let basePublicUrl: string | undefined;

  // ── 1. Canvas ──────────────────────────────────────────────────────────────
  let canvas: Buffer | undefined;
  const canvasStep = await runStep('build_canvas', async () => {
    canvas = await sharp(buildCanvasSvg(brand))
      .resize(CANVAS_SIZE, CANVAS_SIZE)
      .webp({ quality: 80 })
      .toBuffer();
    return `${canvas.length} bytes, ${CANVAS_SIZE}×${CANVAS_SIZE} webp`;
  });
  steps.push(canvasStep.step);
  if (!canvasStep.ok || !canvas) {
    return {
      ok: false,
      brand,
      text,
      steps,
      typography,
      warnings,
      error: 'sharp could not build the base canvas — sharp is not usable in this runtime.',
    };
  }

  // ── 2. Upload the base ─────────────────────────────────────────────────────
  const uploadStep = await runStep('upload_base', async () => {
    const { error } = await db.storage.from(BUCKET).upload(basePath, canvas as Buffer, {
      contentType: 'image/webp',
      upsert: false,
    });
    if (error) throw new Error(error.message);
    const { data } = db.storage.from(BUCKET).getPublicUrl(basePath);
    if (!data?.publicUrl) throw new Error('getPublicUrl returned no URL');
    basePublicUrl = data.publicUrl;
    return data.publicUrl;
  });
  steps.push(uploadStep.step);
  if (!uploadStep.ok || !basePublicUrl) {
    warnings.push(
      'Storage upload failed. Check: bucket "media-engine" exists, is PUBLIC, and SUPABASE_SERVICE_ROLE_KEY is the service role (not anon).',
    );
    return { ok: false, brand, text, steps, typography, warnings };
  }

  // ── 3. Public read of the base ─────────────────────────────────────────────
  const baseReadStep = await runStep('public_read_base', async () => {
    const res = await fetch(basePublicUrl as string);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return `HTTP ${res.status}, ${buf.length} bytes, ${res.headers.get('content-type') ?? 'no content-type'}`;
  });
  steps.push(baseReadStep.step);
  if (!baseReadStep.ok) {
    warnings.push(
      'The uploaded object is not publicly readable. Flip the bucket to PUBLIC (Supabase → Storage → media-engine → Settings), or the lanes will fail on every render at the base-image fetch step.',
    );
  }

  // ── 4. The real renderer ───────────────────────────────────────────────────
  let finalUrl: string | undefined;
  const renderStep = await runStep('render_via_sharpRenderer', async () => {
    const { url } = await sharpRenderer.render(basePublicUrl as string, text, brand);
    finalUrl = url;
    return url;
  });
  steps.push(renderStep.step);

  // ── 5. Public read of the rendered card ────────────────────────────────────
  if (finalUrl) {
    const finalRead = await runStep('public_read_final', async () => {
      const res = await fetch(finalUrl as string);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return `HTTP ${res.status}, ${buf.length} bytes, ${res.headers.get('content-type') ?? 'no content-type'}`;
    });
    steps.push(finalRead.step);
  }
  const finalReadStep = steps.find((s) => s.name === 'public_read_final');

  // ── 6. Cleanup the throwaway base (best effort, never fatal) ───────────────
  const cleanupStep = await runStep('cleanup_probe_base', async () => {
    const { error } = await db.storage.from(BUCKET).remove([basePath]);
    if (error) throw new Error(error.message);
    return `removed ${basePath}`;
  });
  steps.push(cleanupStep.step);
  if (!cleanupStep.ok) {
    warnings.push(
      `Could not remove the throwaway base at ${basePath} — harmless, but delete it by hand if you care about bucket tidiness.`,
    );
  }

  warnings.push(
    `Typeface check: this card requested "${typo.fontFamily}". Nothing in this repo ships that font file, so the runtime resolves it through fontconfig. If the card below is NOT in that typeface, the font is missing in production and every real render falls back silently — fix by adding the font to the deployment (see RED-TEAM report, finding F-10).`,
  );
  warnings.push(
    'This card is in Storage only. Nothing was written to gallery_assets, review_queue or media_decisions by this check.',
  );

  const bytesFromStep = finalReadStep?.detail.match(/(\d+) bytes/)?.[1];

  return {
    ok: Boolean(finalUrl) && renderStep.ok,
    brand,
    text,
    ...(finalUrl ? { finalUrl } : {}),
    ...(bytesFromStep ? { finalBytes: Number(bytesFromStep) } : {}),
    ...(finalReadStep ? { finalContentType: finalReadStep.detail.split(', ')[2] } : {}),
    steps,
    typography,
    warnings,
    ...(renderStep.ok
      ? {}
      : { error: `Render failed: ${renderStep.step.detail}` }),
  };
}
