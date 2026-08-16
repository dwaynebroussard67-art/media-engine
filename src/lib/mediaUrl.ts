// src/lib/mediaUrl.ts
// Browser-side media URL resolution.
//
// In the normal cloud setup this is a pure passthrough: asset URLs are
// absolute public Supabase Storage URLs and load directly.
//
// In LOCAL DEV against the bundled Supabase shim (dev/local-supabase/shim.ts),
// server-stored URLs point at http://127.0.0.1:<port> because the renderer
// and the shim run server-side — a browser cannot load that host (and it is
// meaningless on a remote preview host). When NEXT_PUBLIC_MEDIA_HOST_REWRITE
// is set, that prefix is swapped for NEXT_PUBLIC_MEDIA_PUBLIC_BASE (default
// '/supabase'), which the Next dev/prod rewrites proxy to the shim, so
// <img> tags load through the app origin.
//
// Pure function, env-gated: with no env vars set it is the identity.

export function resolveMediaUrl(url: string): string {
  const from = process.env.NEXT_PUBLIC_MEDIA_HOST_REWRITE;
  const to = process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE ?? '/supabase';
  if (from && url.startsWith(from)) {
    return to + url.slice(from.length);
  }
  return url;
}
