// src/lib/render/sharpRenderer.ts
//
// Node.js runtime ONLY — sharp is not edge-compatible.
// Any route or cron that imports this must export:
//   export const runtime = 'nodejs';
//
// Unverified — traced by hand. Must be checked against:
//   1. Actual sharp API for composite() with SVG input (confirmed in sharp 0.33 docs,
//      but composite({ input: Buffer, blend }) signature must be verified at runtime).
//   2. Supabase Storage upload returning a public URL — bucket must be PUBLIC.
//   3. Word-wrap logic produces correct SVG line breaks for all brand fonts.
//   4. fetch() availability in the Node runtime on Vercel (available Node 18+).

export const runtime = 'nodejs';

import sharp from 'sharp';
import { randomUUID } from 'crypto';
import { getSupabaseAdmin } from '../supabaseClient';
import { BRAND_TYPOGRAPHY } from '../../config/doctrine';
import type { Brand } from '../../types/media';
import type { TextOverlayRenderer } from '../lanes/recombination';

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class BaseImageFetchError extends Error {
  constructor(
    public readonly url: string,
    public readonly statusOrReason: string
  ) {
    super(`Failed to fetch base image from "${url}": ${statusOrReason}`);
    this.name = 'BaseImageFetchError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class RenderUploadError extends Error {
  constructor(public readonly reason: string) {
    super(`Failed to upload rendered image to Storage: ${reason}`);
    this.name = 'RenderUploadError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Word-wrap helper
// ---------------------------------------------------------------------------

/**
 * Breaks `text` into lines of at most `maxCharsPerLine` characters,
 * splitting on word boundaries. Never splits mid-word.
 */
function wrapText(text: string, maxCharsPerLine: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (current === '') {
      current = word;
    } else if ((current + ' ' + word).length <= maxCharsPerLine) {
      current += ' ' + word;
    } else {
      lines.push(current);
      current = word;
    }
  }

  if (current !== '') lines.push(current);
  return lines;
}

// ---------------------------------------------------------------------------
// SVG text layer builder
// ---------------------------------------------------------------------------

/**
 * Builds an SVG buffer that sharp can composite over a base image.
 * Uses BRAND_TYPOGRAPHY for font, size, color, and scrim settings.
 *
 * `width` and `height` are the pixel dimensions of the base image —
 * the SVG viewport must match for correct positioning.
 *
 * The scrim is a semi-transparent rectangle behind the text block.
 * scrim opacity is expected as a number 0–1 in BRAND_TYPOGRAPHY[brand].scrim.
 * If no scrim is configured, no rectangle is drawn.
 */
function buildSvgOverlay(
  text: string,
  brand: Brand,
  width: number,
  height: number
): Buffer {
  const typo = BRAND_TYPOGRAPHY[brand];

  // BrandTypographyStyle is a concrete exported type — use its real fields.
  // (A previous draft accessed phantom .font/.size/.scrim; those fields do
  // not exist and every render silently fell back to defaults with no scrim.)
  const fontFamily = typo.fontFamily;
  const fontSize = typo.fontSize;
  const fontWeight = typo.fontWeight;
  const color = typo.color;
  // scrim opacity: 0 disables the background rect entirely
  const scrim = typo.backgroundColor === null ? 0 : typo.opacity;
  const scrimColor = typo.backgroundColor ?? '#000000';

  // Heuristic: ~1.5 chars per em at the given font size, across the image width
  // with 10% padding each side. This is approximate — verify at runtime.
  const paddingPx = width * 0.1;
  const usableWidthPx = width - 2 * paddingPx;
  const charsPerLine = Math.max(10, Math.floor(usableWidthPx / (fontSize * 0.55)));
  const lines = wrapText(text, charsPerLine);

  const lineHeightPx = fontSize * 1.35;
  const blockHeightPx = lines.length * lineHeightPx;
  const textBlockTopPx = height - blockHeightPx - height * 0.08; // 8% from bottom

  const scrimRect =
    scrim > 0
      ? `<rect
           x="${paddingPx * 0.5}"
           y="${textBlockTopPx - fontSize * 0.4}"
           width="${usableWidthPx + paddingPx}"
           height="${blockHeightPx + fontSize * 0.8}"
           fill="${scrimColor}" opacity="${scrim.toFixed(2)}"
           rx="4" ry="4"/>`
      : '';

  const textElements = lines
    .map((line, i) => {
      // Escape XML special characters to prevent SVG injection.
      const escaped = line
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

      const y = textBlockTopPx + i * lineHeightPx + fontSize;
      return `<text
        x="${width / 2}"
        y="${y}"
        font-family="${fontFamily}"
        font-size="${fontSize}"
        fill="${color}"
        font-weight="${fontWeight}"
        text-anchor="middle"
        dominant-baseline="auto">${escaped}</text>`;
    })
    .join('\n');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  ${scrimRect}
  ${textElements}
</svg>`;

  return Buffer.from(svg);
}

// ---------------------------------------------------------------------------
// Renderer implementation
// ---------------------------------------------------------------------------

export const sharpRenderer: TextOverlayRenderer = {
  async render(
    baseUrl: string,
    text: string,
    brand: Brand
  ): Promise<{ url: string }> {
    // 1. Fetch base image.
    let imageBuffer: Buffer;
    try {
      const response = await fetch(baseUrl);
      if (!response.ok) {
        throw new BaseImageFetchError(
          baseUrl,
          `HTTP ${response.status} ${response.statusText}`
        );
      }
      const arrayBuffer = await response.arrayBuffer();
      imageBuffer = Buffer.from(arrayBuffer);
    } catch (err) {
      if (err instanceof BaseImageFetchError) throw err;
      throw new BaseImageFetchError(
        baseUrl,
        err instanceof Error ? err.message : String(err)
      );
    }

    // 2. Read dimensions before compositing.
    const metadata = await sharp(imageBuffer).metadata();
    const width = metadata.width ?? 1080;
    const height = metadata.height ?? 1080;

    // 3. Build SVG overlay.
    const svgBuffer = buildSvgOverlay(text, brand, width, height);

    // 4. Composite and encode as webp.
    let renderedBuffer: Buffer;
    try {
      renderedBuffer = await sharp(imageBuffer)
        .composite([{ input: svgBuffer, blend: 'over' }])
        .webp({ quality: 85 })
        .toBuffer();
    } catch (err) {
      // Sharp errors are not typed; surface the message.
      throw new RenderUploadError(
        `sharp composite/encode failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // 5. Upload to Supabase Storage.
    const filename = `rendered/${brand}/${randomUUID()}.webp`;
    const db = getSupabaseAdmin();

    const { error: uploadError } = await db.storage
      .from('media-engine')
      .upload(filename, renderedBuffer, {
        contentType: 'image/webp',
        upsert: false,
      });

    if (uploadError) {
      throw new RenderUploadError(uploadError.message);
    }

    // 6. Retrieve the public URL.
    const { data: urlData } = db.storage
      .from('media-engine')
      .getPublicUrl(filename);

    if (!urlData?.publicUrl) {
      throw new RenderUploadError(
        `Storage upload succeeded but getPublicUrl returned no URL for "${filename}"`
      );
    }

    return { url: urlData.publicUrl };
  },
};
