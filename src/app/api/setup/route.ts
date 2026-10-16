// src/app/api/setup/route.ts
//
// POST /api/setup — the interactive setup/verification backend.
//
// Auth model (deliberate, and the reason day-one setup is possible at all):
//   - `whoami` accepts ANY valid Supabase JWT and returns only the caller's
//     own id/email plus whether that id is in GALLERY_WRITER_IDS. Without this
//     escape hatch, the allowlist gate would lock D out of the one screen that
//     tells him the value he must put in the allowlist. It reads nothing else.
//   - Every other action requires a JWT that IS in the writer allowlist
//     (same rule as /api/gallery POST and /api/review/[id] POST — empty list
//     means nobody, fails closed).
//
// Nothing here returns a secret value. Config is reported as presence booleans
// only (same posture as /api/status).
//
// Runtime: nodejs — smoke-render and bootstrap-backdrop use sharp.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { verifyUserJwt } from '../../../lib/supabaseClient';
import { probeDatabase, probeStorage, probePrintify, probeBaseAssets } from '../../../lib/setup/probes';
import { bootstrapBackdrop, verifyDecisionIntegrity } from '../../../lib/setup/actions';
import { renderSmokeCard } from '../../../lib/render/smokeRender';
import { listRecentRuns, forceReleaseRun } from '../../../lib/batch/batchLock';
import type { Brand } from '../../../types/media';

const VALID_BRANDS: ReadonlySet<string> = new Set(['misfit', 'forge']);

const ACTIONS = [
  'whoami',
  'probe-db',
  'probe-storage',
  'probe-printify',
  'smoke-render',
  'bootstrap-backdrop',
  'verify-loop',
  'runs',
  'release-run',
] as const;

type Action = (typeof ACTIONS)[number];

/** Actions a merely-authenticated caller may run (no writes, no secrets). */
const OPEN_ACTIONS: ReadonlySet<Action> = new Set<Action>(['whoami']);

function parseWriterIds(): string[] {
  return (process.env.GALLERY_WRITER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isBrand(v: unknown): v is Brand {
  return typeof v === 'string' && VALID_BRANDS.has(v);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await req.json();
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const action = body.action;
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
    return NextResponse.json(
      { ok: false, error: `body.action must be one of: ${ACTIONS.join(', ')}` },
      { status: 400 },
    );
  }
  const typedAction = action as Action;

  // ── Auth ───────────────────────────────────────────────────────────────────
  const authHeader = req.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return NextResponse.json({ ok: false, error: 'Authorization header required' }, { status: 401 });
  }

  let user: { id: string; email?: string } | null;
  try {
    user = await verifyUserJwt(token);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[setup/route] verifyUserJwt threw:', message);
    return NextResponse.json(
      { ok: false, error: `JWT verification failed: ${message}` },
      { status: 500 },
    );
  }

  if (!user) {
    return NextResponse.json({ ok: false, error: 'Invalid or expired token' }, { status: 401 });
  }

  const writerIds = parseWriterIds();
  const inAllowlist = writerIds.includes(user.id);

  if (typedAction === 'whoami') {
    return NextResponse.json({
      ok: true,
      action: typedAction,
      userId: user.id,
      email: user.email ?? null,
      inAllowlist,
      allowlistCount: writerIds.length,
      allowlistConfigured: writerIds.length > 0,
      // The exact line to paste into the deployment's env vars.
      envLine: `GALLERY_WRITER_IDS=${writerIds.length > 0 && inAllowlist ? writerIds.join(',') : user.id}`,
      serverTime: new Date().toISOString(),
    });
  }

  if (!OPEN_ACTIONS.has(typedAction) && (writerIds.length === 0 || !inAllowlist)) {
    return NextResponse.json(
      {
        ok: false,
        error: writerIds.length === 0 ? 'forbidden_allowlist_empty' : 'forbidden_not_allowlisted',
        hint:
          writerIds.length === 0
            ? 'GALLERY_WRITER_IDS is empty, so nothing can write — by design. Set it to your Supabase user id (the whoami action shows it) on the deployment, then redeploy.'
            : 'This Supabase user id is not in GALLERY_WRITER_IDS. Add it (comma-separate if you already have entries), then redeploy.',
        userId: user.id,
      },
      { status: 403 },
    );
  }

  // ── Dispatch ───────────────────────────────────────────────────────────────
  try {
    switch (typedAction) {
      case 'probe-db': {
        const [database, bases] = await Promise.all([probeDatabase(), probeBaseAssets()]);
        return NextResponse.json({
          ok: database.ok,
          action: typedAction,
          database,
          bases,
          config: {
            supabaseServer: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
            printify: Boolean(process.env.PRINTIFY_API_KEY && process.env.PRINTIFY_SHOP_ID),
            cronSecret: Boolean(process.env.CRON_SECRET),
          },
        });
      }

      case 'probe-storage': {
        const storage = await probeStorage();
        return NextResponse.json({ ok: storage.ok, action: typedAction, storage });
      }

      case 'probe-printify': {
        const query =
          typeof body.query === 'string' && body.query.trim() !== ''
            ? body.query.trim().slice(0, 120)
            : 'misfit tee';
        const printify = await probePrintify(query);
        return NextResponse.json({ ok: printify.ok, action: typedAction, query, printify });
      }

      case 'smoke-render': {
        const brand = isBrand(body.brand) ? body.brand : null;
        if (!brand) {
          return NextResponse.json(
            { ok: false, error: 'body.brand must be "misfit" or "forge"' },
            { status: 400 },
          );
        }
        const text =
          typeof body.text === 'string' && body.text.trim() !== ''
            ? body.text.trim().slice(0, 280)
            : `SETUP SMOKE TEST — ${brand}`;

        const result = await renderSmokeCard(brand, text);
        return NextResponse.json({ action: typedAction, ...result }, { status: 200 });
      }

      case 'bootstrap-backdrop': {
        const brand = isBrand(body.brand) ? body.brand : null;
        if (!brand) {
          return NextResponse.json(
            { ok: false, error: 'body.brand must be "misfit" or "forge"' },
            { status: 400 },
          );
        }
        const result = await bootstrapBackdrop(brand);
        return NextResponse.json({ action: typedAction, ...result }, { status: result.ok ? 200 : 409 });
      }

      case 'verify-loop': {
        const result = await verifyDecisionIntegrity();
        return NextResponse.json({ action: typedAction, ...result }, { status: 200 });
      }

      case 'runs': {
        const runs = await listRecentRuns(12);
        return NextResponse.json({ action: typedAction, ...runs });
      }

      case 'release-run': {
        const brand = isBrand(body.brand) ? body.brand : null;
        if (!brand) {
          return NextResponse.json(
            { ok: false, error: 'body.brand must be "misfit" or "forge"' },
            { status: 400 },
          );
        }
        const released = await forceReleaseRun(brand);
        return NextResponse.json({ action: typedAction, brand, ...released });
      }

      default:
        return NextResponse.json({ ok: false, error: 'unreachable action' }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[setup/route] action ${typedAction} threw:`, message);
    return NextResponse.json(
      { ok: false, action: typedAction, error: message },
      { status: 500 },
    );
  }
}
