'use client';
// src/app/page.tsx
//
// HOME — the one place to look at the machine.
//
// D's dashboard: pipeline overview, live queue/gallery/decision counts,
// rotation pointers, config status, recent decisions, and one-tap batch
// triggers for both brands. Data comes from GET /api/status (polled every
// 30s); batch runs go through POST /api/batch with the signed-in writer's
// JWT (same allowlist as everything else).
//
// Phone-first (S25 Ultra, one-handed): big tap targets, single column,
// sticky nav from the layout.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { Session } from '@supabase/supabase-js';
import { browserSupabase } from '../lib/browserSupabase';
import type { Brand } from '../types/media';

// ── API shapes (mirror /api/status + /api/batch responses) ────────────────────

interface StatusData {
  ok: boolean;
  config: Record<string, boolean>;
  review: Record<Brand, { pending: number; oracleRejected: number }> | null;
  gallery: { misfit: number; forge: number; shared: number; total: number } | null;
  decisions: {
    total: number;
    last24h: number;
    recent: Array<{
      itemId: string;
      decision: 'post' | 'remix' | 'reject';
      brand: Brand;
      lane: string;
      decidedAt: number;
    }>;
  } | null;
  remixQueue: number | null;
  rotation: {
    rotationState: Array<{ brand: string; lastUsedIndex: number }>;
    textRotationState: Array<{ brand: string; lastUsedIndex: number }>;
    laneRotationState: Array<{ scope: string; lastUsedIndex: number }>;
  } | null;
  errors: Record<string, string>;
}

interface LaneOutcome {
  lane: string;
  status: 'ok' | 'empty' | 'error';
  itemsQueued: number;
  error?: string;
}

interface BatchResult {
  batchId: string;
  queued: number;
  laneOutcomes: Record<string, LaneOutcome>;
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function ago(ts: number): string {
  const s = Math.max(0, Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const DECISION_STYLES: Record<string, string> = {
  post: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  remix: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  reject: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
};

const LANE_STYLES: Record<string, string> = {
  ok: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  empty: 'bg-neutral-800 text-neutral-400 border-neutral-700',
  error: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
};

// ── Reusable bits ─────────────────────────────────────────────────────────────

function SectionCard({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold tracking-widest text-neutral-500">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function ConfigChip({ label, on }: { label: string; on: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
        on
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
          : 'border-neutral-700 bg-neutral-900 text-neutral-500'
      }`}
      title={on ? `${label}: configured` : `${label}: NOT configured`}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${on ? 'bg-emerald-400' : 'bg-neutral-600'}`}
      />
      {label}
    </span>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function HomePage() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [runningBrand, setRunningBrand] = useState<Brand | null>(null);
  const [batchResult, setBatchResult] = useState<
    { brand: Brand; result?: BatchResult; error?: string } | null
  >(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) {
        setLoadError(`Status endpoint returned ${res.status}`);
        return;
      }
      setStatus((await res.json()) as StatusData);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    const id = setInterval(() => void loadStatus(), 30_000);
    return () => clearInterval(id);
  }, [loadStatus]);

  // Session (for batch triggers). Env may be unset — degrade silently here;
  // the status endpoint surfaces config problems visibly.
  useEffect(() => {
    try {
      const client = browserSupabase();
      void client.auth.getSession().then(({ data }) => setSession(data.session));
      const {
        data: { subscription },
      } = client.auth.onAuthStateChange((_event, s) => setSession(s));
      return () => subscription.unsubscribe();
    } catch {
      /* NEXT_PUBLIC_* not set — handled by config chips */
    }
  }, []);

  async function runBatch(brand: Brand) {
    if (!session || runningBrand) return;
    setRunningBrand(brand);
    setBatchResult(null);
    try {
      const res = await fetch(`/api/batch?brand=${brand}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const body = (await res.json()) as BatchResult & { error?: string };
      if (!res.ok) {
        setBatchResult({ brand, error: body.error ?? `HTTP ${res.status}` });
      } else {
        setBatchResult({ brand, result: body });
      }
    } catch (err) {
      setBatchResult({ brand, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setRunningBrand(null);
      void loadStatus();
    }
  }

  const review = status?.review ?? null;
  const gallery = status?.gallery ?? null;
  const decisions = status?.decisions ?? null;
  const errors = status?.errors ?? {};
  const errorEntries = Object.entries(errors);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 px-4 pb-16 pt-5">
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold tracking-wide">Command Center</h1>
          <p className="mt-0.5 text-sm text-neutral-400">
            Misfit / Forge · governed pipeline · append-only gallery
          </p>
        </div>
        <button
          onClick={() => void loadStatus()}
          disabled={loading}
          className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
          aria-label="Refresh status"
        >
          {loading ? '…' : '↻'}
        </button>
      </div>

      {/* ── Pipeline strip ───────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-1 rounded-xl border border-neutral-800 bg-neutral-900/50 px-3 py-3 text-center text-[11px] text-neutral-400">
        <div className="flex flex-1 flex-col items-center gap-1">
          <span className="text-base">⚙️</span>
          <span className="font-medium text-neutral-300">Generate</span>
          <span className="hidden sm:block">3 lanes</span>
        </div>
        <span aria-hidden className="text-neutral-600">→</span>
        <div className="flex flex-1 flex-col items-center gap-1">
          <span className="text-base">🛡️</span>
          <span className="font-medium text-neutral-300">Oracle</span>
          <span className="hidden sm:block">doctrine gate</span>
        </div>
        <span aria-hidden className="text-neutral-600">→</span>
        <div className="flex flex-1 flex-col items-center gap-1">
          <span className="text-base">👀</span>
          <span className="font-medium text-neutral-300">Review</span>
          <span className="hidden sm:block">you decide</span>
        </div>
        <span aria-hidden className="text-neutral-600">→</span>
        <div className="flex flex-1 flex-col items-center gap-1">
          <span className="text-base">🗄️</span>
          <span className="font-medium text-neutral-300">Gallery</span>
          <span className="hidden sm:block">permanent</span>
        </div>
      </div>

      {/* ── Backend status banner ────────────────────────────────────────── */}
      {loadError && (
        <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
          Status unavailable: {loadError}
        </p>
      )}
      {!loading && errorEntries.length > 0 && (
        <div role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
          <p className="font-medium">Backend warnings</p>
          <ul className="mt-1 list-disc pl-4">
            {errorEntries.map(([k, v]) => (
              <li key={k}>
                <span className="font-mono text-xs">{k}</span>: {v}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Config chips ─────────────────────────────────────────────────── */}
      {status && (
        <div className="flex flex-wrap gap-1.5">
          <ConfigChip label="Supabase" on={!!status.config.supabaseServer} />
          <ConfigChip label="Browser key" on={!!status.config.supabaseBrowser} />
          <ConfigChip label="Printify" on={!!status.config.printify} />
          <ConfigChip label="Cron" on={!!status.config.cronSecret} />
          <ConfigChip label="Writers" on={!!status.config.galleryWriters} />
        </div>
      )}

      {/* ── Review queues ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {(['misfit', 'forge'] as Brand[]).map((b) => {
          const s = review?.[b];
          return (
            <Link
              key={b}
              href={`/review?brand=${b}`}
              className="group rounded-xl border border-neutral-800 bg-neutral-900/50 p-4 transition-colors hover:border-neutral-600"
            >
              <div className="flex items-baseline justify-between">
                <span className="text-xs font-semibold uppercase tracking-widest text-neutral-500">
                  {b}
                </span>
                <span className="text-3xl font-bold text-neutral-100 group-hover:text-emerald-400">
                  {s ? s.pending : '—'}
                </span>
              </div>
              <p className="mt-1 text-sm text-neutral-400">
                pending review
                {s && s.oracleRejected > 0 && (
                  <span className="text-neutral-500"> · {s.oracleRejected} oracle-rejected</span>
                )}
              </p>
            </Link>
          );
        })}
      </div>

      {/* ── Gallery + remix ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Link
          href="/gallery"
          className="group rounded-xl border border-neutral-800 bg-neutral-900/50 p-4 transition-colors hover:border-neutral-600"
        >
          <div className="flex items-baseline justify-between">
            <span className="text-xs font-semibold uppercase tracking-widest text-neutral-500">
              Gallery
            </span>
            <span className="text-3xl font-bold text-neutral-100 group-hover:text-emerald-400">
              {gallery ? gallery.total : '—'}
            </span>
          </div>
          <p className="mt-1 text-sm text-neutral-400">
            permanent assets
            {gallery && (
              <span className="text-neutral-500">
                {' '}
                · {gallery.misfit}m / {gallery.forge}f / {gallery.shared}sh
              </span>
            )}
          </p>
        </Link>

        <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4">
          <div className="flex items-baseline justify-between">
            <span className="text-xs font-semibold uppercase tracking-widest text-neutral-500">
              Remix queue
            </span>
            <span className="text-3xl font-bold text-neutral-100">
              {status?.remixQueue ?? '—'}
            </span>
          </div>
          <p className="mt-1 text-sm text-neutral-400">work orders all-time</p>
        </div>
      </div>

      {/* ── Run a batch ──────────────────────────────────────────────────── */}
      <SectionCard title="RUN A BATCH">
        {!session ? (
          <p className="text-sm text-neutral-400">
            Sign in on the{' '}
            <Link href="/review" className="text-emerald-400 underline underline-offset-2">
              Review page
            </Link>{' '}
            to trigger batches (writer allowlist).
          </p>
        ) : (
          <div className="flex gap-2">
            {(['misfit', 'forge'] as Brand[]).map((b) => (
              <button
                key={b}
                onClick={() => void runBatch(b)}
                disabled={runningBrand !== null}
                className="flex-1 rounded-lg bg-emerald-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
              >
                {runningBrand === b ? 'Running…' : `Run ${b} batch`}
              </button>
            ))}
          </div>
        )}

        {batchResult && (
          <div className="mt-3 rounded-lg border border-neutral-800 bg-neutral-950 p-3 text-sm">
            <p className="mb-2 text-neutral-400">
              {batchResult.brand} batch{' '}
              <span className="font-mono text-xs text-neutral-500">
                {batchResult.result?.batchId.slice(0, 8)}
              </span>
              {batchResult.error && <span className="text-rose-400"> failed</span>}
            </p>
            {batchResult.error ? (
              <p className="break-words text-rose-300">{batchResult.error}</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {Object.values(batchResult.result?.laneOutcomes ?? {}).map((o) => (
                  <li key={o.lane} className="flex items-center gap-2">
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${LANE_STYLES[o.status] ?? LANE_STYLES.empty}`}
                    >
                      {o.status}
                    </span>
                    <span className="font-mono text-xs text-neutral-300">{o.lane}</span>
                    <span className="text-xs text-neutral-500">
                      {o.itemsQueued} queued
                      {o.error ? ` · ${o.error}` : ''}
                    </span>
                  </li>
                ))}
                <li className="mt-1 text-xs text-neutral-500">
                  {batchResult.result?.queued ?? 0} item(s) →{' '}
                  <Link href={`/review?brand=${batchResult.brand}`} className="text-emerald-400 underline underline-offset-2">
                    review now
                  </Link>
                </li>
              </ul>
            )}
          </div>
        )}
      </SectionCard>

      {/* ── Recent decisions ─────────────────────────────────────────────── */}
      <SectionCard
        title="RECENT DECISIONS"
        action={
          decisions && (
            <span className="text-xs text-neutral-500">
              {decisions.total} all-time · {decisions.last24h} last 24h
            </span>
          )
        }
      >
        {decisions && decisions.recent.length > 0 ? (
          <ul className="flex flex-col divide-y divide-neutral-800/60">
            {decisions.recent.map((d) => (
              <li key={`${d.itemId}-${d.decidedAt}`} className="flex items-center gap-2 py-2">
                <span
                  className={`rounded border px-1.5 py-0.5 text-[11px] font-medium capitalize ${DECISION_STYLES[d.decision] ?? ''}`}
                >
                  {d.decision}
                </span>
                <span className="text-xs uppercase text-neutral-400">{d.brand}</span>
                <span className="truncate font-mono text-xs text-neutral-500">{d.lane}</span>
                <span className="ml-auto shrink-0 text-xs text-neutral-600">
                  {ago(d.decidedAt)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-neutral-500">
            {decisions ? 'No decisions yet — run a batch, then review.' : '—'}
          </p>
        )}
      </SectionCard>

      {/* ── Rotation pointers ────────────────────────────────────────────── */}
      <SectionCard title="ROTATION POINTERS">
        {status?.rotation ? (
          <div className="flex flex-col gap-1.5 text-xs">
            {status.rotation.textRotationState.length === 0 &&
              status.rotation.laneRotationState.length === 0 &&
              status.rotation.rotationState.length === 0 && (
                <p className="text-neutral-500">
                  No rotation yet — pointers appear after the first batch.
                </p>
              )}
            {status.rotation.textRotationState.map((r) => (
              <Row key={`t-${r.brand}`} k={`text:${r.brand}`} v={`index ${r.lastUsedIndex}`} />
            ))}
            {status.rotation.laneRotationState.map((r) => (
              <Row key={`l-${r.scope}`} k={r.scope} v={`index ${r.lastUsedIndex}`} />
            ))}
            {status.rotation.rotationState.map((r) => (
              <Row key={`r-${r.brand}`} k={`recomb:${r.brand}`} v={`index ${r.lastUsedIndex}`} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-neutral-500">—</p>
        )}
      </SectionCard>

      <p className="mt-2 text-center text-[11px] text-neutral-600">
        Reader / Oracle / Overseer — D is final ground truth. The gallery is append-only.
      </p>
    </main>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-neutral-800/60 pb-1">
      <span className="truncate font-mono text-neutral-400">{k}</span>
      <span className="shrink-0 text-neutral-500">{v}</span>
    </div>
  );
}
