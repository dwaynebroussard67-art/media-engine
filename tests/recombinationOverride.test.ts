// tests/recombinationOverride.test.ts
// Pins the Stage 3 addition to generateRecombinationPost: an optional
// `lastUsedIndex` test override, mirroring freshTextCard.
//
//   - With the override supplied: rotation_state is neither read nor written
//     (tests own their state), and the deterministic selector still picks
//     the right base via safeMod.
//   - Without it: the persisted pointer is read, the base advances, and the
//     pointer is advanced only after a successful render.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/supabaseClient', () => ({
  getSupabaseAdmin: vi.fn(),
  verifyUserJwt: vi.fn(),
  _resetSupabaseAdminForTesting: vi.fn(),
  SupabaseNotConfiguredError: class SupabaseNotConfiguredError extends Error {},
}));

import { getSupabaseAdmin } from '../src/lib/supabaseClient';
import { generateRecombinationPost } from '../src/lib/lanes/recombination';
import type { GalleryAsset } from '../src/types/media';

function makeAsset(overrides: Partial<GalleryAsset> = {}): GalleryAsset {
  return {
    id: 'a1',
    url: 'https://example.com/a.png',
    brand: 'misfit',
    category: 'art',
    forSale: false,
    source: 'seed',
    addedAt: 1000,
    permanent: true,
    ...overrides,
  };
}

function makeRotationFake(initialIndex: number) {
  const calls: string[] = [];
  const upserts: Array<Record<string, unknown>> = [];
  const client = {
    from(table: string) {
      if (table === 'rotation_state') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => {
                calls.push('select');
                return { data: { last_used_index: initialIndex }, error: null };
              },
            }),
          }),
          upsert: async (row: Record<string, unknown>) => {
            calls.push('upsert');
            upserts.push(row);
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { client, calls, upserts };
}

const baseDeps = () => ({
  assetStore: {
    get: vi.fn(),
    insert: vi.fn(),
    list: vi
      .fn()
      .mockResolvedValueOnce([
        makeAsset({ id: 'a1', url: 'https://example.com/a1.png', addedAt: 1000 }),
        makeAsset({ id: 'a2', url: 'https://example.com/a2.png', addedAt: 2000 }),
      ])
      .mockResolvedValueOnce([]), // shared
  },
  textBank: { pick: vi.fn().mockResolvedValue('He makes all things new.') },
  renderer: {
    render: vi.fn().mockResolvedValue({ url: 'https://example.com/r.webp' }),
  },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateRecombinationPost — lastUsedIndex override', () => {
  it('with override: skips rotation_state entirely and selects deterministically', async () => {
    const rotation = makeRotationFake(0);
    vi.mocked(getSupabaseAdmin).mockReturnValue(rotation.client as never);
    const deps = baseDeps();

    // lastUsedIndex 0 → next = 1 → base is a2 (sorted by addedAt ascending).
    const item = await generateRecombinationPost('misfit', {
      ...deps,
      lastUsedIndex: 0,
    });

    expect(item.sourceData.baseImageId).toBe('a2');
    expect(rotation.calls).toEqual([]); // no rotation_state read or write
    expect(deps.renderer.render).toHaveBeenCalledWith(
      'https://example.com/a2.png',
      'He makes all things new.',
      'misfit'
    );
  });

  it('with override: corrupted huge index is normalized via safeMod', async () => {
    const rotation = makeRotationFake(0);
    vi.mocked(getSupabaseAdmin).mockReturnValue(rotation.client as never);

    // (999 + 1) % 2 = 0 → base a1.
    const item = await generateRecombinationPost('misfit', {
      ...baseDeps(),
      lastUsedIndex: 999,
    });

    expect(item.sourceData.baseImageId).toBe('a1');
    expect(rotation.calls).toEqual([]);
  });

  it('without override: reads the persisted pointer and advances after render', async () => {
    const rotation = makeRotationFake(0);
    vi.mocked(getSupabaseAdmin).mockReturnValue(rotation.client as never);

    const item = await generateRecombinationPost('misfit', baseDeps());

    expect(item.sourceData.baseImageId).toBe('a2');
    expect(rotation.calls).toEqual(['select', 'upsert']);
    expect(rotation.upserts).toHaveLength(1);
    expect(rotation.upserts[0]).toMatchObject({
      brand: 'misfit',
      last_used_asset_id: 'a2',
      last_used_index: 1,
    });
  });

  it('without override: does NOT advance the pointer when the render fails', async () => {
    const rotation = makeRotationFake(0);
    vi.mocked(getSupabaseAdmin).mockReturnValue(rotation.client as never);
    const deps = baseDeps();
    deps.renderer.render.mockRejectedValueOnce(new Error('render exploded'));

    await expect(
      generateRecombinationPost('misfit', deps)
    ).rejects.toThrow('render exploded');

    expect(rotation.calls).toEqual(['select']); // read happened, no upsert
  });
});
