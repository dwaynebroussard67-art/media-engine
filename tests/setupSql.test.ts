// tests/setupSql.test.ts
//
// Tests for the SQL copy-paste verification path (src/lib/setup/sqlVerify.ts).
//
// Why this file exists in a repo that already has 64 tests: the setup UI shows
// green ticks derived from a blob a human pasted back. That is the one place in
// this system where a wrong parse could tell D his append-only triggers are
// fine when they are not. So the parser is pinned here — including the failure
// directions (garbage in → explicit error, never a silent pass).

import { describe, it, expect } from 'vitest';
import {
  SCHEMA_REPORT_SQL,
  TRIGGER_PROOF_SQL,
  parseSchemaReport,
} from '../src/lib/setup/sqlVerify';

function goodReport() {
  return {
    tables: {
      gallery_assets: true,
      rotation_state: true,
      text_rotation_state: true,
      lane_rotation_state: true,
      review_queue: true,
      media_decisions: true,
      remix_queue: true,
      batch_runs: true,
    },
    columns: {
      'gallery_assets.tags': 'ARRAY',
      'gallery_assets.permanent': 'boolean',
      'review_queue.oracle_result': 'jsonb',
      'batch_runs.status': 'text',
    },
    unique_indexes: {
      idx_media_decisions_item_unique: true,
      idx_remix_queue_original_item_unique: true,
      idx_batch_runs_one_running_per_brand: true,
    },
    append_only_triggers: [
      { table: 'gallery_assets', trigger: 'enforce_gallery_assets_append_only' },
      { table: 'media_decisions', trigger: 'enforce_media_decisions_append_only' },
    ],
    reject_mutation_function: true,
    rls_enabled: {
      gallery_assets: false,
      media_decisions: false,
      review_queue: false,
      remix_queue: false,
      batch_runs: false,
      rotation_state: false,
    },
    generated_at: '2026-10-15T00:00:00Z',
  };
}

describe('parseSchemaReport', () => {
  it('passes when everything is present', () => {
    const report = parseSchemaReport(JSON.stringify(goodReport()));
    expect(report.error).toBeUndefined();
    expect(report.ok).toBe(true);
    expect(report.checks.every((c) => c.ok)).toBe(true);
    expect(report.generatedAt).toBe('2026-10-15T00:00:00Z');
  });

  it('fails the batch-run check when migration 004 has not been applied', () => {
    const raw = goodReport();
    delete (raw.tables as Record<string, unknown>).batch_runs;
    delete (raw.unique_indexes as Record<string, unknown>).idx_batch_runs_one_running_per_brand;

    const report = parseSchemaReport(JSON.stringify(raw));
    expect(report.ok).toBe(false);

    const check = report.checks.find((c) => c.id === 'sql.batch_runs');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('004_batch_runs.sql');
  });

  it('fails the trigger check when an append-only trigger is missing', () => {
    const raw = goodReport();
    raw.append_only_triggers = [
      { table: 'gallery_assets', trigger: 'enforce_gallery_assets_append_only' },
    ];

    const report = parseSchemaReport(JSON.stringify(raw));
    const check = report.checks.find((c) => c.id === 'sql.triggers');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('enforce_media_decisions_append_only');
    expect(report.ok).toBe(false);
  });

  it('fails when a finality unique index is missing', () => {
    const raw = goodReport();
    delete (raw.unique_indexes as Record<string, unknown>).idx_media_decisions_item_unique;

    const check = parseSchemaReport(JSON.stringify(raw)).checks.find(
      (c) => c.id === 'sql.indexes',
    );
    expect(check?.ok).toBe(false);
  });

  it('reports RLS presence without failing the run (service role bypasses it)', () => {
    const raw = goodReport();
    raw.rls_enabled = { gallery_assets: true } as never;

    const report = parseSchemaReport(JSON.stringify(raw));
    const rls = report.checks.find((c) => c.id === 'sql.rls');
    expect(rls?.ok).toBe(true);
    expect(rls?.detail).toContain('gallery_assets');
  });

  it('accepts the report wrapped in a { report: ... } envelope (Supabase row shape)', () => {
    const report = parseSchemaReport(JSON.stringify({ report: goodReport() }));
    expect(report.ok).toBe(true);
  });

  it('accepts surrounding noise around the JSON object', () => {
    const report = parseSchemaReport(`  Success. Rows: 1\n${JSON.stringify(goodReport())}\n`);
    expect(report.ok).toBe(true);
  });

  it('returns an explicit error for non-JSON (never a silent pass)', () => {
    const report = parseSchemaReport('I ran the query and it worked, trust me');
    expect(report.ok).toBe(false);
    expect(report.checks).toEqual([]);
    expect(report.error).toContain('No JSON object found');
  });

  it('returns an explicit error for JSON that is not the schema report', () => {
    const report = parseSchemaReport('{"unrelated": 1}');
    expect(report.ok).toBe(false);
    expect(report.error).toContain('no "tables" key');
  });

  it('never marks a required table present on a partial report', () => {
    const report = parseSchemaReport(JSON.stringify({ tables: { gallery_assets: true } }));
    const check = report.checks.find((c) => c.id === 'sql.tables');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('media_decisions');
  });
});

describe('SQL scripts are safe to run on a live database', () => {
  it('the schema report is read-only', () => {
    const sql = SCHEMA_REPORT_SQL.toLowerCase();
    for (const forbidden of ['insert ', 'update ', 'delete ', 'drop ', 'alter ', 'truncate ', 'grant ']) {
      expect(sql).not.toContain(forbidden);
    }
    expect(sql).toContain('pg_trigger');
  });

  it('the append-only proof is a transaction that always rolls back', () => {
    const sql = TRIGGER_PROOF_SQL.toLowerCase();
    expect(sql).toContain('begin;');
    expect(sql).toContain('rollback;');
    // The only writes are the probe insert and the delete that must be blocked.
    expect(sql).toContain("insert into public.gallery_assets");
    expect(sql).toContain('delete from public.gallery_assets');
    expect(sql).not.toContain('commit;');
    // Nothing may touch the decision log.
    expect(sql).not.toContain('media_decisions');
  });
});
