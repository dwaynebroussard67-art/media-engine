# HANDOFF — Misfit / Forge Media Engine (Media Strike build)

**Status: complete and building clean** (`npm run build` → ✓, 2177 modules).
This is the strongest of the uploaded engines (`misfit-forge-media-engine`),
hardened with Supabase sync, a deterministic taste-memory core, and a permanent
image system.

## Done in this pass
- ✅ Picked the best base (App B). App A was a bare shell; discarded.
- ✅ **Supabase wired end-to-end** — client (`supabaseClient.ts`), sync layer
  (`syncService.ts`), store push/pull, cloud hydrate on boot. Graceful no-op
  when keys are absent.
- ✅ **Taste Memory** (`tasteMemory.ts`) — append-only decision ledger →
  deterministic curator → prompt directive. Doctrine locked: nothing
  auto-deletes, deterministic-first, LLM-nominates/code-decides, base confidence
  never mutated, weakest-link effective confidence, symmetrical doubt, recency
  half-life. Injected into both the app generator and the cron.
- ✅ **Memory tab** (`MemoryPanel.tsx`) — see lean-into / avoid per brand + the
  live directive.
- ✅ **Permanent images** (`permanentAssets.ts`) — drop files in
  `src/assets/brand/`, they bake into the build (verified: inlined into the
  single-file output). Locked in the gallery, can't be deleted, feed taste.
- ✅ **Cron upgraded** — reads taste from Supabase, generates on-taste, stores,
  pings phone.
- ✅ `supabase/schema.sql`, `.env.example`, README updated.

## What YOU do next (in order)
1. **Drop your images** into `src/assets/brand/` (name them `misfit-*` /
   `forge-*` to route them). This is the part you're sending pictures for —
   just add the files, rebuild, done. No re-uploading ever again.
2. **Run** `supabase/schema.sql` in the Supabase SQL editor (project
   misfit-backend, ref `seoguauzvvrefoupxgom`).
3. **Set env vars** in Vercel (see `.env.example`): `VITE_SUPABASE_URL`,
   `VITE_SUPABASE_ANON_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`,
   `CRON_SECRET`, `NTFY_TOPIC`.
4. **Deploy** to Vercel. Cron fires hourly on its own.

## Still open / not built (was already pending pre-this-pass)
- **Stripe + Printify wiring** for actually publishing approved merch — the
  approve action records taste + status but doesn't yet push to a print
  provider. That's the next real feature.
- **Auto-posting** to TikTok/FB/IG/Twitter — currently approve = queued locally.
  Real platform posting needs each platform's API token (see the design notes in
  `Media-generator1.txt` for the scheduler sketch).
- Taste memory currently learns from text/hashtag/category/style-token features.
  Adding image-embedding similarity (learn from the *look* of approved images)
  is a strong future upgrade.

## Doctrine reminder (don't let a future AI violate these)
Nothing auto-deletes · deterministic exhausts before any model call · the model
never edits memory, only proposes content · base confidence is provenance and is
never overwritten · the gauntlet/vault rule still applies to any adversarial
corpus. Misfit Ministries is the mission; Forge Mode rides second.
