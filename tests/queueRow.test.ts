// tests/queueRow.test.ts
//
// Pins the single row → ReviewItem mapper (src/lib/review/queueRow.ts).
//
// This mapping has regressed once already: merch_meta was never mapped, so the
// merch-source badge could never render (DEBUG-REPORT Bug 5). It was fixed in
// two places by hand because it was duplicated in two places. It is now one
// function, and these tests are the reason it stays one behaviour.

import { describe, it, expect } from 'vitest';
import { queueRowToReviewItem, merchMetaToFields } from '../src/lib/review/queueRow';

const baseRow = {
  id: 'item-1',
  brand: 'misfit',
  lane: 'fresh_text_card',
  image_url: 'https://storage.example.com/rendered/misfit/a.webp',
  source_data: { baseImageId: 'asset-9', text: 'Still here.' },
  oracle_result: { passed: true, reasons: [], checkedAt: 1000 },
  merch_meta: null,
  queued_at: 2000,
  status: 'pending',
};

describe('queueRowToReviewItem', () => {
  it('maps the base row fields', () => {
    const item = queueRowToReviewItem(baseRow);
    expect(item.id).toBe('item-1');
    expect(item.imageUrl).toBe(baseRow.image_url);
    expect(item.brand).toBe('misfit');
    expect(item.generationLane).toBe('fresh_text_card');
    expect(item.sourceData).toEqual({ baseImageId: 'asset-9', text: 'Still here.' });
    expect(item.createdAt).toBe(2000);
    expect(item.oracleResult.passed).toBe(true);
  });

  it('surfaces merch_meta.source as merchSource (the badge fix)', () => {
    const item = queueRowToReviewItem({
      ...baseRow,
      merch_meta: { source: 'catalog_search', detail: 'catalog product: pf-123' },
    });
    expect(item.merchSource).toBe('catalog_search');
    expect(item.sourceDetail).toBe('catalog product: pf-123');
  });

  it('omits the merch fields entirely when merch_meta is absent', () => {
    const item = queueRowToReviewItem(baseRow);
    expect('merchSource' in item).toBe(false);
    expect('sourceDetail' in item).toBe(false);
  });

  it('never fabricates a badge from a non-string source', () => {
    const fields = merchMetaToFields({ source: 42, detail: { nope: true } });
    expect(fields).toEqual({});
  });

  it('keeps a valid source even when detail is missing', () => {
    expect(merchMetaToFields({ source: 'gallery_reuse' })).toEqual({
      merchSource: 'gallery_reuse',
    });
  });

  it('defaults sourceData to an empty object rather than undefined', () => {
    const item = queueRowToReviewItem({ ...baseRow, source_data: null });
    expect(item.sourceData).toEqual({});
  });

  it('fails closed (passed:false) when oracle_result is missing', () => {
    const item = queueRowToReviewItem({ ...baseRow, oracle_result: null });
    expect(item.oracleResult.passed).toBe(false);
    expect(item.oracleResult.reasons).toContain('oracle_result_missing');
  });
});
