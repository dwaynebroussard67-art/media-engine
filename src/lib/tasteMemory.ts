// ============================================================================
// TASTE MEMORY — the reasoning core of the engine.
// ----------------------------------------------------------------------------
// This is the memory-curator doctrine applied to CONTENT taste. It watches what
// D approves, rejects, and remixes, and learns — deterministically — what the
// engine should lean into and what it should stop making. No LLM decides
// anything here. The LLM only ever GENERATES inside the profile this code hands
// it. ("LLM nominates, code decides.")
//
// LOCKED DOCTRINE (same rules as the memory curator):
//   1. NOTHING AUTO-DELETES. Every decision is a permanent event. A preference
//      is never erased; it is superseded when the evidence flips.
//   2. DETERMINISTIC FIRST. All scoring here is pure code. No model call.
//   3. LLM NOMINATES, CODE DECIDES. The generator proposes content; approval /
//      rejection is the only thing that moves taste, and this file decides how.
//   4. BASE CONFIDENCE IS NEVER MUTATED. Each signal keeps its raw weight.
//      Effective confidence is COMPUTED at read time (weakest-link decay).
//   5. SYMMETRICAL DOUBT. Thin evidence and contradicted evidence BOTH degrade
//      effective confidence — no asymmetry between "few samples" and "mixed".
//   6. TIME IS RECORDED, NOT GUESSED. Every event carries the real timestamp of
//      the decision. Recency weighting uses that, never a default "now".
//   7. VAULT RULE. The learned profile stays local/Supabase. It is never shipped
//      to the free text/image endpoints as anything but a distilled prompt line.
// ============================================================================

export type Decision = 'approved' | 'rejected' | 'remix';
export type FeatureKind = 'hashtag' | 'styleToken' | 'angle' | 'platform' | 'merchCategory' | 'phrase';
export type Brand = 'misfit' | 'forge';

// A single, permanent decision event. This is the append-only ledger.
export interface TasteEvent {
  id: string;
  brand: Brand;
  kind: FeatureKind;
  value: string;        // e.g. "#Khuba", "gritty", "before/after", "TikTok"
  decision: Decision;   // approved lifts, rejected drops, remix is a soft-drop
  at: number;           // real decision timestamp (ms)
  sourceId: string;     // post/merch id this came from (provenance)
}

// A learned preference, COMPUTED from events — never stored as ground truth.
export interface Preference {
  kind: FeatureKind;
  value: string;
  approvals: number;
  rejections: number;
  remixes: number;
  lastSeen: number;
  baseConfidence: number;      // raw, from evidence — NEVER mutated after compute
  effectiveConfidence: number; // decayed for thinness + contradiction + staleness
  verdict: 'lean-in' | 'neutral' | 'avoid';
}

export interface TasteProfile {
  brand: Brand;
  leanInto: Preference[];   // things D reliably approves — inject as "MORE of"
  avoid: Preference[];      // things D reliably kills — inject as "NEVER"
  computedAt: number;
  eventCount: number;
}

// ---- tunables (deterministic, auditable) -----------------------------------
const REMIX_WEIGHT = 0.5;      // a remix is a half-rejection (kept, but "not yet")
const THIN_EVIDENCE_FLOOR = 3; // below this many signals, confidence is throttled
const HALF_LIFE_DAYS = 45;     // recency half-life; old taste fades, never dies
const LEAN_THRESHOLD = 0.55;   // effectiveConfidence to count as "lean-in"
const AVOID_THRESHOLD = 0.55;  // effectiveConfidence (on the reject side) to avoid
const MAX_INJECT = 6;          // cap how many signals we push into a prompt

// ----------------------------------------------------------------------------
// Feature extraction: turn a piece of content into the signals we can learn on.
// Pure, deterministic tokenizing. No model.
// ----------------------------------------------------------------------------
const STYLE_TOKENS = [
  'gritty', 'raw', 'dark', 'cinematic', 'bold', 'urban', 'hopeful', 'fire',
  'chains', 'cross', 'scars', 'mud', 'iron', 'light', 'high contrast', 'sleek',
  'ember', 'device mockup', 'minimal', 'grunge', 'street', 'testimony',
];
const ANGLE_TOKENS = [
  'before/after', 'pain-hook', 'foreman', 'you own it', 'no monthly', 'spotlight',
  '24-hour', 'testimony', 'scripture', 'call to action', 'outcast', 'addiction',
];

export function extractFeatures(input: {
  platform?: string;
  content?: string;
  imagePrompt?: string;
  hashtags?: string[];
  merchCategory?: string;
}): Array<{ kind: FeatureKind; value: string }> {
  const out: Array<{ kind: FeatureKind; value: string }> = [];
  const hay = `${input.content ?? ''} ${input.imagePrompt ?? ''}`.toLowerCase();

  if (input.platform) out.push({ kind: 'platform', value: input.platform });
  if (input.merchCategory) out.push({ kind: 'merchCategory', value: input.merchCategory });
  for (const h of input.hashtags ?? []) out.push({ kind: 'hashtag', value: h.replace(/^#/, '').trim() });
  for (const t of STYLE_TOKENS) if (hay.includes(t)) out.push({ kind: 'styleToken', value: t });
  for (const a of ANGLE_TOKENS) if (hay.includes(a)) out.push({ kind: 'angle', value: a });

  // de-dupe
  const seen = new Set<string>();
  return out.filter((f) => {
    const k = `${f.kind}:${f.value.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Build the append-only events for one decision on one item.
export function eventsFromDecision(
  brand: Brand,
  decision: Decision,
  sourceId: string,
  features: Array<{ kind: FeatureKind; value: string }>,
  at: number = Date.now(),
  idFn: () => string = () => `${sourceId}-${Math.random().toString(36).slice(2, 9)}`
): TasteEvent[] {
  return features.map((f) => ({
    id: idFn(),
    brand,
    kind: f.kind,
    value: f.value,
    decision,
    at,
    sourceId,
  }));
}

// ----------------------------------------------------------------------------
// The curator: fold the permanent event ledger into a taste profile.
// DETERMINISTIC. Base confidence from evidence; effective confidence decayed for
// thin evidence, contradiction (symmetrical doubt) and staleness.
// ----------------------------------------------------------------------------
function recencyWeight(at: number, now: number): number {
  const days = Math.max(0, (now - at) / 86_400_000);
  return Math.pow(0.5, days / HALF_LIFE_DAYS); // 1.0 fresh → 0.5 at one half-life
}

export function curate(events: TasteEvent[], brand: Brand, now: number = Date.now()): TasteProfile {
  const brandEvents = events.filter((e) => e.brand === brand);
  const map = new Map<string, Preference & { _wApprove: number; _wReject: number }>();

  for (const e of brandEvents) {
    const key = `${e.kind}:${e.value.toLowerCase()}`;
    const w = recencyWeight(e.at, now);
    const p =
      map.get(key) ??
      ({
        kind: e.kind, value: e.value, approvals: 0, rejections: 0, remixes: 0,
        lastSeen: 0, baseConfidence: 0, effectiveConfidence: 0, verdict: 'neutral',
        _wApprove: 0, _wReject: 0,
      } as Preference & { _wApprove: number; _wReject: number });

    if (e.decision === 'approved') { p.approvals++; p._wApprove += w; }
    else if (e.decision === 'rejected') { p.rejections++; p._wReject += w; }
    else { p.remixes++; p._wReject += w * REMIX_WEIGHT; }

    p.lastSeen = Math.max(p.lastSeen, e.at);
    map.set(key, p);
  }

  const prefs: Preference[] = [];
  for (const p of map.values()) {
    const totalW = p._wApprove + p._wReject;
    const n = p.approvals + p.rejections + p.remixes;
    if (totalW <= 0) continue;

    // BASE confidence: how one-sided is the (recency-weighted) evidence. [0..1]
    // 0.5 = perfectly split, 1 = unanimous. This is NEVER mutated after this.
    const lean = p._wApprove / totalW;                 // 0..1 toward approve
    const baseConfidence = Math.abs(lean - 0.5) * 2;   // 0 split → 1 unanimous

    // EFFECTIVE confidence — weakest-link decay, symmetrical doubt:
    //   • thin evidence throttle  (few samples ⇒ trust less)
    //   • contradiction penalty   (mixed signals ⇒ trust less)
    //   • staleness               (already baked into recency-weighted counts)
    const thin = Math.min(1, n / THIN_EVIDENCE_FLOOR);
    const contradiction = 1 - Math.min(p.approvals, p.rejections + p.remixes) /
      Math.max(1, n); // 1 when clean, →0 when evenly contested
    const effectiveConfidence = baseConfidence * thin * contradiction;

    const verdict: Preference['verdict'] =
      lean > 0.5 && effectiveConfidence >= LEAN_THRESHOLD ? 'lean-in' :
      lean < 0.5 && effectiveConfidence >= AVOID_THRESHOLD ? 'avoid' : 'neutral';

    prefs.push({
      kind: p.kind, value: p.value, approvals: p.approvals, rejections: p.rejections,
      remixes: p.remixes, lastSeen: p.lastSeen,
      baseConfidence: round(baseConfidence), effectiveConfidence: round(effectiveConfidence), verdict,
    });
  }

  const byConf = (a: Preference, b: Preference) => b.effectiveConfidence - a.effectiveConfidence;
  return {
    brand,
    leanInto: prefs.filter((p) => p.verdict === 'lean-in').sort(byConf).slice(0, MAX_INJECT),
    avoid: prefs.filter((p) => p.verdict === 'avoid').sort(byConf).slice(0, MAX_INJECT),
    computedAt: now,
    eventCount: brandEvents.length,
  };
}

// ----------------------------------------------------------------------------
// The payoff: distill the profile into ONE prompt line the generator obeys.
// This is the only thing that ever leaves this module toward the model.
// ----------------------------------------------------------------------------
export function tasteDirective(profile: TasteProfile): string {
  if (profile.eventCount === 0) return '';
  const say = (p: Preference) => (p.kind === 'hashtag' ? `#${p.value}` : p.value);
  const lean = profile.leanInto.map(say);
  const avoid = profile.avoid.map(say);
  const parts: string[] = [];
  if (lean.length) parts.push(`LEARNED TASTE — lean into: ${lean.join(', ')}.`);
  if (avoid.length) parts.push(`AVOID (the operator has repeatedly rejected these): ${avoid.join(', ')}.`);
  if (!parts.length) return '';
  return `\n[TASTE MEMORY from ${profile.eventCount} past decisions] ${parts.join(' ')} Stay on-brand while honoring this.`;
}

function round(n: number) { return Math.round(n * 100) / 100; }
