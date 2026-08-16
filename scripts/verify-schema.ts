// scripts/verify-schema.ts
// Stage 3 go-live check, item 1: verify the SQL layer for real.
//
// Runs supabase/schema.sql + migrations 001–003 against a REAL PostgreSQL
// instance (PGlite — PostgreSQL compiled to WASM, same query engine and
// PL/pgSQL semantics as Supabase Postgres) and asserts the invariants the
// application layer depends on:
//
//   - gallery_assets and media_decisions are append-only (trigger blocks
//     UPDATE/DELETE at the DB level — defense in depth).
//   - media_decisions.item_id UNIQUE index arbitrates finality.
//   - remix_queue.original_item_id UNIQUE index makes enqueue idempotent.
//   - the review GET jsonb filter `oracle_result->>passed = 'true'` actually
//     excludes oracle-failed rows (this is what PostgREST generates from
//     `.eq('oracle_result->>passed', 'true')`).
//   - check constraints (url scheme, brand/category enums, permanent=true).
//   - rotation-state tables accept the upserts the lane code performs.
//
// Usage: npm run verify:schema
// Not a unit test — needs no Supabase credentials. PGlite runs in-process.

import { PGlite } from '@electric-sql/pglite';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');

function readSql(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

let checks = 0;
function check(label: string, cond: boolean): void {
  checks++;
  if (!cond) {
    console.error(`✗ FAIL: ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${label}`);
  }
}

async function expectError(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    check(label, false);
  } catch (err) {
    const code = (err as { code?: string }).code ?? '';
    const msg = err instanceof Error ? err.message : String(err);
    check(`${label} [${code}] ${msg.split('\n')[0].slice(0, 100)}`, true);
  }
}

async function main(): Promise<void> {
  const db = new PGlite();
  const version = (
    (await db.query('show server_version;')).rows[0] as { server_version: string }
  ).server_version;
  console.log(`Verifying SQL layer against PostgreSQL ${version}\n`);

  // ── 1. Apply schema + migrations (migration 001 is a comments-only
  //      tracking artifact by design — applying it is a harmless no-op). ──
  await db.exec(readSql('supabase/schema.sql'));
  await db.exec(readSql('supabase/migrations/001_initial.sql'));
  await db.exec(readSql('supabase/migrations/002_tags.sql'));
  await db.exec(readSql('supabase/migrations/003_lane_rotation.sql'));

  const tables = (
    await db.query(
      `select tablename from pg_tables where schemaname = 'public' order by tablename`,
    )
  ).rows.map((r) => (r as { tablename: string }).tablename);
  for (const t of [
    'gallery_assets',
    'rotation_state',
    'text_rotation_state',
    'lane_rotation_state',
    'review_queue',
    'media_decisions',
    'remix_queue',
  ]) {
    check(`table exists: ${t}`, tables.includes(t));
  }

  // ── 2. gallery_assets invariants ──────────────────────────────────────────
  await db.exec(`
    insert into gallery_assets (id, url, brand, category, for_sale, source, added_at)
    values ('a1', 'https://example.com/a.png', 'misfit', 'art', false, 'seed', 1);
  `);
  await expectError('gallery_assets UPDATE is blocked by reject_mutation trigger', () =>
    db.exec(`update gallery_assets set url = 'https://example.com/b.png' where id = 'a1'`)
  );
  await expectError('gallery_assets DELETE is blocked by reject_mutation trigger', () =>
    db.exec(`delete from gallery_assets where id = 'a1'`)
  );
  await expectError('gallery_assets url check rejects non-http URL', () =>
    db.exec(`
      insert into gallery_assets (id, url, brand, category, source, added_at)
      values ('a2', 'ftp://bad', 'misfit', 'art', 'seed', 2)
    `)
  );
  await expectError('gallery_assets brand check rejects unknown brand', () =>
    db.exec(`
      insert into gallery_assets (id, url, brand, category, source, added_at)
      values ('a3', 'https://example.com/c.png', 'other', 'art', 'seed', 3)
    `)
  );
  await expectError('gallery_assets permanent check rejects permanent=false', () =>
    db.exec(`
      insert into gallery_assets (id, url, brand, category, source, added_at, permanent)
      values ('a4', 'https://example.com/d.png', 'misfit', 'art', 'seed', 4, false)
    `)
  );
  // tags column added by migration 002, GIN indexed
  const tagsIndex = await db.query(
    `select 1 from pg_indexes where tablename = 'gallery_assets' and indexname = 'idx_gallery_assets_tags'`,
  );
  check('migration 002 added GIN index on gallery_assets.tags', tagsIndex.rows.length === 1);

  // ── 3. rotation state upserts (as lane code performs them) ────────────────
  await db.exec(`
    insert into rotation_state (brand, last_used_asset_id, last_used_index, updated_at)
    values ('misfit', 'a1', 0, 10)
    on conflict (brand) do update set
      last_used_asset_id = excluded.last_used_asset_id,
      last_used_index = excluded.last_used_index,
      updated_at = excluded.updated_at;
  `);
  const rot = (await db.query(`select * from rotation_state where brand = 'misfit'`)).rows[0];
  check('rotation_state upsert works (recombination lane)', (rot as { last_used_index: number }).last_used_index === 0);

  await db.exec(`
    insert into lane_rotation_state (scope, last_used_index, updated_at)
    values ('fresh_text_card:misfit', 2, 20)
    on conflict (scope) do update set
      last_used_index = excluded.last_used_index,
      updated_at = excluded.updated_at;
  `);
  const lane = (await db.query(`select * from lane_rotation_state where scope = 'fresh_text_card:misfit'`)).rows[0];
  check('lane_rotation_state upsert works (fresh text lane)', (lane as { last_used_index: number }).last_used_index === 2);

  await db.exec(`
    insert into text_rotation_state (brand, last_used_index, updated_at)
    values ('misfit', 4, 30)
    on conflict (brand) do update set
      last_used_index = excluded.last_used_index,
      updated_at = excluded.updated_at;
  `);
  const textRot = (await db.query(`select * from text_rotation_state where brand = 'misfit'`)).rows[0];
  check('text_rotation_state upsert works (text bank)', (textRot as { last_used_index: number }).last_used_index === 4);

  // ── 4. review_queue + the exact jsonb filter used by GET /api/review ─────
  await db.exec(`
    insert into review_queue
      (id, batch_id, brand, lane, image_url, source_data, oracle_result, queued_at, status)
    values
      ('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
       'misfit', 'fresh_text_card', 'https://example.com/q1.png',
       '{}'::jsonb, '{"passed": true, "reasons": [], "checkedAt": 1}'::jsonb, 100, 'pending'),
      ('00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
       'misfit', 'recombination', 'https://example.com/q2.png',
       '{}'::jsonb, '{"passed": false, "reasons": ["forbidden_keyword_violation:grind"], "checkedAt": 2}'::jsonb, 200, 'pending');
  `);

  // This is exactly the predicate PostgREST generates for
  //   .eq('oracle_result->>passed', 'true')
  const passed = await db.query(
    `select id from review_queue where brand = 'misfit' and status = 'pending'
       and oracle_result->>'passed' = 'true' order by queued_at asc`,
  );
  check(
    'jsonb filter oracle_result->>passed = \'true\' returns only oracle-passed rows',
    passed.rows.length === 1 &&
      (passed.rows[0] as { id: string }).id === '00000000-0000-4000-8000-000000000001'
  );

  const newestFirst = await db.query(
    `select id from review_queue where brand = 'misfit' and status = 'pending' order by queued_at asc limit 1`,
  );
  check(
    'oldest-first pagination order works (queued_at asc)',
    (newestFirst.rows[0] as { id: string }).id === '00000000-0000-4000-8000-000000000001'
  );

  // ── 5. media_decisions finality ───────────────────────────────────────────
  await db.exec(`
    insert into media_decisions (id, item_id, decision, brand, lane, oracle_result, gallery_entry_id, decided_at)
    values ('20000000-0000-4000-8000-000000000001', 'item-1', 'post', 'misfit',
            'recombination', '{"passed": true, "reasons": [], "checkedAt": 1}'::jsonb, 'item-1', 1);
  `);
  await expectError(
    'media_decisions UNIQUE(item_id) blocks a second decision for the same item (23505)',
    () =>
      db.exec(`
        insert into media_decisions (id, item_id, decision, brand, lane, oracle_result, decided_at)
        values ('20000000-0000-4000-8000-000000000002', 'item-1', 'reject', 'misfit',
                'recombination', '{"passed": true, "reasons": [], "checkedAt": 2}'::jsonb, 2)
      `)
  );
  await expectError('media_decisions UPDATE is blocked by reject_mutation trigger', () =>
    db.exec(`update media_decisions set decision = 'reject' where item_id = 'item-1'`)
  );
  await expectError('media_decisions DELETE is blocked by reject_mutation trigger', () =>
    db.exec(`delete from media_decisions where item_id = 'item-1'`)
  );

  // ── 6. remix_queue idempotency ────────────────────────────────────────────
  await db.exec(`
    insert into remix_queue (original_item_id, brand, lane, queued_at, reason)
    values ('item-9', 'misfit', 'recombination', 9, 'operator remix decision');
  `);
  await expectError('remix_queue UNIQUE(original_item_id) makes re-enqueue idempotent (23505)', () =>
    db.exec(`
      insert into remix_queue (original_item_id, brand, lane, queued_at, reason)
      values ('item-9', 'misfit', 'recombination', 10, 'operator remix decision')
    `)
  );

  // ── 7. Storage path is plain text (no DB constraint), but batch_id and
  //      uuid id columns accept the randomUUID() values the app inserts. ──
  const batch = await db.query(`select count(*) as n from review_queue where batch_id = '10000000-0000-4000-8000-000000000001'`);
  check('uuid columns accept app-generated randomUUID() values', Number((batch.rows[0] as { n: number | bigint }).n) === 2);

  console.log(`\n${checks} checks run.`);
  if (process.exitCode) {
    console.error('SCHEMA VERIFICATION FAILED');
    process.exit(1);
  }
  console.log('SCHEMA VERIFICATION PASSED');
}

main().catch((err) => {
  console.error('verify-schema crashed:', err);
  process.exit(1);
});
