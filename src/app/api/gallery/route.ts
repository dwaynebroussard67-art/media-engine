// src/app/api/gallery/route.ts
//
// Replaces the Stage 1 version.
// B7 fix: manual uploads now get source: 'seed' (not 'generated_and_approved').
// 'generated_and_approved' is reserved for the decision path (onPostApproved).
//
// All other behavior is identical to the Stage 1 version — read Section 2.10.
// Do NOT change anything else in this file.
//
// Unverified — traced by hand.

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { verifyUserJwt, getSupabaseAdmin } from '../../../lib/supabaseClient';
import { addToGallery, supabaseAssetStore } from '../../../lib/permanentAssets';
import type { AssetBrand, AssetCategory, GalleryAsset } from '../../../types/media';

const VALID_BRANDS: ReadonlySet<AssetBrand> = new Set(['misfit', 'forge', 'shared']);
const VALID_CATEGORIES: ReadonlySet<AssetCategory> = new Set([
  'logo',
  'apparel',
  'art',
  'atmosphere',
  'approved_post',
]);
const ALLOWED_MIME_TYPES: ReadonlyMap<string, string> = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
]);
const MAX_BYTES = 15 * 1024 * 1024; // 15 MB

function parseWriterIds(): string[] {
  return (process.env.GALLERY_WRITER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// GET — public listing
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = req.nextUrl;
  const brand = searchParams.get('brand') as AssetBrand | null;
  const category = searchParams.get('category') as AssetCategory | null;

  if (brand && !VALID_BRANDS.has(brand)) {
    return NextResponse.json({ error: 'Invalid brand' }, { status: 400 });
  }
  if (category && !VALID_CATEGORIES.has(category)) {
    return NextResponse.json({ error: 'Invalid category' }, { status: 400 });
  }

  try {
    const assets = await supabaseAssetStore.list(
      brand || category ? { brand: brand ?? undefined, category: category ?? undefined } : undefined
    );
    return NextResponse.json({ assets });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[gallery GET]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST — authenticated upload
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  // 1. JWT auth.
  const authHeader = req.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return NextResponse.json({ error: 'Authorization header required' }, { status: 401 });
  }

  const user = await verifyUserJwt(token);
  if (!user) {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
  }

  // 2. Writer allowlist. Empty = nobody can write, fails closed.
  const writerIds = parseWriterIds();
  if (writerIds.length === 0 || !writerIds.includes(user.id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // 3. Parse form data.
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 });
  }

  const brandRaw = formData.get('brand');
  const categoryRaw = formData.get('category');
  const file = formData.get('file');

  if (typeof brandRaw !== 'string' || !VALID_BRANDS.has(brandRaw as AssetBrand)) {
    return NextResponse.json({ error: 'Invalid or missing brand' }, { status: 400 });
  }
  if (typeof categoryRaw !== 'string' || !VALID_CATEGORIES.has(categoryRaw as AssetCategory)) {
    return NextResponse.json({ error: 'Invalid or missing category' }, { status: 400 });
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing file field' }, { status: 400 });
  }

  // 4. MIME allowlist.
  const ext = ALLOWED_MIME_TYPES.get(file.type);
  if (!ext) {
    return NextResponse.json(
      { error: 'File type not allowed. Use png, jpeg, or webp.' },
      { status: 415 }
    );
  }

  // 5. Size cap.
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'File exceeds 15 MB limit' }, { status: 413 });
  }

  // 6. Upload to Storage.
  const assetId = randomUUID();
  const storagePath = `gallery/${brandRaw}/${assetId}.${ext}`;
  const db = getSupabaseAdmin();

  const fileBuffer = Buffer.from(await file.arrayBuffer());

  const { error: uploadError } = await db.storage
    .from('media-engine')
    .upload(storagePath, fileBuffer, {
      contentType: file.type,
      upsert: false,
    });

  if (uploadError) {
    console.error('[gallery POST] storage upload failed:', uploadError.message);
    return NextResponse.json({ error: 'Storage upload failed' }, { status: 500 });
  }

  const { data: urlData } = db.storage.from('media-engine').getPublicUrl(storagePath);

  if (!urlData?.publicUrl) {
    return NextResponse.json({ error: 'Could not retrieve public URL after upload' }, { status: 500 });
  }

  // 7. Insert gallery record.
  // B7 FIX: manual uploads are source 'seed', NOT 'generated_and_approved'.
  const asset: GalleryAsset = {
    id: assetId,
    url: urlData.publicUrl,
    brand: brandRaw as AssetBrand,
    category: categoryRaw as AssetCategory,
    forSale: false,
    source: 'seed', // ← B7 fix
    addedAt: Date.now(),
    permanent: true,
  };

  try {
    await addToGallery(supabaseAssetStore, asset);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[gallery POST] addToGallery failed:', message);
    return NextResponse.json({ error: 'Gallery insert failed' }, { status: 500 });
  }

  return NextResponse.json({ asset }, { status: 201 });
}

// ---------------------------------------------------------------------------
// PATCH / DELETE — 405
// ---------------------------------------------------------------------------

export async function PATCH(): Promise<NextResponse> {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}

export async function DELETE(): Promise<NextResponse> {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}
