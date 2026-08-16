# MEDIA ENGINE — FINDINGS & FIXES
Prepared 2026-08-16, from a full teardown of the repo on branch `arena/01a00b16-media-engine`.

**Bottom line:** the Stage-2 code held up as claimed (`tsc --noEmit` clean, 48/48
vitest tests green), but the engine could not actually *run*: `next build`
failed, the Vercel cron entry point could never work, lane rotation was pinned
to index 0 in production, the merch gallery-reuse path was dead code, and the
UI had no stylesheet. All of it is now fixed, tested, and exercised live
end-to-end against a real PostgreSQL engine.

---

## 0. WHAT WAS VERIFIED AND HOW (no unexecuted claims)

| Check | Command | Result |
|---|---|---|
| TypeScript strict | `npx tsc --noEmit` | clean (src + tests + scripts + dev) |
| Unit/integration tests | `npm test` | 69/69 green (48 original + 21 new) |
| SQL layer | `npm run verify:schema` (PGlite = real PostgreSQL 18.3, runs `supabase/schema.sql` + migrations 001–003 and asserts the invariants) | 23/23 checks pass |
| Production build | `npm run build` | passes, all 9 routes emitted |
| Cron batch, render, review, decisions | live run against the bundled local Supabase shim (`dev/local-supabase/shim.ts`) | full loop exercised, details in §4 |

The dossier's "known must-check" items that are now **resolved**:
`oracle_result->>passed = 'true'` jsonb filter — verified against real Postgres;
one real sharp render end-to-end (fetch → composite → webp → Storage upload →
public URL) — verified pixel-level (§4.4).

---

## 1. THINGS THAT WERE NOT RIGHT (found & fixed)

### 1.1 `next build` FAILED — the repo did not build at all
`src/app/gallery/page.tsx` called `createClient(NEXT_PUBLIC_SUPABASE_URL!, …)`
at module scope. During prerender, with env unset, supabase-js throws
`supabaseUrl is required` → **build exits 1**. That was the very first
production blocker.
**Fix:** lazy client construction, SSR-safe, with a graceful "not configured"
banner instead of a crash (same treatment in `src/app/review/page.tsx`, which
would have thrown inside `useEffect`).

### 1.2 The cron entry point could never work — three stacked failures
Vercel cron jobs (vercel.json `crons`) fire **HTTP GET**, with the
`CRON_SECRET` env var sent automatically as `Authorization: Bearer <secret>`.
The batch route only exported POST, only accepted a custom `x-cron-secret`
header, and read `brand` from the JSON body while vercel.json passed it as a
query string. Every scheduled run would have died 405 → 401 → 400.
**Fix:** `src/app/api/batch/route.ts` now exports GET (cron) and POST (manual),
accepts `Authorization: Bearer <CRON_SECRET>` plus the legacy `x-cron-secret`
header, resolves brand from body → query → **both brands** (one cron entry
covers everything), and `vercel.json` is now a single cron entry at
`/api/batch`. Verified live: wrong secret → 401, right secret → 6 items queued.

### 1.3 Fresh-text lane rotation was pinned to index 0 in production
`assembleReviewBatch` passed `lastUsedIndex: deps.lastUsedFreshTextIndex ?? 0`.
`lastUsedIndex` is a **test-only override** — supplying it skips the persisted
`lane_rotation_state` read AND advance. So every production batch would
re-render base index 0 forever (the exact bug class the dossier says was fixed
once already). `lastUsedRecombinationIndex` was declared but never passed
anywhere.
**Fix:** overrides pass through **only when defined**; `generateRecombinationPost`
gained the same optional override (skips `rotation_state` when supplied), so
the orchestrator honors both deps symmetrically. Pinned by tests and verified
live: two consecutive batches used different bases and different text lines.

### 1.4 Merch "gallery reuse" (hierarchy level 1) was structurally dead
Two independent gaps:
- `AssetStore.list()` dropped the `tags` column (migration 002), so the
  tag-overlap matcher always saw `undefined` tags — it could never match
  anything, and every merch candidate skipped straight to catalog/AI.
- The orchestrator passed **no query tags** to the matcher (`findClosest` was
  called with `{ category: 'art' }` only), and the tag matcher returns
  undefined with zero query tags.
**Fix:** `GalleryAsset` gained an optional `tags` field (additive — no frozen
name touched); the store maps it both directions; the orchestrator derives
query tags from the merch query (`deriveMerchQueryTags('misfit tee') →
['misfit','tee']`); and the reuse detail string now carries the required
**"tag overlap"** label wherever the confidence surfaces. Verified live: the
merch lane resolved via `gallery_reuse` with confidence 1.00.

### 1.5 `merchSource` was dropped everywhere → merch badge could never render
`review/[id]/route.ts` and `review/page.tsx` both reconstructed ReviewItems
without `merchSource` from `merch_meta`, so `ReviewCard`'s merch badge had no
data. **Fix:** one shared, tested mapper `src/lib/review/queueRow.ts`
(validates enum values, safe defaults for garbage rows), used by both.

### 1.6 UI shipped with no stylesheet at all
`ReviewCard`, the gallery page, and the layout use Tailwind utility classes,
but Tailwind was never installed or imported — the review cards would render
as unstyled markup and the gallery's file input (class `hidden`) would be
visible. **Fix:** Tailwind v4 (`@tailwindcss/postcss` + `src/app/globals.css`
imported by the root layout).

### 1.7 Root route 404'd
There was no `src/app/page.tsx` — `/` returned 404. **Fix:** added a small
landing page linking to Review and Gallery.

### 1.8 Tooling gaps
- Dossier go-live step 6 says `npm run seed`, but **no `seed` script existed**
  and `scripts/seed.ts` documented `ts-node` (not installed). **Fix:** added
  `"seed": "tsx scripts/seed.ts"` (tsx is already a devDependency).
- `.gitignore` didn't ignore `.next/` or `*.tsbuildinfo`. Fixed.
- Missing-env failures were untyped `Missing required env var` 500s. **Fix:**
  new typed `SupabaseNotConfiguredError`; gallery / batch / review routes map
  it to a clear **503**.

### 1.9 New verification & dev tooling (additive)
- `scripts/verify-schema.ts` + `npm run verify:schema` — runs the real schema
  + migrations on embedded PostgreSQL and asserts every DB invariant (append-
  only triggers, unique finality gate, jsonb filter, check constraints).
- `dev/local-supabase/shim.ts` + `npm run shim -- --seed-demo` — a local
  Supabase shim (PostgREST-style REST + Storage + email-OTP auth) over PGlite,
  so the whole engine runs offline end-to-end. Clearly labeled dev-only, never
  to be deployed. `next.config.ts` rewrites and `NEXT_PUBLIC_MEDIA_HOST_REWRITE`
  are env-gated — production builds are untouched when the vars are absent.

---

## 2. WHAT WAS LEFT ALONE, DELIBERATELY

- **Decision-handler ordering & idempotent replay** (Section 3 of the dossier)
  — unchanged; all six pinned tests still green, and the live demo reproduced
  every behavior.
- **Frozen names** (Section 6) — nothing renamed; `GalleryAsset.tags` is an
  additive optional field, not a rename.
- **Doctrine + text banks** — still the model-written placeholders. The oracle
  now correctly flags them (see §4.5); D must replace them with his voice
  before anything ships.
- **Append-only triggers / schema** — untouched; verified rather than changed.

## 3. OBSERVATIONS (not fixed — D's call)

1. **Concurrent text-bank picks can repeat a line.** Both generation lanes read
   `text_rotation_state` (keyed by brand) simultaneously, so a batch's two
   cards can carry the same line (observed live). Harmless, but if distinct
   lines per batch matter, the bank rotation would need per-lane scopes like
   `lane_rotation_state` already has.
2. **Printify client remains live-unverified** — no real API key was available.
   The failure path is exercised: any outage surfaces as
   `CatalogUnavailableError` and never auto-falls through to AI. Worth one
   real search before go-live (dossier Stage 3 item 5).
3. **Email OTP session persistence** on the phone depends on Supabase project
   settings — unchanged from the dossier's accepted limitation.

## 4. WHAT THE LIVE RUN PROVED (local shim, real PostgreSQL, real sharp)

1. **Cron batch**: GET `/api/batch` with `Bearer CRON_SECRET` → both brands,
   all three lanes `ok`, 6 items queued; second run advanced base images and
   text lines (rotation persistence works).
2. **Oracle**: all lane items passed; batch 2's 17-word fresh-text card without
   a voice keyword was flagged `theology_absence_in_long_text` and correctly
   excluded from the default review view (`includeRejected=true` shows it).
3. **Auth chain**: no token → 401; garbage token → 401; demo JWT → allowed
   (allowlist check honored).
4. **Sharp render E2E**: fetched base → composited SVG text layer (scrim +
   `#FFFFFF` glyphs) → webp 1080×1080 → Storage upload → public URL served.
   Pixel check confirmed 883 near-white text pixels over the base image.
5. **Decisions**: `post` → decision row + `approved_post` gallery asset with
   matching id; replay → same record (idempotent); different decision → 409
   `already_decided` with both decisions; `remix` → single `remix_queue`
   work order; PATCH/DELETE on gallery → 405.
6. **Gallery upload**: multipart POST with demo JWT → storage file + gallery
   row with `source: seed`.

## 5. REMAINING FOR D (his hands only)

1. Run `supabase/schema.sql` + migrations 001→002→003 in misfit-backend
   (or trust the local verification — they're proven against real Postgres).
2. Create the public `media-engine` Storage bucket; set Vercel env vars
   (note: `CRON_SECRET` is now consumed the way Vercel sends it).
3. Replace `doctrine.ts` prose/keywords and `textBanks.ts` lines with real copy.
4. One live Printify search; one email-OTP login from the phone.
5. `npm run seed -- --manifest <path>` with the starting imagery.
6. First cron → review on phone → first Post → confirm id linkage.
