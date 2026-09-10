import { useMemo } from 'react';
import { useStore } from '../store/useStore';
import { BRANDS, type Brand } from '../config/brands';
import type { Preference } from '../lib/tasteMemory';
import { Brain, TrendingUp, Ban, Cloud, CloudOff } from 'lucide-react';

function ConfBar({ v, tone }: { v: number; tone: 'good' | 'bad' }) {
  const pct = Math.round(v * 100);
  return (
    <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
      <div
        className={`h-full ${tone === 'good' ? 'bg-emerald-500' : 'bg-red-500'}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function PrefRow({ p, tone }: { p: Preference; tone: 'good' | 'bad' }) {
  const label = p.kind === 'hashtag' ? `#${p.value}` : p.value;
  return (
    <div className="py-2">
      <div className="flex items-center justify-between text-sm">
        <span className="font-semibold text-slate-700 truncate">{label}</span>
        <span className="text-xs text-slate-400 ml-2 shrink-0">
          {p.approvals}✓ / {p.rejections + p.remixes}✕ · {Math.round(p.effectiveConfidence * 100)}%
        </span>
      </div>
      <div className="mt-1"><ConfBar v={p.effectiveConfidence} tone={tone} /></div>
      <div className="text-[10px] uppercase tracking-wide text-slate-300 mt-0.5">{p.kind}</div>
    </div>
  );
}

function BrandColumn({ brand }: { brand: Brand }) {
  const events = useStore((s) => s.tasteEvents);
  const getProfile = useStore((s) => s.getTasteProfile);
  const profile = useMemo(() => getProfile(brand), [getProfile, brand, events]);
  const b = BRANDS[brand];

  return (
    <div className="bg-white rounded-2xl border border-slate-100 p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-lg">{b.emoji}</span>
        <h3 className="font-black text-slate-800">{b.name}</h3>
      </div>
      <div className="text-xs text-slate-400 mb-4">
        Learned from {profile.eventCount} decision{profile.eventCount === 1 ? '' : 's'}
      </div>

      <div className="mb-5">
        <div className="flex items-center gap-1.5 text-emerald-600 font-bold text-xs uppercase tracking-wide mb-1">
          <TrendingUp size={13} /> Lean into
        </div>
        {profile.leanInto.length === 0 ? (
          <p className="text-sm text-slate-400 italic py-2">Nothing locked in yet — approve a few posts.</p>
        ) : (
          <div className="divide-y divide-slate-50">
            {profile.leanInto.map((p) => <PrefRow key={`${p.kind}:${p.value}`} p={p} tone="good" />)}
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center gap-1.5 text-red-600 font-bold text-xs uppercase tracking-wide mb-1">
          <Ban size={13} /> Avoid
        </div>
        {profile.avoid.length === 0 ? (
          <p className="text-sm text-slate-400 italic py-2">Nothing rejected enough to avoid yet.</p>
        ) : (
          <div className="divide-y divide-slate-50">
            {profile.avoid.map((p) => <PrefRow key={`${p.kind}:${p.value}`} p={p} tone="bad" />)}
          </div>
        )}
      </div>
    </div>
  );
}

export function MemoryPanel() {
  const cloudSynced = useStore((s) => s.cloudSynced);
  const directive = useStore((s) => s.getTasteDirective());

  return (
    <div>
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-600 to-purple-600 flex items-center justify-center shadow">
          <Brain size={20} className="text-white" />
        </div>
        <div>
          <h1 className="text-2xl font-black text-slate-800">Taste Memory</h1>
          <p className="text-sm text-slate-400">What the engine has learned from your approvals & rejections.</p>
        </div>
      </div>

      <div className="flex items-center gap-1.5 text-xs font-semibold mb-6">
        {cloudSynced ? (
          <span className="inline-flex items-center gap-1 text-emerald-600"><Cloud size={13} /> Synced with Supabase</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-slate-400"><CloudOff size={13} /> Local memory (set Supabase keys to sync)</span>
        )}
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <BrandColumn brand="misfit" />
        <BrandColumn brand="forge" />
      </div>

      <div className="mt-6 bg-slate-900 text-slate-100 rounded-2xl p-5">
        <div className="text-[10px] uppercase tracking-widest text-slate-400 mb-2">
          Live directive injected into the next generation
        </div>
        <code className="text-xs whitespace-pre-wrap break-words text-emerald-300">
          {directive || '— no learned taste yet; generation runs on brand defaults —'}
        </code>
      </div>

      <p className="mt-4 text-xs text-slate-400 leading-relaxed max-w-2xl">
        Nothing here is ever deleted. Every approve, reject, and remix is a permanent signal.
        The engine reasons over that history deterministically — thin or contradicted evidence is
        trusted less — and the model only ever writes <em>inside</em> the taste this panel decides.
      </p>
    </div>
  );
}
