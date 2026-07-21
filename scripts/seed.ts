// scripts/seed.ts
//
// Reads a local folder of images + a JSON manifest, uploads to Storage,
// inserts via addToGallery with source: 'seed'.
// Idempotent by content hash — re-running never duplicates.
//
// Manifest format (seed-manifest.json):
//   Array of { file: string (relative path from manifest dir), brand, category, tags? }
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx ts-node scripts/seed.ts \
//     --manifest ./seeds/seed-manifest.json
//
// Unverified — traced by hand.
// ts-node must be installed: npm i -D ts-node

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import type { AssetBrand, AssetCategory, GalleryAsset } from '../src/types/media';

// ---------------------------------------------------------------------------
// Supabase admin — direct init (not through lazy singleton, since this is a
// CLI script that can read env vars at startup).
// ---------------------------------------------------------------------------

function getDb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---------------------------------------------------------------------------
// Manifest types
// ---------------------------------------------------------------------------

interface ManifestEntry {
  file: string;
  brand: AssetBrand;
  category: AssetCategory;
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Content hash — SHA-256 of file bytes, first 16 hex chars = 64-bit id prefix.
// Full hash stored as asset id so re-runs detect existing records.
// ---------------------------------------------------------------------------

function contentHash(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// MIME from extension
// ---------------------------------------------------------------------------

const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

const EXT_TO_CANONICAL: Record<string, string> = {
  png: 'png',
  jpg: 'jpg',
  jpeg: 'jpg',
  webp: 'webp',
};

function mimeFromExt(ext: string): { mime: string; canonical: string } | null {
  const lower = ext.toLowerCase();
  const mime = EXT_TO_MIME[lower];
  const canonical = EXT_TO_CANONICAL[lower];
  if (!mime || !canonical) return null;
  return { mime, canonical };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const manifestFlagIdx = args.indexOf('--manifest');
  if (manifestFlagIdx === -1 || !args[manifestFlagIdx + 1]) {
    console.error('Usage: ts-node scripts/seed.ts --manifest <path-to-manifest.json>');
    process.exit(1);
  }

  const manifestPath = path.resolve(args[manifestFlagIdx + 1]);
  const manifestDir = path.dirname(manifestPath);

  if (!fs.existsSync(manifestPath)) {
    console.error(`Manifest not found: ${manifestPath}`);
    process.exit(1);
  }

  let entries: ManifestEntry[];
  try {
    entries = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ManifestEntry[];
  } catch (err) {
    console.error('Failed to parse manifest JSON:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  if (!Array.isArray(entries)) {
    console.error('Manifest must be a JSON array.');
    process.exit(1);
  }

  const db = getDb();
  let seeded = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of entries) {
    const filePath = path.resolve(manifestDir, entry.file);
    if (!fs.existsSync(filePath)) {
      console.error(`[skip] File not found: ${filePath}`);
      failed++;
      continue;
    }

    const buf = fs.readFileSync(filePath);
    const hash = contentHash(buf);
    const ext = path.extname(filePath).slice(1);
    const mimeInfo = mimeFromExt(ext);

    if (!mimeInfo) {
      console.error(`[skip] Unsupported extension "${ext}" for file: ${filePath}`);
      failed++;
      continue;
    }

    const assetId = hash; // full 64-char hex hash as stable id
    const storagePath = `gallery/${entry.brand}/${assetId}.${mimeInfo.canonical}`;

    // Check if already in gallery (idempotent by id).
    const { data: existing } = await db
      .from('gallery_assets')
      .select('id')
      .eq('id', assetId)
      .maybeSingle();

    if (existing) {
      console.log(`[skip] Already seeded: ${entry.file} (id: ${assetId.slice(0, 12)}…)`);
      skipped++;
      continue;
    }

    // Upload to Storage.
    const { error: uploadError } = await db.storage
      .from('media-engine')
      .upload(storagePath, buf, {
        contentType: mimeInfo.mime,
        upsert: false,
      });

    if (uploadError) {
      // If upsert:false and the file already exists in Storage, this will error.
      // That means the DB row was deleted (impossible — append-only) or the
      // Storage upload succeeded but the DB insert failed previously.
      // Treat as non-fatal: attempt DB insert anyway.
      if (!uploadError.message.includes('already exists')) {
        console.error(`[fail] Storage upload failed for ${entry.file}: ${uploadError.message}`);
        failed++;
        continue;
      }
      console.warn(`[warn] Storage file already exists for ${entry.file} — proceeding to DB insert.`);
    }

    const { data: urlData } = db.storage
      .from('media-engine')
      .getPublicUrl(storagePath);

    if (!urlData?.publicUrl) {
      console.error(`[fail] Could not get public URL for ${entry.file}`);
      failed++;
      continue;
    }

    // Insert into gallery_assets directly via Supabase client.
    // We use the DB client directly rather than addToGallery() to include tags,
    // since GalleryAsset type does not have tags (it was added by migration 002).
    const { error: insertError } = await db.from('gallery_assets').insert({
      id: assetId,
      url: urlData.publicUrl,
      brand: entry.brand,
      category: entry.category,
      for_sale: false,
      source: 'seed',
      added_at: Date.now(),
      permanent: true,
      tags: entry.tags ?? [],
    });

    if (insertError) {
      if (insertError.code === '23505') {
        console.log(`[skip] DB duplicate (race): ${entry.file}`);
        skipped++;
      } else {
        console.error(`[fail] DB insert failed for ${entry.file}: ${insertError.message}`);
        failed++;
      }
      continue;
    }

    console.log(`[ok] Seeded: ${entry.file} → ${assetId.slice(0, 12)}…`);
    seeded++;
  }

  console.log(`\nDone. seeded=${seeded} skipped=${skipped} failed=${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Seed script crashed:', err);
  process.exit(1);
});
