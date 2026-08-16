import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Local-dev Supabase shim support.
  //
  // When LOCAL_SUPABASE_SHIM_URL is set (see dev/local-supabase/shim.ts),
  // browser traffic to /supabase/* is proxied to the shim, so the review and
  // gallery pages can use a RELATIVE NEXT_PUBLIC_SUPABASE_URL (e.g.
  // "/supabase") that works both locally and behind a remote preview host.
  // Unset in production — this adds no routes to normal deployments.
  async rewrites() {
    const target = process.env.LOCAL_SUPABASE_SHIM_URL;
    if (!target) return [];
    return [
      { source: '/supabase/auth/:path*', destination: `${target}/auth/:path*` },
      { source: '/supabase/rest/:path*', destination: `${target}/rest/:path*` },
      { source: '/supabase/storage/:path*', destination: `${target}/storage/:path*` },
    ];
  },
};

export default nextConfig;
