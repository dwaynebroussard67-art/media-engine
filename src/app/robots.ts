// src/app/robots.ts
//
// The operator surfaces are not for crawlers: /review shows unreleased brand
// copy and /setup describes the deployment's configuration. Neither was
// protected from indexing before (red-team finding F-14).
//
// This is hygiene, not access control — the real gate is the writer allowlist.

import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/setup', '/review', '/api/'],
      },
    ],
  };
}
