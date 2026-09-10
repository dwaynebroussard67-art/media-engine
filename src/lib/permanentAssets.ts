// ============================================================================
// PERMANENT BRAND ASSETS — images baked into the build forever.
// ----------------------------------------------------------------------------
// HOW IT WORKS (D: this is the part you asked for):
//   Drop any image files into  src/assets/brand/
//   That's it. Vite bundles every one of them into the app at build time. They
//   become PERMANENT reference/gallery images — they can't be deleted from the
//   UI, they ship with every deploy, and they feed the taste memory as trusted
//   on-brand examples. You never have to re-upload them.
//
//   File-name → brand routing (optional, case-insensitive):
//     misfit-*.jpg / *-misfit.png  → tagged to Misfit Ministries
//     forge-*.jpg  / *-forge.png    → tagged to Forge Mode
//     anything else                 → shared / both brands
// ============================================================================
import type { Brand } from '../config/brands';

// eager glob → { '/src/assets/brand/x.jpg': '/assets/x-hash.jpg' }
const modules = import.meta.glob('../assets/brand/*.{png,jpg,jpeg,webp,gif,avif}', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

export interface PermanentAsset {
  id: string;
  url: string;
  name: string;
  brand: Brand | 'shared';
  permanent: true;
}

function routeBrand(name: string): Brand | 'shared' {
  const n = name.toLowerCase();
  if (n.includes('misfit')) return 'misfit';
  if (n.includes('forge')) return 'forge';
  return 'shared';
}

export const PERMANENT_ASSETS: PermanentAsset[] = Object.entries(modules).map(([path, url]) => {
  const name = path.split('/').pop() ?? 'asset';
  return { id: `perm-${name}`, url, name, brand: routeBrand(name), permanent: true as const };
});

// Assets that should seed a given brand's gallery (brand-specific + shared).
export function permanentAssetsForBrand(brand: Brand): PermanentAsset[] {
  return PERMANENT_ASSETS.filter((a) => a.brand === brand || a.brand === 'shared');
}

export const hasPermanentAssets = PERMANENT_ASSETS.length > 0;
