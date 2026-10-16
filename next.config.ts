import type { NextConfig } from 'next';

// Security headers (2026-10-15).
//
// Deliberately NOT included here: `Content-Security-Policy: frame-ancestors
// 'none'` / `X-Frame-Options: DENY`, which is the correct hardening for a page
// where a mis-click permanently approves an item into an append-only gallery.
// Those headers break any embedding host, including the in-browser preview this
// app is developed in, so they are documented in RED-TEAM-2026-10-15.md (F-11)
// with the exact snippet to paste in when the app is served on its own domain.
//
// What IS safe on every response and cannot break rendering:
const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-DNS-Prefetch-Control', value: 'off' },
        ],
      },
    ];
  },
};

export default nextConfig;
