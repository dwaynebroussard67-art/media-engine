'use client';
// src/app/setup/page.tsx
//
// SETUP — the guided, interactive bring-up screen.
//
// Every card does one real thing against the live deployment and shows the
// evidence for what it found. Nothing here reports a check it did not earn:
// where the app genuinely cannot see (append-only triggers, unique indexes,
// RLS) it hands over exact SQL and reads back what you paste, rather than
// showing a green tick it invented.
//
// Scope, stated plainly on the page itself: this UI verifies and instructs. It
// CANNOT set deployment environment variables — those live in Vercel, and the
// alternative (writing secrets into a database from a web form) would be worse
// than the problem. Where a value must be pasted into Vercel, this page shows
// it with a copy button.
//
// Phone-first: single column, 48px targets, one brand at a time.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { Session } from '@supabase/supabase-js';
import { useSupabaseSession, SignInPanel } from '../../components/SignInPanel';
import { SCHEMA_REPORT_SQL, TRIGGER_PROOF_SQL, parseSchemaReport, type SqlReport, type SqlCheck } from '../../lib/setup/sqlVerify';
import { DOCTRINE_IS_PLACEHOLDER } from '../../config/doctrine';
import { TEXT_BANKS_ARE_PLACEHOLDER } from '../../config/textBanks';
import { runPrefilter } from '../../lib/oracle/prefilter';
import { TEXT_BANKS } from '../../config/textBanks';
import type { Brand } from '../../types/media';

// ── Shapes mirrored from the APIs this page talks to ─────────────────────────

interface StatusData {
  ok: boolean;
  config: Record<string, boolean>;
  review: Record<Brand, { pending: number; oracleRejected: number }> | null;
  gallery: { misfit: number; forge: number; shared: number; total: number } | null;
  decisions: { total: number; last24h: number } | null;
  remixQueue: number | null;
  errors: Record<string, string>;
}

interface ProbeStep {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

interface TableRow {
  table: string;
  createdBy: string;
  required: boolean;
  ok: boolean;
  count?: number;
  error?: string;
}

interface DbProbeResult {
  ok: boolean;
  database: {
    ok: boolean;
    tables: TableRow[];
    jsonbFilter: { ok: boolean; detail: string; pendingPassed?: number; pendingRejected?: number };
    warnings: string[];
  };
  bases: {
    ok: boolean;
    byBrand: Record<string, { freshTextBases: number; recombinationBases: number }>;
    error?: string;
  };
}

interface StorageProbeResult {
  ok: boolean;
  storage: { ok: boolean; steps: ProbeStep[]; warnings: string[] };
}

interface PrintifyProbeResult {
  ok: boolean;
  query: string;
  printify: {
    ok: boolean;
    ms: number;
    resultCount?: number;
    sample?: string;
    error?: string;
    warnings: string[];
  };
}

interface SmokeResult {
  ok: boolean;
  brand: Brand;
  text: string;
  finalUrl?: string;
  finalBytes?: number;
  steps: ProbeStep[];
  typography: {
    fontFamily: string;
    fontSize: number;
    fontWeight: number;
    color: string;
    backgroundColor: string | null;
    opacity: number;
    padding: number;
  };
  warnings: string[];
  error?: string;
}

interface WhoAmI {
  userId: string;
  email: string | null;
  inAllowlist: boolean;
  allowlistCount: number;
  allowlistConfigured: boolean;
  envLine: string;
}

interface RunsResult {
  ok: boolean;
  runs: Array<{
    id: string;
    brand: string;
    status: 'running' | 'done' | 'error';
    started_at: number;
    finished_at: number | null;
    queued: number | null;
    note: string | null;
  }>;
  error?: string;
}

interface VerifyLoopResult {
  ok: boolean;
  status: 'verified' | 'no_post_decisions' | 'partial' | 'failed';
  itemId?: string;
  detail: string;
  steps: ProbeStep[];
  warnings: string[];
}

interface BootstrapResult {
  ok: boolean;
  brand: Brand;
  steps: ProbeStep[];
  assetId?: string;
  assetUrl?: string;
  error?: string;
  warnings: string[];
}

type CheckStatus = 'pass' | 'fail' | 'warn' | 'todo';

interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  href?: string;
}

const SQL_STORAGE_KEY = 'media-engine.setup.sqlReport.v1';

// ── Small helpers ────────────────────────────────────────────────────────────

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure contexts (clipboard API is https-only).
    try {
      const el = document.createElement('textarea');
      el.value = text;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(el);
      return ok;
    } catch {
      return false;
    }
  }
}

function ago(ts: number): string {
  const s = Math.max(0, Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function stepTimeline(steps: ProbeStep[]): React.ReactElement {
  return (
    <ul className="flex flex-col gap-1.5">
      {steps.map((s, i) => (
        <li key={`${s.name}-${i}`} className="flex flex-col gap-0.5 border-b border-neutral-800/60 pb-1.5">
          <div className="flex items-center gap-2">
            <StatusDot status={s.ok ? 'pass' : 'fail'} />
            <span className="font-mono text-xs text-neutral-300">{s.name}</span>
            <span className="ml-auto shrink-0 text-[11px] text-neutral-600">{s.ms}ms</span>
          </div>
          <p className="break-words pl-5 text-xs text-neutral-500">{s.detail}</p>
        </li>
      ))}
    </ul>
  );
}

// ── Presentational bits ──────────────────────────────────────────────────────

function StatusDot({ status }: { status: CheckStatus | 'pass' | 'fail' }): React.ReactElement {
  const color =
    status === 'pass'
      ? 'bg-emerald-400'
      : status === 'fail'
        ? 'bg-rose-500'
        : status === 'warn'
          ? 'bg-amber-400'
          : 'bg-neutral-600';
  return <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${color}`} />;
}

function Section({
  step,
  title,
  subtitle,
  state,
  children,
}: {
  step: string;
  title: string;
  subtitle?: string;
  state?: CheckStatus;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4">
      <header className="mb-3 flex items-start gap-3">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-neutral-700 bg-neutral-950 font-mono text-[11px] text-neutral-400">
          {step}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {state && <StatusDot status={state} />}
            <h2 className="text-sm font-semibold text-neutral-100">{title}</h2>
          </div>
          {subtitle && <p className="mt-0.5 text-xs text-neutral-500">{subtitle}</p>}
        </div>
      </header>
      {children}
    </section>
  );
}

function Button({
  onClick,
  children,
  busy,
  disabled,
  tone = 'primary',
}: {
  onClick: () => void;
  children: React.ReactNode;
  busy?: boolean;
  disabled?: boolean;
  tone?: 'primary' | 'secondary' | 'danger';
}): React.ReactElement {
  const tones = {
    primary: 'bg-emerald-600 text-white hover:bg-emerald-500 disabled:bg-neutral-800',
    secondary: 'border border-neutral-700 bg-neutral-900 text-neutral-200 hover:bg-neutral-800 disabled:bg-neutral-900',
    danger: 'border border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 disabled:bg-neutral-900',
  } as const;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className={`min-h-[48px] rounded-lg px-4 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:text-neutral-500 ${tones[tone]}`}
    >
      {busy ? 'Working…' : children}
    </button>
  );
}

function CopyLine({
  label,
  value,
  onCopied,
}: {
  label: string;
  value: string;
  onCopied?: (ok: boolean, label: string) => void;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2">
      <span className="shrink-0 text-[11px] uppercase tracking-widest text-neutral-500">{label}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-300">{value}</code>
      <button
        type="button"
        onClick={() => {
          void copyText(value).then((ok) => onCopied?.(ok, label));
        }}
        className="shrink-0 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-800"
      >
        Copy
      </button>
    </div>
  );
}

function Notes({ warnings }: { warnings: string[] }): React.ReactElement | null {
  if (warnings.length === 0) return null;
  return (
    <ul className="mt-3 flex flex-col gap-1.5">
      {warnings.map((w, i) => (
        <li key={i} className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          {w}
        </li>
      ))}
    </ul>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function SetupPage(): React.ReactElement {
  const session = useSupabaseSession();
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusData | null>(null);
  const [whoami, setWhoami] = useState<WhoAmI | null>(null);
  const [dbResult, setDbResult] = useState<DbProbeResult | null>(null);
  const [storageResult, setStorageResult] = useState<StorageProbeResult | null>(null);
  const [printifyResult, setPrintifyResult] = useState<PrintifyProbeResult | null>(null);
  const [smokeResult, setSmokeResult] = useState<SmokeResult | null>(null);
  const [verifyResult, setVerifyResult] = useState<VerifyLoopResult | null>(null);
  const [bootstrapResult, setBootstrapResult] = useState<BootstrapResult | null>(null);
  const [runs, setRuns] = useState<RunsResult | null>(null);
  const [sqlPaste, setSqlPaste] = useState('');
  const [sqlReport, setSqlReport] = useState<SqlReport | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const [smokeBrand, setSmokeBrand] = useState<Brand>('misfit');
  const [smokeText, setSmokeText] = useState('');
  const [printifyQuery, setPrintifyQuery] = useState('misfit tee');
  const [armed, setArmed] = useState<Record<string, boolean>>({});

  const setBusyFor = (key: string, value: boolean) =>
    setBusy((prev) => ({ ...prev, [key]: value }));

  // ── Data loading ───────────────────────────────────────────────────────────

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/status');
      setStatus((await res.json()) as StatusData);
    } catch (err) {
      setNotice(`Status endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // Restore the last SQL paste-back so a refresh doesn't lose it.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SQL_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { paste?: string };
        if (typeof parsed.paste === 'string') {
          setSqlPaste(parsed.paste);
          setSqlReport(parseSchemaReport(parsed.paste));
        }
      }
    } catch {
      /* nothing to restore */
    }
  }, []);

  const call = useCallback(
    async <T,>(action: string, body: Record<string, unknown> = {}): Promise<T | null> => {
      if (!session) {
        setNotice('Sign in first.');
        return null;
      }
      setBusyFor(action, true);
      try {
        const res = await fetch('/api/setup', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ action, ...body }),
        });
        const json = (await res.json()) as T & { error?: string; hint?: string };
        if (!res.ok && !('action' in json)) {
          setNotice(`${action}: ${json.error ?? `HTTP ${res.status}`}${json.hint ? ` — ${json.hint}` : ''}`);
          return json;
        }
        if (!res.ok && json.error) {
          setNotice(`${action}: ${json.error}`);
        }
        return json;
      } catch (err) {
        setNotice(`${action} failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      } finally {
        setBusyFor(action, false);
      }
    },
    [session],
  );

  // whoami runs as soon as there is a session — it is the one action that works
  // before the allowlist is configured, on purpose.
  useEffect(() => {
    if (!session) {
      setWhoami(null);
      return;
    }
    void (async () => {
      const res = await call<WhoAmI>('whoami');
      if (res && 'userId' in res) setWhoami(res);
    })();
  }, [session, call]);

  const loadRuns = useCallback(async () => {
    const res = await call<RunsResult>('runs');
    if (res && 'runs' in res) setRuns(res);
  }, [call]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const runDbProbe = async () => {
    const res = await call<DbProbeResult>('probe-db');
    if (res && 'database' in res) setDbResult(res);
    void loadStatus();
  };

  const runStorageProbe = async () => {
    const res = await call<StorageProbeResult>('probe-storage');
    if (res && 'storage' in res) setStorageResult(res);
  };

  const runPrintify = async () => {
    const res = await call<PrintifyProbeResult>('probe-printify', { query: printifyQuery });
    if (res && 'printify' in res) setPrintifyResult(res);
  };

  const runSmoke = async () => {
    const res = await call<SmokeResult>('smoke-render', {
      brand: smokeBrand,
      ...(smokeText.trim() !== '' ? { text: smokeText } : {}),
    });
    if (res && 'steps' in res) setSmokeResult(res);
  };

  const runVerify = async () => {
    const res = await call<VerifyLoopResult>('verify-loop');
    if (res && 'steps' in res) setVerifyResult(res);
  };

  const runBootstrap = async (brand: Brand) => {
    const res = await call<BootstrapResult>('bootstrap-backdrop', { brand });
    if (res && 'steps' in res) setBootstrapResult(res);
    if (res && res.ok) {
      setArmed((p) => ({ ...p, [`bootstrap-${brand}`]: false }));
      void runDbProbe();
    }
  };

  const runBatch = async (brand: Brand) => {
    if (!session) return;
    setBusyFor(`batch-${brand}`, true);
    setNotice(null);
    try {
      const res = await fetch(`/api/batch?brand=${brand}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const body = (await res.json()) as {
        error?: string;
        hint?: string;
        batchId?: string;
        queued?: number;
        laneOutcomes?: Record<string, { lane: string; status: string; itemsQueued: number; error?: string }>;
        lock?: { status: string; reason?: string; hint?: string };
      };
      if (res.status === 409) {
        setNotice(`Batch refused: ${body.hint ?? body.error ?? 'already running'}`);
      } else if (!res.ok) {
        setNotice(`Batch failed: ${body.error ?? `HTTP ${res.status}`}`);
      } else {
        const lanes = Object.values(body.laneOutcomes ?? {})
          .map((l) => `${l.lane}:${l.status}(${l.itemsQueued})`)
          .join(' ');
        setNotice(
          `Batch ${body.batchId?.slice(0, 8) ?? ''} queued ${body.queued ?? 0} item(s). ${lanes}${
            body.lock?.status === 'unavailable' ? ` — ⚠ NO LOCK: ${body.lock.reason ?? ''}` : ''
          }`,
        );
      }
      void loadStatus();
      void loadRuns();
    } catch (err) {
      setNotice(`Batch failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyFor(`batch-${brand}`, false);
    }
  };

  const releaseRun = async (brand: Brand) => {
    const res = await call<{ ok: boolean; released: number; error?: string }>('release-run', { brand });
    if (res && 'released' in res) {
      setNotice(
        res.ok
          ? `Released ${res.released} stuck run(s) for ${brand}.`
          : `Could not release: ${res.error ?? 'unknown error'}`,
      );
      void loadRuns();
    }
  };

  const applySqlPaste = (raw: string) => {
    setSqlPaste(raw);
    const parsed = parseSchemaReport(raw);
    setSqlReport(parsed);
    try {
      window.localStorage.setItem(SQL_STORAGE_KEY, JSON.stringify({ paste: raw }));
    } catch {
      /* storage disabled — the paste just isn't remembered */
    }
  };

  // ── Derived readiness ──────────────────────────────────────────────────────

  // Placeholder text can be spotted without the database: run the REAL oracle
  // over the shipped banks on the lanes that enforce theology.
  const placeholderAudit = useMemo(() => {
    const out: Record<Brand, { total: number; rejected: string[] }> = {
      misfit: { total: 0, rejected: [] },
      forge: { total: 0, rejected: [] },
    };
    for (const brand of ['misfit', 'forge'] as Brand[]) {
      for (const line of TEXT_BANKS[brand]) {
        out[brand].total += 1;
        const result = runPrefilter({
          imageUrl: 'https://example.invalid/base.webp',
          brand,
          lane: 'fresh_text_card',
          overlayText: line,
        });
        if (!result.passed) out[brand].rejected.push(line);
      }
    }
    return out;
  }, []);

  const checks: Check[] = useMemo(() => {
    const list: Check[] = [];
    const cfg = status?.config ?? {};

    list.push({
      id: 'env.supabaseServer',
      label: 'Server Supabase config (SUPABASE_URL + service role key)',
      status: cfg.supabaseServer ? 'pass' : 'fail',
      detail: cfg.supabaseServer
        ? 'present on this deployment'
        : 'not set — every database call fails until it is. Vercel → Project → Settings → Environment Variables.',
    });
    list.push({
      id: 'env.supabaseBrowser',
      label: 'Browser key (NEXT_PUBLIC_SUPABASE_URL + ANON key)',
      status: cfg.supabaseBrowser ? 'pass' : 'fail',
      detail: cfg.supabaseBrowser
        ? 'present — the phone can sign in'
        : 'not set — no page can sign in until it is (these two are safe to expose).',
    });
    list.push({
      id: 'env.writers',
      label: 'Writer allowlist (GALLERY_WRITER_IDS)',
      status: whoami ? (whoami.inAllowlist ? 'pass' : 'fail') : 'todo',
      detail: whoami
        ? whoami.inAllowlist
          ? `this account (${whoami.email ?? whoami.userId.slice(0, 8)}) is allowlisted`
          : whoami.allowlistConfigured
            ? 'set, but this account is NOT in it — writes will 403'
            : 'empty — fails closed, so nobody (including you) can write'
        : 'sign in below to read your user id',
    });
    list.push({
      id: 'env.cron',
      label: 'CRON_SECRET',
      status: cfg.cronSecret ? 'pass' : 'warn',
      detail: cfg.cronSecret
        ? 'present — the scheduled batch authenticates'
        : 'not set — the daily cron will get 401 and never assemble a batch (this exact bug happened before)',
    });
    list.push({
      id: 'env.printify',
      label: 'Printify (PRINTIFY_API_KEY + PRINTIFY_SHOP_ID)',
      status: cfg.printify ? (printifyResult?.printify.ok ? 'pass' : printifyResult ? 'fail' : 'todo') : 'warn',
      detail: !cfg.printify
        ? 'not set — the merch lane reports CatalogUnavailableError and never falls through to AI (by design)'
        : printifyResult
          ? printifyResult.printify.ok
            ? `${printifyResult.printify.resultCount ?? 0} result(s) in ${printifyResult.printify.ms}ms`
            : `search failed: ${printifyResult.printify.error ?? 'unknown'}`
          : 'set — run the catalog check',
    });

    const db = dbResult?.database;
    if (db) {
      const missing = db.tables.filter((t) => !t.ok && t.required);
      list.push({
        id: 'db.tables',
        label: 'Core tables reachable',
        status: missing.length === 0 ? 'pass' : 'fail',
        detail:
          missing.length === 0
            ? `${db.tables.length} tables probed, all reachable`
            : `missing: ${missing.map((t) => t.table).join(', ')}`,
      });
      list.push({
        id: 'db.jsonbFilter',
        label: 'oracle_result->>passed filter (the known unverified live check)',
        status: db.jsonbFilter.ok ? 'pass' : 'fail',
        detail: db.jsonbFilter.detail,
      });
      list.push({
        id: 'db.batchRuns',
        label: 'Batch single-flight (migration 004)',
        status:
          db.tables.find((t) => t.table === 'batch_runs')?.ok ? 'pass' : 'warn',
        detail: db.tables.find((t) => t.table === 'batch_runs')?.ok
          ? 'batch_runs present — overlapping runs are refused (no rotation corruption)'
          : 'batch_runs missing — two overlapping batches can still corrupt rotation state',
      });
    } else {
      list.push({
        id: 'db.tables',
        label: 'Core tables reachable',
        status: 'todo',
        detail: 'run the database probe',
      });
    }

    list.push({
      id: 'storage.bucket',
      label: 'Storage bucket "media-engine" (write + public read)',
      status: storageResult ? (storageResult.storage.ok ? 'pass' : 'fail') : 'todo',
      detail: storageResult
        ? storageResult.storage.ok
          ? 'uploaded, read back publicly over HTTPS, cleaned up'
          : storageResult.storage.steps.find((s) => !s.ok)?.detail ?? 'failed'
        : 'run the storage probe',
    });

    list.push({
      id: 'render.smoke',
      label: 'End-to-end render (sharp → storage → public URL)',
      status: smokeResult ? (smokeResult.ok ? 'pass' : 'fail') : 'todo',
      detail: smokeResult
        ? smokeResult.ok
          ? `rendered ${smokeResult.finalBytes ?? '?'} bytes and fetched it back publicly — LOOK at the card to check the typeface`
          : smokeResult.error ?? 'failed'
        : 'run the smoke render',
    });

    const bases = dbResult?.bases.byBrand;
    for (const brand of ['misfit', 'forge'] as Brand[]) {
      const b = bases?.[brand];
      list.push({
        id: `assets.${brand}`,
        label: `Base assets for ${brand} (fresh-text lane)`,
        status: !b ? 'todo' : b.freshTextBases > 0 ? 'pass' : 'fail',
        detail: !b
          ? 'run the database probe'
          : b.freshTextBases > 0
            ? `${b.freshTextBases} atmosphere/art base(s) + ${b.recombinationBases} recombination base(s)`
            : 'zero eligible bases — the fresh-text lane throws NoFreshTextBaseError and the recombination lane throws NoEligibleBaseError; the batch will only produce merch',
        href: `/gallery?brand=${brand}&category=atmosphere`,
      });
    }

    const nl = '\n';
    list.push({
      id: 'content.placeholder',
      label: 'Brand voice is D\'s own words (doctrine + text banks)',
      status: DOCTRINE_IS_PLACEHOLDER || TEXT_BANKS_ARE_PLACEHOLDER ? 'fail' : 'pass',
      detail:
        DOCTRINE_IS_PLACEHOLDER || TEXT_BANKS_ARE_PLACEHOLDER
          ? `still placeholder content — doctrine${DOCTRINE_IS_PLACEHOLDER ? ' ✗' : ' ✓'}, text banks${TEXT_BANKS_ARE_PLACEHOLDER ? ' ✗' : ' ✓'}. Nothing should ship publicly until this is your writing (dossier §7.4).${nl}Oracle audit of the shipped lines: misfit ${placeholderAudit.misfit.rejected.length}/${placeholderAudit.misfit.total} rejected, forge ${placeholderAudit.forge.rejected.length}/${placeholderAudit.forge.total} rejected.`
          : 'both flags cleared',
    });

    if (sqlReport) {
      for (const c of sqlReport.checks) {
        list.push({
          id: c.id,
          label: c.label,
          status: c.ok ? 'pass' : 'fail',
          detail: c.detail,
        });
      }
    } else {
      list.push({
        id: 'sql.report',
        label: 'Schema report pasted back (triggers, indexes, RLS)',
        status: 'todo',
        detail: 'the app cannot see triggers or indexes — paste the SQL result below and this fills in',
      });
    }

    list.push({
      id: 'loop.verified',
      label: 'Decision loop verified on live data',
      status: verifyResult ? (verifyResult.status === 'verified' ? 'pass' : verifyResult.status === 'no_post_decisions' ? 'todo' : 'fail') : 'todo',
      detail: verifyResult ? verifyResult.detail : 'approve one item, then run the verification',
    });

    return list;
  }, [
    status,
    whoami,
    dbResult,
    storageResult,
    printifyResult,
    smokeResult,
    verifyResult,
    sqlReport,
    placeholderAudit,
  ]);

  const greenCount = checks.filter((c) => c.status === 'pass').length;
  const redCount = checks.filter((c) => c.status === 'fail').length;

  const copyReport = async () => {
    const lines: string[] = [
      'MEDIA ENGINE — SETUP REPORT',
      `generated: ${new Date().toISOString()}`,
      `checks: ${greenCount} pass / ${redCount} fail / ${checks.length - greenCount - redCount} pending`,
      '',
      'CHECKS',
      ...checks.map(
        (c) => `[${c.status.toUpperCase().padEnd(4)}] ${c.label}\n         ${c.detail.replace(/\n/g, '\n         ')}`,
      ),
    ];
    if (whoami) lines.push('', 'WHOAMI', JSON.stringify(whoami, null, 2));
    if (dbResult) lines.push('', 'DATABASE PROBE', JSON.stringify(dbResult, null, 2));
    if (storageResult) lines.push('', 'STORAGE PROBE', JSON.stringify(storageResult, null, 2));
    if (printifyResult) lines.push('', 'PRINTIFY PROBE', JSON.stringify(printifyResult, null, 2));
    if (smokeResult) lines.push('', 'SMOKE RENDER', JSON.stringify(smokeResult, null, 2));
    if (verifyResult) lines.push('', 'LOOP VERIFICATION', JSON.stringify(verifyResult, null, 2));
    if (runs) lines.push('', 'RECENT BATCH RUNS', JSON.stringify(runs, null, 2));
    if (status) lines.push('', 'DEPLOYMENT CONFIG FLAGS', JSON.stringify(status.config, null, 2));

    const ok = await copyText(lines.join('\n'));
    setNotice(ok ? 'Setup report copied — paste it wherever you need it.' : 'Copy failed; select the text manually.');
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 px-4 pb-24 pt-5">
      <header className="flex flex-col gap-2">
        <h1 className="text-lg font-bold tracking-wide">Setup</h1>
        <p className="text-sm text-neutral-400">
          Bring the engine up end to end, with live proof at every step. Nothing here is a mock:
          each button hits your real deployment and shows what came back.
        </p>
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-neutral-400">
              <span className="font-semibold text-emerald-400">{greenCount}</span> pass ·{' '}
              <span className="font-semibold text-rose-400">{redCount}</span> fail ·{' '}
              <span className="text-neutral-500">{checks.length - greenCount - redCount}</span> not run
            </span>
            <button
              type="button"
              onClick={() => void copyReport()}
              className="rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-800"
            >
              Copy setup report
            </button>
          </div>
          <ul className="mt-2 flex flex-col gap-1">
            {checks.map((c) => (
              <li key={c.id} className="flex items-start gap-2">
                <span className="mt-1.5">
                  <StatusDot status={c.status} />
                </span>
                <div className="min-w-0">
                  <p className="text-xs text-neutral-300">
                    {c.label}
                    {c.href && (
                      <>
                        {' '}
                        <Link href={c.href} className="text-emerald-400 underline underline-offset-2">
                          fix
                        </Link>
                      </>
                    )}
                  </p>
                  <p className="text-[11px] whitespace-pre-line break-words text-neutral-500">{c.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
        {notice && (
          <p role="status" className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200">
            {notice}
          </p>
        )}
        {status?.errors && Object.keys(status.errors).length > 0 && (
          <ul className="flex flex-col gap-1">
            {Object.entries(status.errors).map(([k, v]) => (
              <li key={k} className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                {k}: {v}
              </li>
            ))}
          </ul>
        )}
      </header>

      {/* 1 ── Sign in ------------------------------------------------------- */}
      <Section
        step="1"
        title="Sign in as the operator"
        subtitle="Everything else needs a session. This is the anon key — the service role never reaches the browser."
        state={session ? 'pass' : 'todo'}
      >
        <SignInPanel
          onNotice={(m) => setNotice(m)}
        />
        {whoami && (
          <div className="mt-4 flex flex-col gap-2">
            <p className="text-xs text-neutral-400">
              Paste your user id into <code className="font-mono text-neutral-300">GALLERY_WRITER_IDS</code> on the
              deployment (comma-separate if you keep more than one), then redeploy. This is the value that is
              genuinely annoying to find in the Supabase dashboard.
            </p>
            <CopyLine label="env" value={whoami.envLine} onCopied={(ok, l) => setNotice(ok ? `${l} copied` : 'Copy failed')} />
            <CopyLine label="user id" value={whoami.userId} onCopied={(ok, l) => setNotice(ok ? `${l} copied` : 'Copy failed')} />
            <p className="text-xs text-neutral-500">
              allowlist entries on this deployment: {whoami.allowlistCount} ·{' '}
              {whoami.inAllowlist ? (
                <span className="text-emerald-400">this account is allowlisted</span>
              ) : (
                <span className="text-amber-300">
                  this account is not allowlisted yet — probes below will 403 until the env var is set and redeployed
                </span>
              )}
            </p>
          </div>
        )}
      </Section>

      {/* 2 ── Database ------------------------------------------------------ */}
      <Section
        step="2"
        title="Database schema"
        subtitle="Walks every table the engine reads and writes, then tests the one jsonb filter nobody has ever verified live."
        state={dbResult ? (dbResult.database.ok ? 'pass' : 'fail') : 'todo'}
      >
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void runDbProbe()} busy={busy['probe-db']} disabled={!session}>
            Check the database
          </Button>
        </div>

        {dbResult && (
          <div className="mt-3 flex flex-col gap-3">
            <ul className="flex flex-col gap-1.5">
              {dbResult.database.tables.map((t) => (
                <li key={t.table} className="flex items-start gap-2 border-b border-neutral-800/60 pb-1.5">
                  <span className="mt-1.5">
                    <StatusDot status={t.ok ? 'pass' : t.required ? 'fail' : 'warn'} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-xs text-neutral-300">
                      {t.table}
                      {typeof t.count === 'number' && (
                        <span className="ml-2 text-neutral-500">{t.count} row(s)</span>
                      )}
                    </p>
                    <p className="break-words text-[11px] text-neutral-500">
                      {t.ok ? `created by ${t.createdBy}` : `${t.error ?? 'missing'} → run ${t.createdBy}`}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
            <p
              className={`rounded-lg border px-3 py-2 text-xs ${
                dbResult.database.jsonbFilter.ok
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                  : 'border-rose-500/30 bg-rose-500/10 text-rose-200'
              }`}
            >
              oracle_result-&gt;&gt;passed: {dbResult.database.jsonbFilter.detail}
            </p>
            <Notes warnings={dbResult.database.warnings} />
            {dbResult.bases.error && (
              <p className="text-xs text-rose-300">base asset count failed: {dbResult.bases.error}</p>
            )}
          </div>
        )}

        {/* The part the API cannot see */}
        <div className="mt-4 rounded-lg border border-neutral-800 bg-neutral-950 p-3">
          <h3 className="text-xs font-semibold tracking-widest text-neutral-500">SQL-ONLY CHECKS (READ-ONLY)</h3>
          <p className="mt-1 text-xs text-neutral-400">
            The REST API cannot see triggers, unique indexes or RLS. Run this in the Supabase SQL editor, then paste
            the JSON result here — the app reads it and fills in the checks above. It writes nothing.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              tone="secondary"
              onClick={() => void copyText(SCHEMA_REPORT_SQL).then((ok) => setNotice(ok ? 'SQL copied' : 'Copy failed'))}
            >
              Copy schema report SQL
            </Button>
            <Button
              tone="secondary"
              onClick={() =>
                void copyText(TRIGGER_PROOF_SQL).then((ok) =>
                  setNotice(ok ? 'Trigger proof SQL copied — an append-only error is the PASS' : 'Copy failed'),
                )
              }
            >
              Copy append-only proof SQL
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-neutral-500">
            The proof script inserts a probe row and then deletes it inside a transaction that is always rolled back.
            EXPECTED RESULT: an error saying <span className="font-mono">Table &quot;gallery_assets&quot; is append-only</span>.
            That error is the pass — anything else means the trigger is missing.
          </p>
          <textarea
            value={sqlPaste}
            onChange={(e) => applySqlPaste(e.target.value)}
            rows={4}
            placeholder='{"tables": {...}}'
            className="mt-2 w-full rounded-lg border border-neutral-800 bg-neutral-900 p-2 font-mono text-[11px] text-neutral-200 placeholder-neutral-600"
          />
          {sqlReport && (
            <div className="mt-2">
              {sqlReport.error ? (
                <p className="text-xs text-rose-300">{sqlReport.error}</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {sqlReport.checks.map((c: SqlCheck) => (
                    <li key={c.id} className="flex items-start gap-2">
                      <span className="mt-1.5">
                        <StatusDot status={c.ok ? 'pass' : 'fail'} />
                      </span>
                      <div>
                        <p className="text-xs text-neutral-300">{c.label}</p>
                        <p className="break-words text-[11px] text-neutral-500">{c.detail}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </Section>

      {/* 3 ── Storage ------------------------------------------------------- */}
      <Section
        step="3"
        title="Storage bucket"
        subtitle="media-engine — service-role write, public HTTPS read, then cleanup. This is the check that catches a private bucket before every render fails."
        state={storageResult ? (storageResult.storage.ok ? 'pass' : 'fail') : 'todo'}
      >
        <Button onClick={() => void runStorageProbe()} busy={busy['probe-storage']} disabled={!session}>
          Probe storage
        </Button>
        {storageResult && (
          <div className="mt-3">
            {stepTimeline(storageResult.storage.steps)}
            <Notes warnings={storageResult.storage.warnings} />
          </div>
        )}
      </Section>

      {/* 4 ── Renderer ------------------------------------------------------ */}
      <Section
        step="4"
        title="Render a real card"
        subtitle="Runs the production renderer end to end on a plain backdrop and shows you the result. This is the check no amount of static tracing could ever make."
        state={smokeResult ? (smokeResult.ok ? 'pass' : 'fail') : 'todo'}
      >
        <div className="flex flex-wrap gap-2">
          {(['misfit', 'forge'] as Brand[]).map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => setSmokeBrand(b)}
              aria-pressed={smokeBrand === b}
              className={`min-h-[44px] rounded-lg px-4 text-sm font-medium ${
                smokeBrand === b
                  ? 'bg-emerald-600 text-white'
                  : 'border border-neutral-700 bg-neutral-900 text-neutral-300'
              }`}
            >
              {b}
            </button>
          ))}
        </div>
        <input
          value={smokeText}
          onChange={(e) => setSmokeText(e.target.value)}
          placeholder={`Text to render (default: SETUP SMOKE TEST — ${smokeBrand})`}
          className="mt-3 w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-3 text-sm text-neutral-100 placeholder-neutral-600"
        />
        <div className="mt-2 flex flex-wrap gap-2">
          <Button onClick={() => void runSmoke()} busy={busy['smoke-render']} disabled={!session}>
            Render test card
          </Button>
          <p className="text-[11px] text-neutral-500">
            Writes one throwaway base + one card to Storage. Nothing is written to the gallery, the queue or the
            decision log.
          </p>
        </div>

        {smokeResult && (
          <div className="mt-3 flex flex-col gap-3">
            {smokeResult.finalUrl && (
              <a href={smokeResult.finalUrl} target="_blank" rel="noreferrer" className="block">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={smokeResult.finalUrl}
                  alt={`Smoke render for ${smokeResult.brand}`}
                  className="w-full rounded-lg border border-neutral-800"
                />
              </a>
            )}
            <p className="text-xs text-neutral-400">
              Requested typography: <span className="font-mono text-neutral-300">{smokeResult.typography.fontFamily}</span>{' '}
              · {smokeResult.typography.fontSize}px · weight {smokeResult.typography.fontWeight} · fill{' '}
              {smokeResult.typography.color} · scrim {smokeResult.typography.backgroundColor ?? 'none'} @{' '}
              {smokeResult.typography.opacity}
            </p>
            {smokeResult.finalUrl && (
              <CopyLine
                label="url"
                value={smokeResult.finalUrl}
                onCopied={(ok, l) => setNotice(ok ? `${l} copied` : 'Copy failed')}
              />
            )}
            {stepTimeline(smokeResult.steps)}
            <Notes warnings={smokeResult.warnings} />
          </div>
        )}
      </Section>

      {/* 5 ── Catalog ------------------------------------------------------- */}
      <Section
        step="5"
        title="Product catalog (Printify)"
        subtitle="One real search. A failure here is reported as CatalogUnavailableError and never silently becomes a paid AI generation."
        state={printifyResult ? (printifyResult.printify.ok ? 'pass' : 'fail') : 'todo'}
      >
        <div className="flex flex-wrap gap-2">
          <input
            value={printifyQuery}
            onChange={(e) => setPrintifyQuery(e.target.value)}
            className="min-w-[12rem] flex-1 rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-3 text-sm text-neutral-100"
          />
          <Button onClick={() => void runPrintify()} busy={busy['probe-printify']} disabled={!session}>
            Test search
          </Button>
        </div>
        {printifyResult && (
          <div className="mt-3 flex flex-col gap-2 text-xs">
            <p className={printifyResult.printify.ok ? 'text-emerald-200' : 'text-rose-200'}>
              {printifyResult.printify.ok
                ? `${printifyResult.printify.resultCount ?? 0} result(s) for "${printifyResult.query}" in ${printifyResult.printify.ms}ms`
                : printifyResult.printify.error}
            </p>
            {printifyResult.printify.sample && (
              <p className="break-words font-mono text-[11px] text-neutral-500">{printifyResult.printify.sample}</p>
            )}
            <Notes warnings={printifyResult.printify.warnings} />
          </div>
        )}
      </Section>

      {/* 6 ── Base assets --------------------------------------------------- */}
      <Section
        step="6"
        title="Give the lanes something to work with"
        subtitle="Fresh-text cards need atmosphere/art bases; recombination needs anything that is not a logo. With an empty gallery both lanes refuse to run — by design."
      >
        <div className="flex flex-col gap-2">
          {(['misfit', 'forge'] as Brand[]).map((b) => {
            const counts = dbResult?.bases.byBrand?.[b];
            return (
              <div key={b} className="rounded-lg border border-neutral-800 bg-neutral-950 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-neutral-200">{b}</span>
                  <span className="font-mono text-xs text-neutral-500">
                    {counts ? `${counts.freshTextBases} base / ${counts.recombinationBases} recomb` : '—'}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Link
                    href={`/gallery?brand=${b}&category=atmosphere`}
                    className="min-h-[44px] rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-3 text-xs text-neutral-200 hover:bg-neutral-800"
                  >
                    Upload {b} art →
                  </Link>
                  {armed[`bootstrap-${b}`] ? (
                    <Button tone="danger" onClick={() => void runBootstrap(b)} busy={busy['bootstrap-backdrop']}>
                      Tap again to write a backdrop into the permanent gallery
                    </Button>
                  ) : (
                    <Button
                      tone="secondary"
                      disabled={!session || !counts || counts.freshTextBases > 0}
                      onClick={() => setArmed((p) => ({ ...p, [`bootstrap-${b}`]: true }))}
                    >
                      {counts && counts.freshTextBases > 0 ? 'Backdrop not needed' : 'Create plain backdrop'}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {bootstrapResult && (
          <div className="mt-3 flex flex-col gap-2">
            <p className={bootstrapResult.ok ? 'text-xs text-emerald-200' : 'text-xs text-rose-200'}>
              {bootstrapResult.ok
                ? `Added ${bootstrapResult.assetId} as category atmosphere (source seed).`
                : bootstrapResult.error}
            </p>
            {bootstrapResult.assetUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={bootstrapResult.assetUrl}
                alt="Backdrop added to the gallery"
                className="w-40 rounded border border-neutral-800"
              />
            )}
            {stepTimeline(bootstrapResult.steps)}
            <Notes warnings={bootstrapResult.warnings} />
          </div>
        )}
      </Section>

      {/* 7 ── Batch --------------------------------------------------------- */}
      <Section
        step="7"
        title="Run a batch"
        subtitle="Claims the per-brand single-flight lock first. If a run is already live this refuses with 409 instead of corrupting rotation state."
      >
        <div className="flex flex-wrap gap-2">
          {(['misfit', 'forge'] as Brand[]).map((b) => (
            <Button
              key={b}
              onClick={() => void runBatch(b)}
              busy={busy[`batch-${b}`]}
              disabled={!session || !whoami?.inAllowlist}
            >
              Run {b} batch
            </Button>
          ))}
          <Button tone="secondary" onClick={() => void loadRuns()} busy={busy['runs']} disabled={!session}>
            Show recent runs
          </Button>
        </div>
        {!whoami?.inAllowlist && (
          <p className="mt-2 text-xs text-amber-300">
            Locked until this account is in GALLERY_WRITER_IDS (step 1).
          </p>
        )}
        {runs && (
          <div className="mt-3 flex flex-col gap-2">
            {runs.error ? (
              <p className="text-xs text-rose-300">
                {runs.error}
                {' '}— apply supabase/migrations/004_batch_runs.sql to get the lock and this run log.
              </p>
            ) : runs.runs.length === 0 ? (
              <p className="text-xs text-neutral-500">No batch runs recorded yet.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {runs.runs.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 border-b border-neutral-800/60 pb-1.5 text-xs">
                    <StatusDot status={r.status === 'done' ? 'pass' : r.status === 'error' ? 'fail' : 'warn'} />
                    <span className="font-mono text-neutral-300">{r.brand}</span>
                    <span className="text-neutral-500">{r.status}</span>
                    <span className="text-neutral-500">{r.queued ?? '—'} queued</span>
                    <span className="ml-auto text-neutral-600">{ago(Number(r.started_at))}</span>
                    {r.status === 'running' && (
                      <button
                        type="button"
                        onClick={() => void releaseRun(r.brand as Brand)}
                        className="rounded border border-rose-500/40 px-2 py-1 text-[11px] text-rose-300"
                      >
                        release
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <p className="mt-3 text-xs text-neutral-500">
          When the batch lands, review it on{' '}
          <Link href="/review" className="text-emerald-400 underline underline-offset-2">
            /review
          </Link>
          . Remember the toggle there — items the oracle rejected are hidden by default and are NOT lost.
        </p>
      </Section>

      {/* 8 ── Verify the loop ------------------------------------------------- */}
      <Section
        step="8"
        title="Verify the decision loop"
        subtitle="On your newest approved item: decision row → gallery row (same id) → queue closed → replay returns the same record → still exactly one gallery row."
        state={verifyResult ? (verifyResult.status === 'verified' ? 'pass' : verifyResult.status === 'no_post_decisions' ? 'todo' : 'fail') : 'todo'}
      >
        <Button onClick={() => void runVerify()} busy={busy['verify-loop']} disabled={!session}>
          Verify decision integrity
        </Button>
        <p className="mt-2 text-[11px] text-neutral-500">
          The replay step re-submits the same decision, which is the documented crash-recovery path: it cannot create a
          second decision, a second gallery row or a remix work order. That is precisely what is being verified.
        </p>
        {verifyResult && (
          <div className="mt-3 flex flex-col gap-2">
            <p
              className={`text-xs ${
                verifyResult.status === 'verified'
                  ? 'text-emerald-200'
                  : verifyResult.status === 'no_post_decisions'
                    ? 'text-neutral-400'
                    : 'text-rose-200'
              }`}
            >
              {verifyResult.detail}
            </p>
            {stepTimeline(verifyResult.steps)}
            <Notes warnings={verifyResult.warnings} />
          </div>
        )}
      </Section>

      <footer className="mt-2 flex flex-col gap-2 rounded-xl border border-neutral-800 bg-neutral-900/50 p-4 text-xs text-neutral-500">
        <p className="font-semibold text-neutral-400">What this page cannot do (and why)</p>
        <p>
          It cannot set your Vercel environment variables. Secrets belong in the deployment config, not in a web form
          that writes them into a database. Where a value has to be pasted there, this page shows it with a copy
          button.
        </p>
        <p>
          It cannot read Postgres triggers or indexes through the REST API, so those checks are copy-paste SQL with a
          parsed paste-back instead of a green tick that means nothing.
        </p>
        <p>
          It cannot tell you whether a card LOOKS right — that is the one judgement only you can make. Step 4 exists so
          you can make it in ten seconds.
        </p>
      </footer>
    </main>
  );
}
