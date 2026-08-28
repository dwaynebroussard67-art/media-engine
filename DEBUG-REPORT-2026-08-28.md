# MEDIA ENGINE — DEBUG PASS 2026-08-28

Full-repo debug. Baseline was **tsc clean + 48/48 tests green** — every bug below
passed the existing checks and only failed in real execution paths. All are now
fixed, pinned with tests, and verified.

**Verification (actual commands, actual results):**

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ clean, strict mode |
| `npm test` | ✅ **60/60** (48 original + 12 new regression tests) |
| `npm run build` | ✅ compiles, 8/8 pages generated (was: crashed) |
| `next start` smoke test | ✅ /gallery 200, /review 200, /api/batch 401/400 JSON as designed |

---

## 🔴 Bug 1 — Production build crashed prerendering `/gallery`

`src/app/gallery/page.tsx` created the Supabase browser client **at module scope**.
`next build` prerenders client pages, and with `NEXT_PUBLIC_SUPABASE_*` absent at
build time, `createClient(undefined, …)` threw `supabaseUrl is required` → build
exited 1 → **no deploy possible**.

**Fix:** lazy singleton (`browserClient()`), same pattern the review page already
used. Pinned by: `npm run build` passing.

## 🔴 Bug 2 — The daily cron could never fire (triple-broken)

`vercel.json` schedules `GET /api/batch?brand=misfit|forge`. Vercel cron sends:
HTTP **GET** (no body, no custom headers) and — when `CRON_SECRET` is set — an
automatic `Authorization: Bearer <CRON_SECRET>`. The route was:

1. POST-only → cron got **405**;
2. read brand from the JSON body only → `?brand=` ignored → would-be **400**;
3. only checked header `x-cron-secret` → Vercel's Bearer header rejected → **401**.

Net: no batch ever assembled by schedule, every day, silently.

**Fix:** `GET` (primary) + `POST` (manual alias); brand from query string first,
body fallback; secret accepted via `Authorization: Bearer $CRON_SECRET` **or**
`x-cron-secret`. A thrown JWT check now returns a logged 500 JSON instead of an
unhandled crash. Pinned by `tests/batchRoute.test.ts` (6 tests).

## 🔴 Bug 3 — Fresh-text rotation froze on the first base forever (regression)

The orchestrator passed `lastUsedFreshTextIndex ?? 0` into `generateFreshTextCard`.
The lane's contract: a **defined** index = test override → skip DB read **and**
skip `advanceLaneRotation`. So in production wiring the lane always used index 0
and never persisted — every batch re-rendered the same base forever. This is the
exact bug dossier §5.9 says was already fixed once; the `?? 0` reintroduced it.

**Fix:** pass `deps.lastUsedFreshTextIndex` through unchanged (`undefined` =
read/persist `lane_rotation_state`). Pinned by `tests/regressions.test.ts`.

## 🟡 Bug 4 — Merch `gallery_reuse` tier was unreachable dead code

Two compounding breaks:

- `findMerchandiseCandidate` called `findClosest(artAssets, { category: 'art' })`
  with **no tags** — `tagOverlapMatcher` returns `undefined` for tagless queries
  by contract;
- `rowToAsset` dropped the migration-002 `tags` column, so assets never carried
  tags anyway.

The strict hierarchy (gallery reuse → catalog → AI) silently degenerated to
catalog-or-AI, biasing every merch item toward the paid AI last resort.

**Fix:** sourcing derives query tags from `merchQuery` (lowercased word split);
`rowToAsset` carries `tags` via the documented row-boundary intersection type
(same assertion pattern tagMatcher already used). Frozen names/types untouched.
Pinned by `tests/sourcingTags.test.ts` (3 tests, real matcher end-to-end).

## 🟡 Bug 5 — Review UI never showed the merch badge / readable source

`queueItemToReviewItem` (page) and the ReviewItem reconstruction in
`/api/review/[id]` never mapped `merch_meta.source` → `merchSource`, and
`sourceDetail` was the raw `JSON.stringify` of the whole merch_meta blob — so
`ReviewCard`'s controlled merch-source badge could never appear. Dossier §5.16
explicitly requires merchSource/sourceDetail reconstructed from merch_meta.

**Fix:** both paths now map `merchSource` from `merch_meta.source` and
`sourceDetail` from `merch_meta.detail` (typed narrowing, falls back to omitting
the fields).

## 🟡 Bug 6 — Gallery uploads could double-fire into an append-only gallery

`handleFiles` kicked off `uploadOne(...)` **inside a `setQueue` state updater**.
React StrictMode double-invokes updaters → each dropped file could upload twice;
the gallery is append-only so a duplicate could never be removed.

**Fix:** pure updater; uploads fire outside it; queue length mirrored in a ref
for index math. Pinned by inspection + typecheck (behavioral StrictMode test
left as a manual check on the phone).

---

## 🧹 Hygiene

- `.gitignore`: added `.next/`, `next-env.d.ts`, `*.tsbuildinfo` (build artifacts
  were showing up untracked).
- `package.json`: added `"seed"` script (dossier Stage 3 step 6 says
  `npm run seed`; `tsx` was already a devDependency — seed.ts header said ts-node).
- `tsconfig.json`: `scripts/` now included in typecheck; Next's own required
  compiler options (set during build) committed to stop build-time churn.
- Stale comments corrected: sharpRenderer referenced the phantom `.scrim` field
  (dossier §0 rule 4); ReviewCard said buttons "stay disabled" while it re-enables.

## ⚠️ Still on D (live checks no model can do — dossier §7.5)

1. `oracle_result->>passed` jsonb filter against live Supabase (review GET).
2. One real sharp render end-to-end (fetch → composite → Storage → public URL).
3. One real Printify search with live keys.
4. Email-OTP login from the phone.
5. **Replace placeholder doctrine.ts + textBanks.ts content with your real voice.**
   Nothing ships under Misfit's name until that's your words.
