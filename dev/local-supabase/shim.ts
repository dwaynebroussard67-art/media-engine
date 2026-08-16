// dev/local-supabase/shim.ts
//
// LOCAL DEV SUPABASE SHIM — runs the whole Media Engine against a REAL
// PostgreSQL instance (PGlite, same query engine + PL/pgSQL semantics as
// Supabase Postgres) without cloud credentials.
//
// What it implements (only the surface the engine actually uses):
//   - PostgREST-style /rest/v1/<table> — SELECT (filters incl. jsonb `->>`),
//     INSERT (incl. 23505 → 409), UPDATE, upsert via on_conflict.
//   - /storage/v1/object/<bucket>/<path> — upload (upsert:false honored),
//     public download. getPublicUrl is computed client-side by supabase-js.
//   - /auth/v1/* — email OTP flow (DEMO: any email, code 123456),
//     GET /user, token refresh, logout.
//
// The schema + migrations (supabase/schema.sql, 001–003) are applied at
// startup, so every check constraint and append-only trigger the app relies
// on is ENFORCED for real — UPDATE/DELETE on gallery_assets /
// media_decisions will actually fail.
//
// Usage:
//   1. npm run shim                              (listens on 127.0.0.1:54321)
//   2. npm run shim -- --seed-demo               (also seeds demo imagery)
//   3. Point the app at it:
//        SUPABASE_URL=http://127.0.0.1:54321
//        SUPABASE_SERVICE_ROLE_KEY=local-shim
//        SUPABASE_ANON_KEY=local-shim
//        NEXT_PUBLIC_SUPABASE_URL=/supabase          (browser, via rewrites)
//        NEXT_PUBLIC_SUPABASE_ANON_KEY=local-shim
//        NEXT_PUBLIC_MEDIA_HOST_REWRITE=http://127.0.0.1:54321
//        LOCAL_SUPABASE_SHIM_URL=http://127.0.0.1:54321   (build-time)
//
// NEVER deploy this shim anywhere. It authenticates nothing (any token is
// the demo user). It exists to exercise the pipeline offline.

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { PGlite } from '@electric-sql/pglite';
import sharp from 'sharp';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Cli {
  port: number;
  host: string;
  seedDemo: boolean;
  publicBase: string;
  storageDir: string;
  dbFile: string | null;
}

function parseCli(argv: string[]): Cli {
  const cli: Cli = {
    port: 54321,
    host: '127.0.0.1',
    seedDemo: false,
    publicBase: 'http://127.0.0.1:54321',
    storageDir: path.join(process.cwd(), '.local-supabase', 'storage'),
    dbFile: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--port' && next) cli.port = Number(next);
    if (arg === '--host' && next) cli.host = next;
    if (arg === '--public-base' && next) cli.publicBase = next;
    if (arg === '--storage-dir' && next) cli.storageDir = next;
    if (arg === '--db' && next) cli.dbFile = next;
    if (arg === '--seed-demo') cli.seedDemo = true;
  }
  return cli;
}

// ---------------------------------------------------------------------------
// JSON / response helpers
// ---------------------------------------------------------------------------

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(payload);
}

function sendEmpty(res: http.ServerResponse, status: number): void {
  res.writeHead(status);
  res.end();
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// PostgREST-ish filter translation (safe: identifiers are validated)
// ---------------------------------------------------------------------------

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const JSON_ARROW = /^([a-zA-Z_][a-zA-Z0-9_]*)->>([a-zA-Z_][a-zA-Z0-9_]*)$/;

interface ParsedFilter {
  sql: string;
  params: unknown[];
}

function parseFilters(search: URLSearchParams, skipKeys: Set<string>): ParsedFilter {
  const clauses: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of search.entries()) {
    if (skipKeys.has(key)) continue;
    // Format: <col>=eq.<value> (the only operator this engine uses)
    const eq = value.startsWith('eq.') ? value.slice(3) : null;
    if (eq === null) continue;

    const arrow = key.match(JSON_ARROW);
    if (arrow) {
      params.push(eq);
      clauses.push(`${arrow[1]}->>'${arrow[2]}' = $${params.length}`);
      continue;
    }
    if (!IDENT.test(key)) continue; // reject anything surprising
    params.push(eq);
    clauses.push(`${key} = $${params.length}`);
  }
  return { sql: clauses.length ? `where ${clauses.join(' and ')}` : '', params };
}

// ---------------------------------------------------------------------------
// Demo seed imagery (sharp) — abstract branded bases for the lanes
// ---------------------------------------------------------------------------

async function makeDemoImage(opts: {
  from: string;
  to: string;
  shapes: string;
}): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${opts.from}"/>
      <stop offset="100%" stop-color="${opts.to}"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="1080" fill="url(#g)"/>
  ${opts.shapes}
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

interface DemoSeedRow {
  file: string;
  id: string;
  brand: string;
  category: string;
  tags: string[];
  image: Buffer;
  url: string;
}

async function buildDemoSeeds(publicBase: string): Promise<DemoSeedRow[]> {
  const mk = (id: string, brand: string, category: string, tags: string[], image: Buffer) => ({
    file: `gallery/${brand}/${id}.png`,
    id,
    brand,
    category,
    tags,
    image,
  });

  const circ = (cx: number, cy: number, r: number, fill: string, opacity: number) =>
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" opacity="${opacity}"/>`;
  const line = (x1: number, y1: number, x2: number, y2: number, color: string, w: number) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${w}"/>`;

  return [
    mk(
      'demo-misfit-atm-1', 'misfit', 'atmosphere', [],
      await makeDemoImage({
        from: '#0b1026', to: '#2b1b3d',
        shapes: `${circ(540, 540, 380, '#3d2b5c', 0.55)}${circ(240, 300, 120, '#1c2340', 0.8)}`,
      })
    ),
    mk(
      'demo-misfit-atm-2', 'misfit', 'atmosphere', [],
      await makeDemoImage({
        from: '#101820', to: '#274046',
        shapes: `${line(0, 700, 1080, 380, '#35575e', 90)}${line(0, 860, 1080, 540, '#1d3138', 60)}`,
      })
    ),
    mk(
      'demo-misfit-art-1', 'misfit', 'art', ['misfit', 'tee'],
      await makeDemoImage({
        from: '#140d0d', to: '#3d1515',
        shapes: `${line(540, 120, 540, 960, '#7a2e2e', 26)}${line(180, 540, 900, 540, '#7a2e2e', 26)}${circ(540, 540, 300, '#000000', 0.25)}`,
      })
    ),
    mk(
      'demo-forge-atm-1', 'forge', 'atmosphere', [],
      await makeDemoImage({
        from: '#1d1508', to: '#4a3410',
        shapes: `${circ(820, 240, 200, '#6b4c16', 0.6)}${line(0, 400, 1080, 400, '#2c220b', 40)}`,
      })
    ),
    mk(
      'demo-forge-art-1', 'forge', 'art', ['forge', 'hoodie'],
      await makeDemoImage({
        from: '#101010', to: '#2e2e2e',
        shapes: `${line(120, 240, 960, 240, '#555', 10)}${line(120, 480, 960, 480, '#555', 10)}${line(120, 720, 960, 720, '#555', 10)}${line(120, 960, 960, 960, '#555', 10)}`,
      })
    ),
    mk(
      'demo-shared-atm-1', 'shared', 'atmosphere', [],
      await makeDemoImage({
        from: '#1a1a1a', to: '#3f3f3f',
        shapes: `${circ(540, 540, 420, '#000000', 0.3)}${circ(540, 540, 260, '#4a4a4a', 0.4)}`,
      })
    ),
  ].map((r): DemoSeedRow => ({
    ...r,
    url: `${publicBase}/storage/v1/object/public/media-engine/${r.file}`,
  }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  fs.mkdirSync(cli.storageDir, { recursive: true });

  const db = cli.dbFile ? new PGlite(cli.dbFile) : new PGlite();
  const sqlDir = path.join(__dirname, '..', '..', 'supabase');
  await db.exec(fs.readFileSync(path.join(sqlDir, 'schema.sql'), 'utf-8'));
  await db.exec(fs.readFileSync(path.join(sqlDir, 'migrations', '001_initial.sql'), 'utf-8'));
  await db.exec(fs.readFileSync(path.join(sqlDir, 'migrations', '002_tags.sql'), 'utf-8'));
  await db.exec(fs.readFileSync(path.join(sqlDir, 'migrations', '003_lane_rotation.sql'), 'utf-8'));

  // ── Demo seeds ────────────────────────────────────────────────────────────
  if (cli.seedDemo) {
    const seeds = await buildDemoSeeds(cli.publicBase);
    for (const s of seeds) {
      // Object keys live under the bucket directory, mirroring the shim's
      // storage layout: <storageDir>/<bucket>/<objectKey>.
      const abs = path.join(cli.storageDir, 'media-engine', s.file);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, s.image);
      await db.query(
        `insert into gallery_assets
           (id, url, brand, category, for_sale, source, added_at, permanent, tags)
         values ($1, $2, $3, $4, false, 'seed', $5, true, $6)`,
        [s.id, s.url, s.brand, s.category, Date.now(), s.tags],
      );
      console.log(`[shim] seeded ${s.brand}/${s.category}: ${s.id}`);
    }
  }

  // ── REST: map filters over the live tables ───────────────────────────────
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = req.method ?? 'GET';

    const log = (status: number, note = '') =>
      console.log(`[shim] ${method} ${url.pathname}${url.search} → ${status} ${note}`);

    // ── /auth/v1 ────────────────────────────────────────────────────────────
    if (url.pathname.startsWith('/auth/v1/')) {
      if (url.pathname === '/auth/v1/otp' && method === 'POST') {
        // DEMO: accept any email; the code is always 123456.
        const body = JSON.parse((await readBody(req)).toString() || '{}') as { email?: string };
        console.log(`[shim] OTP requested for ${body.email ?? '?'} — DEMO CODE: 123456`);
        sendJson(res, 200, {});
        log(200, 'otp');
        return;
      }
      if (url.pathname === '/auth/v1/verify' && method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString() || '{}') as {
          email?: string;
          token?: string;
        };
        if (body.token !== '123456') {
          sendJson(res, 400, { error: 'invalid_grant', error_description: 'Invalid OTP (demo code is 123456)' });
          log(400, 'bad otp');
          return;
        }
        const now = Math.floor(Date.now() / 1000);
        sendJson(res, 200, {
          access_token: 'demo-token',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: now + 3600,
          refresh_token: 'demo-refresh',
          user: {
            id: 'demo-user',
            email: body.email ?? 'demo@misfit.local',
            role: 'authenticated',
            aud: 'authenticated',
            app_metadata: {},
            user_metadata: {},
          },
        });
        log(200, 'verified');
        return;
      }
      if (url.pathname === '/auth/v1/user' && method === 'GET') {
        // Accept only the token issued by the demo OTP flow, so auth paths
        // behave honestly: a garbage bearer → 401 → app returns 401.
        const auth = req.headers.authorization ?? '';
        if (auth !== 'Bearer demo-token') {
          sendJson(res, 401, { message: 'invalid JWT: the demo token is demo-token' });
          log(401, 'bad token');
          return;
        }
        sendJson(res, 200, {
          id: 'demo-user',
          email: 'demo@misfit.local',
          role: 'authenticated',
          aud: 'authenticated',
          app_metadata: {},
          user_metadata: {},
        });
        log(200);
        return;
      }
      if (url.pathname === '/auth/v1/token' && method === 'POST') {
        const now = Math.floor(Date.now() / 1000);
        sendJson(res, 200, {
          access_token: 'demo-token',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: now + 3600,
          refresh_token: 'demo-refresh',
          user: { id: 'demo-user', email: 'demo@misfit.local', role: 'authenticated', aud: 'authenticated' },
        });
        log(200, 'refresh');
        return;
      }
      if (url.pathname === '/auth/v1/logout' && method === 'POST') {
        sendEmpty(res, 204);
        log(204);
        return;
      }
      if (url.pathname === '/auth/v1/settings') {
        sendJson(res, 200, {});
        log(200);
        return;
      }
      sendJson(res, 404, { error: 'not_found' });
      log(404);
      return;
    }

    // ── /rest/v1/<table> ────────────────────────────────────────────────────
    if (url.pathname.startsWith('/rest/v1/')) {
      const table = url.pathname.slice('/rest/v1/'.length);
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
        sendJson(res, 400, { message: `invalid table "${table}"` });
        log(400);
        return;
      }
      const skipKeys = new Set(['select', 'order', 'on_conflict', 'offset', 'limit']);
      const filter = parseFilters(url.searchParams, skipKeys);
      const select = url.searchParams.get('select') ?? '*';
      const orderParam = url.searchParams.get('order');
      let orderSql = '';
      if (orderParam && /^[a-zA-Z_][a-zA-Z0-9_]*(\.(asc|desc))?$/.test(orderParam)) {
        const [col, dir] = orderParam.split('.');
        orderSql = ` order by ${col} ${dir === 'desc' ? 'desc' : 'asc'}`;
      }

      try {
        if (method === 'GET') {
          const countRow = (
            await db.query(`select count(*) as n from ${table} ${filter.sql}`, filter.params)
          ).rows[0] as { n: number | bigint };
          const total = Number(countRow.n);
          const rows = (
            await db.query(`select ${select} from ${table} ${filter.sql}${orderSql}`, filter.params)
          ).rows;

          let body: unknown = rows;
          let headers: Record<string, string> = {};
          const wantsCount = (req.headers.prefer ?? '').includes('count=exact');

          // supabase-js v2 expresses .range() as offset/limit query params;
          // a Range header is honored as a fallback.
          const offset = Number(url.searchParams.get('offset') ?? 0);
          const limitParam = url.searchParams.get('limit');
          const rangeHeader = req.headers.range ?? '';
          let sliceFrom = 0;
          let sliceTo = rows.length - 1;
          if (limitParam !== null) {
            sliceFrom = offset;
            sliceTo = offset + Number(limitParam) - 1;
          } else {
            const m = rangeHeader.match(/^(\d+)-(\d+)$/);
            if (m) {
              sliceFrom = Number(m[1]);
              sliceTo = Number(m[2]);
            }
          }
          body = rows.slice(sliceFrom, sliceTo + 1);
          if (wantsCount) {
            const last = Math.min(sliceTo, total - 1);
            headers['content-range'] = total > 0 ? `${sliceFrom}-${last}/${total}` : '*/0';
          }
          if ((req.headers.accept ?? '').includes('object+json')) {
            if (rows.length === 0) {
              sendJson(res, 406, {
                code: 'PGRST116',
                message: 'JSON object requested, multiple (or no) rows returned',
              });
              log(406, 'maybeSingle empty');
              return;
            }
            body = rows[0];
          }
          sendJson(res, 200, body, headers);
          log(200);
          return;
        }

        if (method === 'POST') {
          const raw = JSON.parse((await readBody(req)).toString() || '[]');
          const rows = (Array.isArray(raw) ? raw : [raw]) as Array<Record<string, unknown>>;
          const onConflict = url.searchParams.get('on_conflict');
          const inserted: unknown[] = [];
          for (const row of rows) {
            const cols = Object.keys(row).filter((c) => IDENT.test(c));
            const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
            let sql = `insert into ${table} (${cols.join(', ')}) values (${placeholders})`;
            if (onConflict && IDENT.test(onConflict)) {
              const updates = cols
                .filter((c) => c !== onConflict)
                .map((c) => `${c} = excluded.${c}`)
                .join(', ');
              sql += ` on conflict (${onConflict}) do update set ${updates}`;
            }
            sql += ' returning *';
            try {
              const result = await db.query(sql, cols.map((c) => row[c]));
              inserted.push(result.rows[0]);
            } catch (err) {
              const e = err as { code?: string; message?: string };
              if (e.code === '23505') {
                sendJson(res, 409, { code: '23505', message: e.message ?? 'duplicate key' });
                log(409, 'unique violation');
                return;
              }
              sendJson(res, 400, { code: e.code, message: e.message });
              log(400, String(e.message ?? '').slice(0, 80));
              return;
            }
          }
          sendJson(res, 201, inserted.length === 1 ? inserted[0] : inserted);
          log(201);
          return;
        }

        if (method === 'PATCH') {
          const raw = JSON.parse((await readBody(req)).toString() || '{}') as Record<string, unknown>;
          const cols = Object.keys(raw).filter((c) => IDENT.test(c));
          if (cols.length === 0) {
            sendEmpty(res, 204);
            log(204, 'no-op patch');
            return;
          }
          const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
          const params: unknown[] = cols.map((c) => raw[c]);
          const { sql, params: filterParams } = filter;
          const offset = params.length;
          const renumbered = sql.replace(/\$(\d+)/g, (_m, n) => `$${Number(n) + offset}`);
          try {
            await db.query(`update ${table} set ${sets} ${renumbered}`, [...params, ...filterParams]);
          } catch (err) {
            const e = err as { code?: string; message?: string };
            sendJson(res, 400, { code: e.code, message: e.message });
            log(400, String(e.message ?? '').slice(0, 80));
            return;
          }
          sendEmpty(res, 204);
          log(204);
          return;
        }

        sendJson(res, 405, { message: `method ${method} not allowed` });
        log(405);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(res, 500, { message });
        log(500, message.slice(0, 80));
        return;
      }
    }

    // ── /storage/v1/object/... ──────────────────────────────────────────────
    if (url.pathname.startsWith('/storage/v1/object/')) {
      const rest = url.pathname.slice('/storage/v1/object/'.length);
      const segments = rest.split('/').filter(Boolean);
      // getPublicUrl produces /object/public/<bucket>/<path> — 'public' is a
      // visibility marker, not part of the storage key.
      const [bucket, ...pathParts] =
        segments[0] === 'public' ? segments.slice(1) : segments;
      if (!bucket || pathParts.length === 0) {
        sendJson(res, 400, { message: 'missing bucket or path' });
        log(400);
        return;
      }
      const relPath = path.join(bucket, ...pathParts);
      const abs = path.join(cli.storageDir, relPath);
      if (!abs.startsWith(cli.storageDir)) {
        sendJson(res, 400, { message: 'invalid path' });
        log(400);
        return;
      }

      if (method === 'POST') {
        const body = await readBody(req);
        if (fs.existsSync(abs)) {
          sendJson(res, 409, {
            statusCode: '409',
            error: 'Duplicate',
            message: 'The resource already exists',
          });
          log(409, 'duplicate object');
          return;
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, body);
        sendJson(res, 200, { Key: `${bucket}/${relPath}` });
        log(200);
        return;
      }

      if (method === 'GET') {
        if (!fs.existsSync(abs)) {
          sendJson(res, 404, { statusCode: '404', error: 'not_found', message: 'Object not found' });
          log(404);
          return;
        }
        const ext = path.extname(abs).slice(1).toLowerCase();
        const mime =
          ext === 'png' ? 'image/png' :
          ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
          ext === 'webp' ? 'image/webp' : 'application/octet-stream';
        res.writeHead(200, { 'content-type': mime });
        res.end(fs.readFileSync(abs));
        return; // intentionally not logged (image noise)
      }

      sendJson(res, 405, { message: `method ${method} not allowed` });
      log(405);
      return;
    }

    sendJson(res, 404, { message: `no shim route for ${url.pathname}` });
    log(404);
  });

  server.listen(cli.port, cli.host, () => {
    console.log(`[shim] local Supabase shim listening on http://${cli.host}:${cli.port}`);
    console.log(`[shim] storage dir: ${cli.storageDir}`);
    console.log(`[shim] DEMO OTP code: 123456 (any email)`);
  });
}

main().catch((err) => {
  console.error('[shim] crashed:', err);
  process.exit(1);
});
