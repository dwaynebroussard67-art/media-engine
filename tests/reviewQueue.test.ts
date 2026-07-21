// tests/reviewQueue.test.ts
// Finality, race, and crash-recovery coverage for the decision handler.
// getSupabaseAdmin is mocked per-test; no network calls occur.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/lib/supabaseClient', () => ({
  getSupabaseAdmin: vi.fn(),
  verifyUserJwt: vi.fn(),
  _resetSupabaseAdminForTesting: vi.fn(),
}));

import { getSupabaseAdmin } from '../src/lib/supabaseClient';
import {
  handleReviewDecision,
  FinalityViolationError,
} from '../src/lib/review/reviewQueue';
import type { ReviewItem } from '../src/types/media';

function makeItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: 'item-1',
    imageUrl: 'https://example.com/x.png',
    brand: 'misfit',
    generationLane: 'recombination',
    createdAt: Date.now(),
    sourceData: {},
    oracleResult: { passed: true, reasons: [], checkedAt: Date.now() },
    ...overrides,
  };
}

// Minimal fake of the Supabase query surface used by reviewQueue +
// permanentAssets. Tables are plain maps; media_decisions and remix_queue
// enforce their unique constraints like Postgres would.
function makeFakeDb(seed?: {
  decisions?: Array<Record<string, unknown>>;
}) {
  const decisions: Array<Record<string, unknown>> = [...(seed?.decisions ?? [])];
  const remix: Array<Record<string, unknown>> = [];
  const gallery: Array<Record<string, unknown>> = [];
  const queueUpdates: Array<Record<string, unknown>> = [];

  const db = {
    decisions, remix, gallery, queueUpdates,
    client: {
      from(table: string) {
        if (table === 'media_decisions') {
          return {
            select: () => ({
              eq: (_c: string, v: string) => ({
                maybeSingle: async () => ({
                  data: decisions.find((d) => d.item_id === v) ?? null,
                  error: null,
                }),
              }),
            }),
            insert: async (row: Record<string, unknown>) => {
              if (decisions.some((d) => d.item_id === row.item_id)) {
                return { error: { code: '23505', message: 'duplicate key' } };
              }
              decisions.push(row);
              return { error: null };
            },
          };
        }
        if (table === 'remix_queue') {
          return {
            insert: async (row: Record<string, unknown>) => {
              if (remix.some((r) => r.original_item_id === row.original_item_id)) {
                return { error: { code: '23505', message: 'duplicate key' } };
              }
              remix.push(row);
              return { error: null };
            },
          };
        }
        if (table === 'gallery_assets') {
          return {
            insert: async (row: Record<string, unknown>) => {
              if (gallery.some((g) => g.id === row.id)) {
                return { error: { code: '23505', message: 'duplicate key' } };
              }
              gallery.push(row);
              return { error: null };
            },
            select: () => ({
              eq: (_c: string, v: string) => ({
                maybeSingle: async () => ({
                  data: gallery.find((g) => g.id === v) ?? null,
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'review_queue') {
          return {
            update: (patch: Record<string, unknown>) => ({
              eq: async () => { queueUpdates.push(patch); return { error: null }; },
            }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    },
  };
  return db;
}

beforeEach(() => vi.clearAllMocks());

describe('handleReviewDecision — finality, races, recovery', () => {
  it('records a post decision and writes the gallery asset', async () => {
    const db = makeFakeDb();
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as any);

    const record = await handleReviewDecision(makeItem(), 'post');
    expect(record.decision).toBe('post');
    expect(record.galleryEntryId).toBe('item-1');
    expect(db.decisions).toHaveLength(1);
    expect(db.gallery).toHaveLength(1);
  });

  it('throws FinalityViolationError when a DIFFERENT decision already exists', async () => {
    const db = makeFakeDb({
      decisions: [{
        id: 'd1', item_id: 'item-1', decision: 'reject', brand: 'misfit',
        lane: 'recombination', oracle_result: { passed: true, reasons: [], checkedAt: 0 },
        gallery_entry_id: null, decided_at: 111,
      }],
    });
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as any);

    const err = await handleReviewDecision(makeItem(), 'post').catch((e) => e);
    expect(err).toBeInstanceOf(FinalityViolationError);
    expect((err as FinalityViolationError).existing).toBe('reject');
    expect(db.gallery).toHaveLength(0); // no side effect for the violator
  });

  it('idempotent replay: SAME decision re-submitted completes missing side effects', async () => {
    // Crash-window simulation: decision recorded, gallery write never happened.
    const db = makeFakeDb({
      decisions: [{
        id: 'd1', item_id: 'item-1', decision: 'post', brand: 'misfit',
        lane: 'recombination', oracle_result: { passed: true, reasons: [], checkedAt: 0 },
        gallery_entry_id: 'item-1', decided_at: 111,
      }],
    });
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as any);

    const record = await handleReviewDecision(makeItem(), 'post');
    expect(record.id).toBe('d1');            // existing record returned
    expect(record.decidedAt).toBe(111);      // original timestamp preserved
    expect(db.decisions).toHaveLength(1);    // no second decision
    expect(db.gallery).toHaveLength(1);      // missing side effect completed
  });

  it('losing a 23505 race on the SAME decision resolves idempotently', async () => {
    const db = makeFakeDb();
    // First lookup sees nothing (both racers passed the pre-check), then the
    // INSERT hits the unique index because the other racer landed first.
    const winnerRow = {
      id: 'winner', item_id: 'item-1', decision: 'post', brand: 'misfit',
      lane: 'recombination', oracle_result: { passed: true, reasons: [], checkedAt: 0 },
      gallery_entry_id: 'item-1', decided_at: 222,
    };
    let lookups = 0;
    const client = {
      from(table: string) {
        if (table === 'media_decisions') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => {
                  lookups++;
                  // pre-check: not decided yet; post-23505 lookup: winner visible
                  return { data: lookups === 1 ? null : winnerRow, error: null };
                },
              }),
            }),
            insert: async () => ({ error: { code: '23505', message: 'dup' } }),
          };
        }
        return db.client.from(table);
      },
    };
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any);

    const record = await handleReviewDecision(makeItem(), 'post');
    expect(record.id).toBe('winner');
    expect(db.gallery).toHaveLength(1); // loser completed the idempotent side effect
  });

  it('losing a 23505 race to a DIFFERENT decision throws FinalityViolationError', async () => {
    const db = makeFakeDb();
    const winnerRow = {
      id: 'winner', item_id: 'item-1', decision: 'remix', brand: 'misfit',
      lane: 'recombination', oracle_result: { passed: true, reasons: [], checkedAt: 0 },
      gallery_entry_id: null, decided_at: 222,
    };
    let lookups = 0;
    const client = {
      from(table: string) {
        if (table === 'media_decisions') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => {
                  lookups++;
                  return { data: lookups === 1 ? null : winnerRow, error: null };
                },
              }),
            }),
            insert: async () => ({ error: { code: '23505', message: 'dup' } }),
          };
        }
        return db.client.from(table);
      },
    };
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any);

    const err = await handleReviewDecision(makeItem(), 'post').catch((e) => e);
    expect(err).toBeInstanceOf(FinalityViolationError);
    expect(db.gallery).toHaveLength(0); // contradictory racer fires NO side effects
  });

  it('remix decision enqueues exactly one work order, replay is a no-op', async () => {
    const db = makeFakeDb();
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as any);

    await handleReviewDecision(makeItem(), 'remix');
    await handleReviewDecision(makeItem(), 'remix'); // idempotent replay
    expect(db.decisions).toHaveLength(1);
    expect(db.remix).toHaveLength(1);
  });
});
