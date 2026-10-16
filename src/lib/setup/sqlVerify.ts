// src/lib/setup/sqlVerify.ts
//
// The parts of the schema that a PostgREST-hosted app CANNOT see — trigger
// existence, unique indexes, RLS state — verified by copy-paste SQL plus a
// parsed paste-back.
//
// Why not just trust the app probes? Because the whole point of this project's
// posture is refuse-rather-than-err: if the append-only trigger is missing, the
// app cannot tell by looking (a BEFORE-ROW trigger on a zero-row statement
// never fires, and a per-row probe insert would pollute an append-only table
// FOREVER). So the app says "I cannot verify this from here, here is the exact
// query, paste the result back and I will read it" instead of showing a green
// check it did not earn.
//
// Both scripts below are safe to run on a live database:
//   SCHEMA_REPORT_SQL — pure reads (information_schema / pg_catalog).
//   TRIGGER_PROOF_SQL — a transaction that is ALWAYS rolled back; the row it
//     inserts can never persist, in either the pass or the fail branch.

export const SCHEMA_REPORT_SQL = `-- MEDIA ENGINE — schema report (READ ONLY). Nothing here writes.
-- Run in Supabase → SQL Editor → New query. Copy the whole JSON result and
-- paste it into the Setup page.
select json_build_object(
  'tables', (
    select coalesce(json_object_agg(tablename, true), '{}'::json)
    from pg_tables
    where schemaname = 'public'
      and tablename in ('gallery_assets','rotation_state','text_rotation_state',
                        'lane_rotation_state','review_queue','media_decisions',
                        'remix_queue','batch_runs')
  ),
  'columns', (
    select coalesce(json_object_agg(c.table_name || '.' || c.column_name, c.data_type), '{}'::json)
    from information_schema.columns c
    where c.table_schema = 'public'
      and ( (c.table_name = 'gallery_assets' and c.column_name in ('tags','permanent','for_sale','source'))
         or (c.table_name = 'batch_runs'     and c.column_name in ('status','brand','started_at'))
         or (c.table_name = 'review_queue'   and c.column_name in ('oracle_result','status')) )
  ),
  'unique_indexes', (
    select coalesce(json_object_agg(indexname, true), '{}'::json)
    from pg_indexes
    where schemaname = 'public'
      and indexname in ('idx_media_decisions_item_unique',
                        'idx_remix_queue_original_item_unique',
                        'idx_batch_runs_one_running_per_brand')
  ),
  'append_only_triggers', (
    select coalesce(json_agg(json_build_object('table', cl.relname, 'trigger', t.tgname) order by cl.relname), '[]'::json)
    from pg_trigger t
    join pg_class cl on cl.oid = t.tgrelid
    join pg_namespace n on n.oid = cl.relnamespace
    where n.nspname = 'public' and not t.tgisinternal
      and t.tgname in ('enforce_gallery_assets_append_only','enforce_media_decisions_append_only')
  ),
  'reject_mutation_function', exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'reject_mutation'
  ),
  'rls_enabled', (
    select coalesce(json_object_agg(cl.relname, cl.relrowsecurity), '{}'::json)
    from pg_class cl join pg_namespace n on n.oid = cl.relnamespace
    where n.nspname = 'public' and cl.relkind = 'r'
      and cl.relname in ('gallery_assets','media_decisions','review_queue',
                         'remix_queue','batch_runs','rotation_state')
  ),
  'generated_at', now()
) as report;`;

export const TRIGGER_PROOF_SQL = `-- MEDIA ENGINE — append-only proof. Writes are ROLLED BACK. Always.
-- Run the whole block. EXPECTED RESULT: an error saying
--   Table "gallery_assets" is append-only. UPDATE and DELETE are strictly prohibited.
-- That error IS the pass. Anything else means the trigger is missing.
-- Nothing persists: the transaction is rolled back on both paths.
begin;
insert into public.gallery_assets (id, url, brand, category, for_sale, source, added_at, permanent)
values ('__setup_probe__', 'https://example.invalid/probe.webp', 'shared', 'art', false, 'seed', 0, true);
delete from public.gallery_assets where id = '__setup_probe__';
rollback;`;

// ── Parsed report shape ───────────────────────────────────────────────────────

export interface SqlCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface SqlReport {
  ok: boolean;
  checks: SqlCheck[];
  error?: string;
  generatedAt?: string;
}

const REQUIRED_TABLES = [
  'gallery_assets',
  'rotation_state',
  'text_rotation_state',
  'lane_rotation_state',
  'review_queue',
  'media_decisions',
  'remix_queue',
] as const;

const REQUIRED_INDEXES = [
  'idx_media_decisions_item_unique',
  'idx_remix_queue_original_item_unique',
] as const;

const REQUIRED_TRIGGERS: Record<string, string> = {
  gallery_assets: 'enforce_gallery_assets_append_only',
  media_decisions: 'enforce_media_decisions_append_only',
};

function asObject(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * Parses the paste-back from SCHEMA_REPORT_SQL. Tolerant by design: the
 * Supabase SQL editor gives you JSON, and people paste it with or without
 * surrounding whitespace, quotes or a wrapper. We locate the outermost object
 * and parse that, and we say exactly what went wrong when we cannot.
 */
export function parseSchemaReport(raw: string): SqlReport {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return {
      ok: false,
      checks: [],
      error:
        'No JSON object found in what you pasted. Run SCHEMA_REPORT_SQL and copy the entire result cell (it starts with {"tables": ...).',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    return {
      ok: false,
      checks: [],
      error: `Could not parse the pasted result as JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const root = asObject(parsed);
  const report = asObject(root.report ?? root);

  if (!('tables' in report)) {
    return {
      ok: false,
      checks: [],
      error:
        'That JSON does not look like the schema report (no "tables" key). Re-run SCHEMA_REPORT_SQL — do not paste an image of the result, paste the text.',
    };
  }

  const tables = asObject(report.tables);
  const columns = asObject(report.columns);
  const indexes = asObject(report.unique_indexes);
  const triggers = Array.isArray(report.append_only_triggers)
    ? report.append_only_triggers
    : [];
  const rls = asObject(report.rls_enabled);

  const missingTables = REQUIRED_TABLES.filter((t) => tables[t] !== true);
  const batchRunsPresent = tables.batch_runs === true;

  const missingColumns = [
    'gallery_assets.tags',
    'gallery_assets.permanent',
    'review_queue.oracle_result',
    'batch_runs.status',
  ].filter((c) => columns[c] === undefined);

  const triggerPairs = triggers.map((t) => asObject(t));
  const missingTriggers = Object.entries(REQUIRED_TRIGGERS).filter(
    ([table, name]) =>
      !triggerPairs.some((t) => t.table === table && t.trigger === name),
  );

  const missingIndexes = REQUIRED_INDEXES.filter((i) => indexes[i] !== true);

  const rlsEnabled = Object.entries(rls)
    .filter(([, v]) => v === true)
    .map(([k]) => k);

  const checks: SqlCheck[] = [
    {
      id: 'sql.tables',
      label: 'All 7 core tables exist',
      ok: missingTables.length === 0,
      detail:
        missingTables.length === 0
          ? 'gallery_assets, rotation_state, text_rotation_state, lane_rotation_state, review_queue, media_decisions, remix_queue'
          : `MISSING: ${missingTables.join(', ')} → run supabase/schema.sql then migrations 002, 003`,
    },
    {
      id: 'sql.batch_runs',
      label: 'Migration 004 (batch single-flight) applied',
      ok: batchRunsPresent,
      detail: batchRunsPresent
        ? 'batch_runs present — overlapping batches are refused by the DB'
        : 'MISSING: batch_runs → run supabase/migrations/004_batch_runs.sql (overlapping batches can currently corrupt rotation state)',
    },
    {
      id: 'sql.columns',
      label: 'Additive columns from migrations 002/003 present',
      ok: missingColumns.length === 0,
      detail:
        missingColumns.length === 0
          ? 'tags, permanent, oracle_result, batch_runs.status all present'
          : `MISSING: ${missingColumns.join(', ')}`,
    },
    {
      id: 'sql.triggers',
      label: 'Append-only triggers attached (gallery + decisions)',
      ok: missingTriggers.length === 0,
      detail:
        missingTriggers.length === 0
          ? 'enforce_gallery_assets_append_only, enforce_media_decisions_append_only'
          : `MISSING: ${missingTriggers.map(([t2, n]) => `${n} on ${t2}`).join(', ')} → re-run supabase/schema.sql (trigger section)`,
    },
    {
      id: 'sql.indexes',
      label: 'Finality unique indexes present',
      ok: missingIndexes.length === 0,
      detail:
        missingIndexes.length === 0
          ? 'media_decisions(item_id) and remix_queue(original_item_id) are unique — one decision per item, ever'
          : `MISSING: ${missingIndexes.join(', ')} → re-run supabase/schema.sql`,
    },
    {
      id: 'sql.rls',
      label: 'RLS posture on engine tables',
      // Informational: the engine talks to Postgres with the service role,
      // which bypasses RLS. Not enabled is the expected state here.
      ok: true,
      detail:
        rlsEnabled.length === 0
          ? 'RLS off on all engine tables — fine while the service role is the only writer and no anon policy is granted'
          : `RLS ON for: ${rlsEnabled.join(', ')}. The service role bypasses RLS, but the browser anon key does not: verify no anon policy grants writes to these tables.`,
    },
  ];

  return {
    ok: checks.every((c) => c.ok),
    checks,
    ...(typeof report.generated_at === 'string' ? { generatedAt: report.generated_at } : {}),
  };
}
