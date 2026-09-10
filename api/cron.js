// /api/cron — hourly on Vercel Cron. Picks the brand by Central-time hour
// (Misfit 8a–8p, Forge 8p–8a), reads the learned TASTE MEMORY from Supabase,
// generates an on-taste batch with free Pollinations AI, stores it, and pings
// your phone. Fully autonomous — no browser needed.

const POLLINATIONS_TEXT = 'https://text.pollinations.ai/openai';
const POLLINATIONS_IMAGE = 'https://image.pollinations.ai/prompt';
const PLATFORMS = ['TikTok', 'Facebook', 'Instagram', 'Twitter'];

const BRANDS = {
  misfit: {
    name: 'Misfit Ministries', emoji: '✝️',
    context: "Misfit Ministries — a bold, authentic Christian ministry for the broken, outcast, and those who don't fit in. Tone: raw, real, hopeful, street-savvy but full of grace. Scripture-based, never preachy.",
    focus: 'Reach people who feel like outcasts, addicts, the broken or forgotten. Mix scripture, street-level honesty and hope. Make it shareable.',
    imageStyle: 'faith-based ministry graphic, bold typography, urban gritty hopeful style',
  },
  forge: {
    name: 'Forge Mode', emoji: '🔨',
    context: 'Forge Mode — a one-person web design studio in Acadiana, LA (Dwayne Broussard). Custom sites live in ~24 hours, owned outright, no monthly fees, from $35, plus a 24/7 AI foreman. Tone: confident, local, plain-spoken.',
    focus: 'Write a scroll-stopping web-design ad. Angle: before/after rebuild, the $400-AI-builder pain, 24-hour turnaround, you-own-it/no-monthly, the 24/7 foreman, or a local Acadiana spotlight. End with: call (337) 296-4793.',
    imageStyle: 'sleek dark web design agency ad, device mockup, bold ember-orange accents, professional',
  },
};

function currentBrand(d = new Date()) {
  const h = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Chicago' }).format(d)) % 24;
  return h >= 8 && h < 20 ? 'misfit' : 'forge';
}

// ---- lightweight deterministic taste curator (mirrors src/lib/tasteMemory) ---
function tasteDirectiveFromEvents(events) {
  if (!events || !events.length) return '';
  const now = Date.now();
  const HALF_LIFE = 45 * 86400000;
  const map = new Map();
  for (const e of events) {
    const key = `${e.kind}:${String(e.value).toLowerCase()}`;
    const w = Math.pow(0.5, Math.max(0, now - new Date(e.at).getTime()) / HALF_LIFE);
    const p = map.get(key) || { kind: e.kind, value: e.value, a: 0, r: 0, wa: 0, wr: 0 };
    if (e.decision === 'approved') { p.a++; p.wa += w; }
    else if (e.decision === 'rejected') { p.r++; p.wr += w; }
    else { p.r++; p.wr += w * 0.5; }
    map.set(key, p);
  }
  const lean = [], avoid = [];
  for (const p of map.values()) {
    const tw = p.wa + p.wr; if (tw <= 0) continue;
    const n = p.a + p.r;
    const l = p.wa / tw;
    const base = Math.abs(l - 0.5) * 2;
    const thin = Math.min(1, n / 3);
    const contra = 1 - Math.min(p.a, p.r) / Math.max(1, n);
    const eff = base * thin * contra;
    const label = p.kind === 'hashtag' ? `#${p.value}` : p.value;
    if (l > 0.5 && eff >= 0.55) lean.push({ label, eff });
    else if (l < 0.5 && eff >= 0.55) avoid.push({ label, eff });
  }
  lean.sort((a, b) => b.eff - a.eff); avoid.sort((a, b) => b.eff - a.eff);
  const parts = [];
  if (lean.length) parts.push(`LEARNED TASTE — lean into: ${lean.slice(0, 6).map((x) => x.label).join(', ')}.`);
  if (avoid.length) parts.push(`AVOID (repeatedly rejected): ${avoid.slice(0, 6).map((x) => x.label).join(', ')}.`);
  return parts.length ? `\n[TASTE MEMORY] ${parts.join(' ')} Stay on-brand while honoring this.` : '';
}

async function callText(system, user) {
  const r = await fetch(POLLINATIONS_TEXT, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'openai', messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  });
  return await r.text();
}
function imageUrl(prompt) {
  const s = Math.floor(Math.random() * 99999);
  return `${POLLINATIONS_IMAGE}/${encodeURIComponent(prompt)}?width=1080&height=1080&seed=${s}&model=flux&nologo=true`;
}

async function makePost(b, platform, taste) {
  const system = `You are a copywriter for ${b.name}. ${b.context}\nWrite ONE ${platform} post. Return ONLY JSON: {"content":"...","hashtags":[".."],"imagePrompt":".."}`;
  let parsed = { content: `${b.name}`, hashtags: [], imagePrompt: b.imageStyle };
  try {
    const raw = await callText(system, `${b.focus}${taste}`);
    const m = raw.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]);
  } catch {}
  return { platform, content: parsed.content, hashtags: parsed.hashtags || [], imageUrl: imageUrl(`${parsed.imagePrompt}, ${b.imageStyle}`) };
}

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end('unauthorized');
  }
  const brandKey = currentBrand();
  const b = BRANDS[brandKey];

  // pull learned taste for this brand (best-effort)
  let taste = '';
  let supabase = null;
  try {
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      const { createClient } = await import('@supabase/supabase-js');
      supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data } = await supabase
        .from('taste_events').select('kind,value,decision,at')
        .eq('brand', brandKey).order('at', { ascending: false }).limit(2000);
      taste = tasteDirectiveFromEvents(data || []);
    }
  } catch (e) { console.error('taste', e); }

  const posts = await Promise.all(PLATFORMS.map((p) => makePost(b, p, taste)));
  const id = `cron-${Date.now()}`;
  const batch = {
    id, brand: brandKey, brand_name: b.name, hour_slot: new Date().getHours(),
    posts, created_at: new Date().toISOString(),
  };

  try {
    if (supabase) await supabase.from('media_batches').insert(batch);
  } catch (e) { console.error('supabase', e); }

  try {
    if (process.env.NTFY_TOPIC) {
      await fetch('https://ntfy.sh/' + process.env.NTFY_TOPIC, {
        method: 'POST', headers: { Title: `${b.name} — new batch`, Tags: 'sparkles' },
        body: `${posts.length} fresh ${b.name} posts ready to review.`,
      });
    }
  } catch (e) { console.error('ntfy', e); }

  res.status(200).json({ ok: true, brand: brandKey, count: posts.length, tasteApplied: Boolean(taste) });
}
