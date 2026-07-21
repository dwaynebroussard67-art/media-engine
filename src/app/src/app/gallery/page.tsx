'use client';
// src/app/gallery/page.tsx
//
// Drag-and-drop upload UI for the permanent gallery, plus a live grid of
// everything already in it. Talks directly to POST /api/gallery (Stage 1) —
// no new backend logic, this page only adds the missing frontend.
//
// Auth: uses the browser Supabase client (anon key) to get the signed-in
// user's JWT, same session the /review page relies on. If nobody is signed
// in, uploads are rejected client-side before hitting the network — the
// server enforces GALLERY_WRITER_IDS regardless, this is just a faster no.

import { useCallback, useEffect, useState, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';
import type { AssetBrand, AssetCategory, GalleryAsset } from '../../types/media';

const supabaseBrowser = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const BRANDS: AssetBrand[] = ['misfit', 'forge', 'shared'];
const CATEGORIES: AssetCategory[] = ['logo', 'apparel', 'art', 'atmosphere', 'approved_post'];

type UploadStatus = 'idle' | 'uploading' | 'done' | 'error';

interface QueuedFile {
  file: File;
  status: UploadStatus;
  detail?: string;
}

export default function GalleryPage() {
  const [brand, setBrand] = useState<AssetBrand>('misfit');
  const [category, setCategory] = useState<AssetCategory>('art');
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [assets, setAssets] = useState<GalleryAsset[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- Load existing gallery, filtered to the selected brand -------------
  const loadAssets = useCallback(async (b: AssetBrand) => {
    setLoadError(null);
    try {
      const res = await fetch(`/api/gallery?brand=${b}`);
      const body = await res.json();
      if (!res.ok) {
        setLoadError(body.error ?? 'Failed to load gallery.');
        return;
      }
      setAssets(body.assets ?? []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load gallery.');
    }
  }, []);

  useEffect(() => {
    loadAssets(brand);
  }, [brand, loadAssets]);

  // --- Upload a single file against the existing Stage 1 endpoint --------
  const uploadOne = useCallback(
    async (qf: QueuedFile, index: number) => {
      const patch = (status: UploadStatus, detail?: string) =>
        setQueue((prev) =>
          prev.map((item, i) => (i === index ? { ...item, status, detail } : item))
        );

      patch('uploading');

      const {
        data: { session },
      } = await supabaseBrowser.auth.getSession();

      if (!session) {
        patch('error', 'Not signed in — sign in on the review page first.');
        return;
      }

      const formData = new FormData();
      formData.append('file', qf.file);
      formData.append('brand', brand);
      formData.append('category', category);

      try {
        const res = await fetch('/api/gallery', {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.access_token}` },
          body: formData,
        });
        const body = await res.json();

        if (!res.ok) {
          patch('error', body.error ?? `Upload failed (${res.status})`);
          return;
        }

        patch('done');
        loadAssets(brand);
      } catch (err) {
        patch('error', err instanceof Error ? err.message : 'Network error');
      }
    },
    [brand, category, loadAssets]
  );

  // --- File selection (drag-drop or click-to-browse share this path) -----
  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;

      const accepted = ['image/png', 'image/jpeg', 'image/webp'];
      const next: QueuedFile[] = Array.from(files)
        .filter((f) => accepted.includes(f.type))
        .map((file) => ({ file, status: 'idle' as UploadStatus }));

      const rejected = files.length - next.length;

      setQueue((prev) => {
        const startIndex = prev.length;
        const merged = [...prev, ...next];
        // Kick off uploads for the newly added files only.
        next.forEach((qf, i) => uploadOne(qf, startIndex + i));
        return merged;
      });

      if (rejected > 0) {
        setLoadError(
          `${rejected} file(s) skipped — only PNG, JPEG, and WEBP are accepted.`
        );
      }
    },
    [uploadOne]
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(false);
      handleFiles(e.dataTransfer.files);
    },
    [handleFiles]
  );

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 p-4 sm:p-8">
      <div className="max-w-3xl mx-auto flex flex-col gap-6">
        <header>
          <h1 className="text-xl font-semibold">Gallery</h1>
          <p className="text-neutral-400 text-sm mt-1">
            Drop images here to add them permanently. Anything you approve in
            Review lands here automatically too — nothing to do for that.
          </p>
        </header>

        {/* --- Brand / category selectors --- */}
        <div className="flex gap-3 flex-wrap">
          <select
            value={brand}
            onChange={(e) => setBrand(e.target.value as AssetBrand)}
            className="bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-sm"
          >
            {BRANDS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>

          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as AssetCategory)}
            className="bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-sm"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        {/* --- Drop zone --- */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
          aria-label="Drop images here or tap to choose files"
          className={`rounded-lg border-2 border-dashed p-10 text-center cursor-pointer transition-colors
            ${isDragging ? 'border-emerald-500 bg-emerald-500/5' : 'border-neutral-700 bg-neutral-900/50'}`}
        >
          <p className="text-neutral-300 font-medium">
            Drop images here, or tap to choose files
          </p>
          <p className="text-neutral-500 text-xs mt-1">PNG, JPEG, WEBP · up to 15MB each</p>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>

        {loadError && (
          <p className="text-rose-400 text-sm" role="alert">
            {loadError}
          </p>
        )}

        {/* --- Upload queue status --- */}
        {queue.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm">
            {queue.map((qf, i) => (
              <li key={i} className="flex justify-between items-center gap-2">
                <span className="truncate text-neutral-300">{qf.file.name}</span>
                <span
                  className={
                    qf.status === 'done'
                      ? 'text-emerald-400'
                      : qf.status === 'error'
                        ? 'text-rose-400'
                        : 'text-neutral-500'
                  }
                >
                  {qf.status === 'uploading' && 'Uploading…'}
                  {qf.status === 'done' && 'Added'}
                  {qf.status === 'error' && (qf.detail ?? 'Failed')}
                  {qf.status === 'idle' && 'Queued'}
                </span>
              </li>
            ))}
          </ul>
        )}

        {/* --- Existing gallery grid --- */}
        <section>
          <h2 className="text-sm font-medium text-neutral-400 mb-2">
            {brand} gallery — {assets.length} asset{assets.length === 1 ? '' : 's'}
          </h2>
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
            {assets.map((asset) => (
              <div
                key={asset.id}
                className="aspect-square rounded overflow-hidden bg-neutral-900 border border-neutral-800 relative"
              >
                <img
                  src={asset.url}
                  alt={`${asset.category} asset`}
                  className="object-cover h-full w-full"
                  loading="lazy"
                />
                <span className="absolute bottom-1 left-1 bg-black/70 text-[10px] px-1.5 py-0.5 rounded text-neutral-300">
                  {asset.category}
                  {asset.source === 'generated_and_approved' ? ' · auto' : ''}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
