# Misfit / Forge Media Engine

Autonomous dual-brand media command center. Every hour it generates a batch of
social posts (+ merch/ad concepts) for **Misfit Ministries** (8a–8p Central) and
**Forge Mode** (8p–8a Central), using free AI. You approve / reject / remix from
your phone; approved content deploys. It **learns your taste** and gets more
on-brand every time you touch it.

Stack: React 19 + Vite + Tailwind 4 + Zustand · Pollinations (free text+image AI)
· Supabase (sync) · Vercel Cron (autonomous generation) · ntfy.sh (phone push).

---

## What's new in this build

**1. Supabase is fully wired in — not just the cron.**
The app now pushes every generated batch, every approve/reject/remix decision,
and every taste signal up to Supabase, and pulls the autonomous cron batches
back down. Your phone and your browser see the same queue. If Supabase keys
aren't set, the app runs 100% local and simply doesn't sync — nothing breaks.

**2. Taste Memory (the reasoning core).**
`src/lib/tasteMemory.ts` is the memory-curator doctrine applied to content:
- **Nothing auto-deletes.** Every decision is a permanent event.
- **Deterministic first.** All taste scoring is pure code — no model decides.
- **LLM nominates, code decides.** The AI only ever *writes inside* the taste
  profile this code hands it.
- **Base confidence is never mutated;** effective confidence is computed at read
  time with weakest-link decay (thin evidence and contradiction both lower trust
  — symmetrical doubt) and recency weighting.

See the new **Taste Memory** tab to watch what it's learned per brand.

**3. Permanent images baked into the build.**
Drop image files into **`src/assets/brand/`** and they ship with every deploy as
locked reference/gallery images that also teach the taste memory. You never
re-upload them. Filename routing: `misfit-*` → Misfit, `forge-*` → Forge, anything
else → shared. (See `src/assets/brand/README.md`.)

---

## Setup

```bash
npm install
cp .env.example .env      # fill in Supabase keys (optional but recommended)
npm run dev
```

### Supabase (misfit-backend, ref seoguauzvvrefoupxgom)
1. Open the Supabase SQL editor and run `supabase/schema.sql` once.
2. Put your keys in `.env` (local) and in Vercel → Settings → Environment Variables:
   - Browser: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
   - Server/cron: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `CRON_SECRET`, `NTFY_TOPIC`

### Deploy (Vercel)
`vercel.json` already sets the build + the hourly cron (`0 * * * *`). Push the
repo, import in Vercel, add the env vars, deploy. The cron runs even when no
browser is open.

---

## How the pieces connect

```
              ┌─────────────── Vercel Cron (hourly) ───────────────┐
              │  api/cron.js: pick brand by hour → read taste from  │
              │  Supabase → generate on-taste batch → store + ntfy  │
              └───────────────────────┬────────────────────────────┘
                                      │  media_batches / taste_events
                                      ▼
   Browser / phone  ◄──────────  Supabase  ──────────►  Browser / phone
        │  approve / reject / remix                          ▲
        ▼                                                    │
   store.updateStatus() ── extract features ── taste_events ─┘  (append-only)
        │
        ▼
   tasteMemory.curate()  ──►  tasteDirective()  ──►  injected into next prompt
```

## Key files
- `src/lib/tasteMemory.ts` — deterministic taste curator (the memory + reasoning)
- `src/lib/supabaseClient.ts` / `src/lib/syncService.ts` — cloud sync
- `src/lib/permanentAssets.ts` — bakes `src/assets/brand/*` into the build
- `src/store/useStore.ts` — records decisions, seeds permanent gallery, hydrates cloud
- `src/services/aiService.ts` — generation (taste directive injected here)
- `src/config/brands.ts` — Misfit / Forge brand voices + schedule
- `api/cron.js` — autonomous hourly generation
- `supabase/schema.sql` — tables (run once)
```
