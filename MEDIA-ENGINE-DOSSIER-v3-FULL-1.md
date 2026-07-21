# MEDIA ENGINE — DOSSIER v3 FULL (post-Stage-2)
Prepared 2026-07-20. Paste this entire document as context for any model working on this
system. The verified codebase exists as `media-engine-stage2-verified.zip` on D's device —
strict `tsc --noEmit` clean, 48/48 vitest tests green. You will NOT have the code files;
this dossier is your only ground truth. Do not invent contents for files described here;
build against the interfaces exactly as written.

---

## 0. OPERATING RULES FOR THE BUILDING MODEL

1. **Do not claim "production-ready" or "compile-clean" for code you have not executed.**
   Every delivery in this project that made that claim without running the code failed on
   first `tsc`. If you cannot run code, say "unverified — traced by hand" and list what
   must be checked and how.
2. **Do not rename anything in Section 6 (FROZEN NAMES).** Env vars, table names, exported
   functions, and error classes are frozen. Prior sessions renamed things between rounds
   and broke consistency (e.g. GALLERY_WRITER_IDS vs GALLERY_UPLOADER_IDS — the frozen
   name is `GALLERY_WRITER_IDS`).
3. **Do not change the decision-handler ordering or the idempotent-replay design**
   (Section 3). It was arrived at after three flawed iterations; the reasoning is recorded
   there so you don't relitigate it. Any change that breaks a reviewQueue test is wrong by
   definition.
4. **Never access fields you have not seen defined.** A prior delivery accessed
   `.font/.size/.scrim` on the typography config behind a `Record<string, unknown>` cast;
   the fields didn't exist and every render silently fell back to defaults. If this dossier
   doesn't give you a field, it doesn't exist — say so instead of guessing.
5. **All new code: TypeScript strict mode; typed error classes for every failure mode; no
   silent catches; no `any` except at Supabase row boundaries.**
6. **Deliver complete files, one per code block, with the file path as the first comment
   line.** No fragments, no "rest unchanged", no prose-interleaved snippets. D extracts
   code mechanically.

---

## 1. WHAT THE SYSTEM IS

Media Engine is a governed content pipeline for two brands — `misfit` (Misfit Ministries /
Misfit Psych Ward: faith-based, scripture-anchored, survival-witness voice) and `forge`
(Forge Mode: maker/craft voice). It generates social post candidates and merch candidates,
gates them through a cheap deterministic oracle, and presents them to D (the sole human
operator) for a three-option decision: **Post / Remix / Reject**.

Governance pattern: Reader/Oracle/Overseer. D is final ground truth. Refuse-rather-than-err.
Silent failure is forbidden everywhere — every error surfaces typed, or is visibly logged
with a reason.

Core invariants (enforced in application code AND at the Postgres layer — never weaken
either layer; defense in depth is deliberate):

- **The gallery is append-only.** No update, no delete, ever. The `reject_mutation()`
  trigger blocks UPDATE/DELETE on `gallery_assets` and `media_decisions` at the DB level.
- **Decisions are append-only and final.** One decision per item, enforced by a UNIQUE
  index on `media_decisions.item_id`. Same-decision resubmission is an idempotent replay,
  not an error (Section 3). Different-decision resubmission is a typed violation.
- **Merch sourcing hierarchy is strict:** gallery reuse → catalog search → AI touch-up.
  AI touch-up is a deliberate, cost-incurring LAST resort. A catalog OUTAGE (the client
  throws) raises `CatalogUnavailableError` and never auto-falls-through to AI. Empty
  catalog RESULTS (search worked, found nothing) legitimately fall through to AI touch-up.
- **Every approved item enters the gallery with full provenance** (source, template link,
  timestamps, decision linkage via shared id).
- **The oracle is deterministic** — no LLM calls, no network calls in the oracle path.

Explicitly OUT of scope (do not build, do not scaffold): ensemble generators
(FLUX/SDXL/etc.), vision-model scoring, taste curator, MPX container, video, storefront
handoff to The Hall (for now, "logging is the handoff").

Stack: Next.js App Router on Vercel, Supabase (project: misfit-backend) for Postgres +
Storage + Auth, TypeScript strict, vitest, sharp for image compositing. D develops on a
Samsung S25 Ultra via Termux and operates the review UI from that phone.

---

## 2. HISTORY IN ONE PARAGRAPH (so you know why things are the way they are)

Stage 1 was built by three parallel model sessions, merged, refactored, then independently
verified and patched (auth allowlist, catalog-outage invariant, finality unique index, safe
modulo, lazy Supabase init). Stage 2 (text banks, renderer, fresh-text lane, tag matcher,
Printify client, orchestrator, review API + UI, seed script) was built from a dossier like
this one and then verified; that verification caught a phantom-field renderer bug, a
never-persisted rotation pointer, an interface-import break, and missing config plumbing —
all fixed and pinned with tests. Lesson embedded in the rules above: unexecuted claims of
correctness have been wrong every single time.

---

## 3. THE DECISION HANDLER DESIGN (settled — do not relitigate)

`handleReviewDecision(item, decision): Promise<DecisionRecord>` in
`src/lib/review/reviewQueue.ts`.

Three orderings were tried across sessions. Recorded so the next model doesn't repeat them:

- **Side-effects-first** (REJECTED): two concurrent handlers can both pass the pre-check
  and both run side effects before the unique index arbitrates. With contradictory
  decisions (post vs remix), both effects land — and the gallery is append-only, so the
  wrong one can never be removed.
- **INSERT-first with a hard finality gate** (REJECTED): correct for races, but a crash
  between the decision INSERT and the side effect leaves a decision that says "post" with
  no gallery entry, and the gate blocks every retry. Permanent desync; the proposal's own
  "safe on retry" comment described unreachable code.
- **INSERT-first + idempotent replay** (CURRENT):
  1. `getExistingDecision(item.id)` — if a record exists with the SAME decision, this call
     is a replay: complete any missing side effects idempotently, close the queue row, and
     return the original record (crash recovery = just retry the same call). If it exists
     with a DIFFERENT decision, throw `FinalityViolationError{itemId, requested, existing}`.
  2. Otherwise INSERT the decision record — `galleryEntryId` (= item.id when decision is
     'post') is written IN the INSERT; no UPDATE of media_decisions ever occurs. The
     UNIQUE index is the authoritative gate: on 23505, re-fetch the winner; same decision →
     resolve idempotently, different → typed violation with ZERO side effects fired for
     the loser.
  3. Side effects run only after a successful INSERT (or during replay). All idempotent:
     `onPostApproved` absorbs `DuplicateAssetError`; the remix enqueue treats 23505 on
     `remix_queue.original_item_id` UNIQUE as success. A genuine remix-enqueue failure
     throws — safe, because retrying the same call resumes at the side effect.
  4. The review_queue status update is non-fatal (media_decisions is the source of truth;
     a stale queue row self-corrects on replay).

Tests in `tests/reviewQueue.test.ts` pin all six behaviors: plain post with gallery write;
different-decision violation; same-decision crash replay completing the missing side
effect; both outcomes of the 23505 race; remix single-enqueue under replay.

---

## 4. DATABASE (supabase/schema.sql + migrations 001–003; all applied together)

- `gallery_assets` (append-only; trigger blocks UPDATE/DELETE):
  `id text pk`, `url text check (url ~ '^https?://')`, `brand` in (misfit, forge, shared),
  `category` in (logo, apparel, art, atmosphere, approved_post), `for_sale bool default
  false`, `source` in (seed, generated_and_approved), `original_template_id text`,
  `added_at bigint`, `permanent bool default true check (permanent = true)`,
  `tags text[] not null default '{}'` (added by migration 002; GIN indexed).
  Index on (brand, category).
- `rotation_state` (mutable by design; one row per brand; used by the recombination lane):
  `brand pk` in (misfit, forge), `last_used_asset_id text`, `last_used_index int`,
  `updated_at bigint`.
- `text_rotation_state` (migration 002; used exclusively by the text bank):
  `brand text pk`, `last_used_index int default -1`, `updated_at bigint`.
- `lane_rotation_state` (migration 003; generic per-scope pointers so lanes never share or
  skip rotation state): `scope text pk` with convention `'<lane>:<brand>'` (e.g.
  `fresh_text_card:misfit`), `last_used_index int default -1`, `updated_at bigint`.
- `review_queue` (staging; status transitions pending → decided only):
  `id uuid pk`, `batch_id uuid`, `brand` in (misfit, forge), `lane text`, `image_url text`,
  `source_data jsonb`, `oracle_result jsonb`, `merch_meta jsonb`, `queued_at bigint`,
  `status` in (pending, decided) default pending, `decided_at bigint`.
  Index on (brand, status, queued_at asc).
- `media_decisions` (append-only; trigger-protected):
  `id uuid pk`, `item_id text` with **UNIQUE index (the authoritative finality gate)**,
  `decision` in (post, remix, reject), `brand`, `lane`, `oracle_result jsonb`,
  `gallery_entry_id text` (written at INSERT, never backfilled), `decided_at bigint`.
- `remix_queue`: `id uuid pk default gen_random_uuid()`, `original_item_id text` with
  **UNIQUE index** (one remix work order per item, ever; 23505 = idempotent success),
  `brand`, `lane`, `queued_at bigint`, `reason text`, `processed bool default false`.
  Partial index on (brand, processed, queued_at) where processed = false.

Migration discipline: migrations are ADDITIVE ONLY and must never touch the append-only
triggers.

---

## 5. MODULES — EXACT INTERFACES (everything below exists and compiles)

### 5.1 `src/types/media.ts`
```
Brand = 'misfit' | 'forge'
AssetBrand = Brand | 'shared'
AssetCategory = 'logo'|'apparel'|'art'|'atmosphere'|'approved_post'
AssetSource = 'seed'|'generated_and_approved'
GalleryAsset { id, url, brand: AssetBrand, category, forSale, source,
               originalTemplateId?, addedAt: number, permanent: true }   // all readonly
GenerationLane = 'fresh_text_card'|'recombination'|'procedural'|'ai_touchup'
RenderedItem { id, imageUrl, brand: Brand, generationLane, templateId?,
               sourceData: Record<string,unknown>, createdAt }
ReviewDecision = 'post'|'remix'|'reject'
MerchSourceType = 'gallery_reuse'|'catalog_search'|'ai_touchup'
OracleResult { passed: boolean, reasons: string[], checkedAt: number }
ReviewItem extends RenderedItem { oracleResult, merchSource?, sourceDetail? }
MerchCandidate { source, asset?, productUrl?, baseProduct?: unknown,
                 needsDesignOverlay?, detail }
DecisionRecord { id, itemId, decision, decidedAt, brand, lane, oracleResult,
                 galleryEntryId? }
AssetFilter { brand?: AssetBrand, category?: AssetCategory }
```
`baseProduct` is `unknown` — narrow it explicitly before any property access.

### 5.2 `src/config/doctrine.ts`
`DOCTRINE[brand] = { theology: string, voiceKeywords: string[], forbiddenKeywords:
string[] }`. misfit forbidden: hustle, grind, motivate, positivity, blessed. forge
forbidden: hustle, passion, dream, manifest, vibe.
`BRAND_TYPOGRAPHY[brand]: BrandTypographyStyle` with EXACTLY these fields:
`{ fontFamily: string, fontSize: number, fontWeight: number, color: string,
backgroundColor: string | null, opacity: number, padding: number }`.
There is no `.font`, `.size`, or `.scrim` — a prior draft invented those and silently
broke rendering; a regression test now pins the real names.
`THEOLOGY_REQUIRED_LANES = ['fresh_text_card','recombination']`;
`THEOLOGY_WORD_COUNT_THRESHOLD = 10`.
**ALL doctrine prose and keyword lists are MODEL-WRITTEN PLACEHOLDERS.** D must replace
them with his actual brand voice before any generated content ships. Flag this in any
delivery touching these files.

### 5.3 `src/config/textBanks.ts`
Per-brand string arrays of post lines. Placeholder content, same replacement rule.

### 5.4 `src/lib/supabaseClient.ts`
- `getSupabaseAdmin(): SupabaseClient` — lazy singleton over the service-role key. Env is
  read at first CALL, not at import, so test files import freely with no env set.
- `verifyUserJwt(token): Promise<{id, email?} | null>` — anon-key client scoped to the
  bearer token; `auth.getUser()`. The service-role key must NEVER be used for JWT
  validation (it bypasses auth).
- `_resetSupabaseAdminForTesting()` — test isolation only.
- Env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`.

### 5.5 `src/lib/permanentAssets.ts`
- `class DuplicateAssetError extends Error { assetId }` — mapped from Postgres 23505.
- `interface AssetStore { get(id): Promise<GalleryAsset|undefined>;
  insert(asset): Promise<void>; list(filter?: AssetFilter): Promise<GalleryAsset[]> }`
- `supabaseAssetStore: AssetStore` — snake_case row mapping both directions.
- `addToGallery(store, asset)` — the single public write entry point.
- `onPostApproved(store, item)` — builds a GalleryAsset from a ReviewItem with
  **id = item.id** (stable decision↔gallery link), category `approved_post`, source
  `generated_and_approved`; absorbs DuplicateAssetError as a no-op. **IDEMPOTENT — this
  property is load-bearing for the decision handler.**

### 5.6 `src/lib/oracle/prefilter.ts`
`runPrefilter({ imageUrl, brand, lane, overlayText? }): OracleResult` — pure, synchronous,
no I/O. Checks in order: URL shape; empty overlay text; forbidden keywords (zero
tolerance, all lanes); voice-keyword presence required for texts > 10 words ONLY on
THEOLOGY_REQUIRED_LANES. Reason strings are stable identifiers used in tests and the UI:
`image_url_empty_or_malformed`, `text_overlay_empty`,
`forbidden_keyword_violation:<keyword>`, `theology_absence_in_long_text`,
`unrecognized_brand:<brand>`.

### 5.7 `src/lib/lanes/recombination.ts` (Lane 1b)
- `class NoEligibleBaseError extends Error { brand }`
- `interface TextBankProvider { pick(brand): string | Promise<string> }` — union is
  deliberate (Stage 1 sync in-memory banks; Stage 2 async DB-rotated bank).
- `interface TextOverlayRenderer { render(baseUrl, text, brand): Promise<{url}> }`
- `getLastUsedIndex(brand)` / `advanceRotation(brand, assetId, index)` over
  rotation_state. Rotation advances ONLY after a successful render.
- `selectDeterministicBase(eligible, lastUsedIndex)` — pure. Sorts by addedAt ascending;
  advances the pointer with safeMod `((n%d)+d)%d` so corrupted negative/huge rotation
  state can never index out of bounds; throws RangeError on an empty list.
- `generateRecombinationPost(brand, { assetStore, textBank, renderer })` — lists brand +
  shared assets, excludes category `logo`, throws NoEligibleBaseError when empty, awaits
  the text pick, renders, advances rotation, returns a RenderedItem with lane
  `recombination` and provenance `sourceData: { baseImageId, text }`.

### 5.8 `src/lib/laneRotation.ts`
`getLaneRotationIndex(scope)` / `advanceLaneRotation(scope, index)` over
lane_rotation_state. Scope convention `'<lane>:<brand>'`.

### 5.9 `src/lib/lanes/freshTextCard.ts` (Lane 1a)
- `class NoFreshTextBaseError extends Error { brand }`
- `generateFreshTextCard(brand, { assetStore, textBank, renderer, lastUsedIndex? })` —
  bases are gallery assets of category `atmosphere` or `art` (brand + shared). Rotation is
  PERSISTED under scope `fresh_text_card:{brand}` and advanced only on render success;
  without persistence every batch re-rendered the same base forever (real bug, fixed).
  `lastUsedIndex` is a test-only override; when supplied, persistence is skipped (tests
  own their state).

### 5.10 `src/lib/textBank.ts`
`TextBankProvider` implementation over `src/config/textBanks.ts` with deterministic
rotation persisted in text_rotation_state. `EmptyTextBankError` on an empty bank. No
Math.random anywhere.

### 5.11 `src/lib/render/sharpRenderer.ts`
`TextOverlayRenderer` implementation: fetch the base image; composite an SVG text layer
built from `BRAND_TYPOGRAPHY[brand]` (word-wrap by estimated chars-per-line; scrim rect
drawn from `backgroundColor` + `opacity`, skipped when backgroundColor is null;
font-weight applied); output webp; upload to Storage at `rendered/{brand}/{uuid}.webp`;
return the public URL. Node runtime only (`export const runtime = 'nodejs'`) — sharp is
not edge-compatible. Typed errors: `BaseImageFetchError`, `RenderUploadError`.
**UNVERIFIED against a live environment** — fetch/storage are mocked in tests; one real
end-to-end render is a Stage 3 checklist item.

### 5.12 `src/lib/merch/sourcing.ts`
- `class CatalogUnavailableError extends Error`
- `interface ProductCatalogClient { search(query, category): Promise<{id,url}[]> }`
- `interface GalleryMatcher { findClosest(assets, opts: { category?, tags? }):
  { asset, confidence } | undefined }`
- `findMerchandiseCandidate(brand, { assetStore, galleryMatcher, catalogClient?,
  merchQuery, matchThreshold }): Promise<MerchCandidate>` — strict hierarchy per Section 1.

### 5.13 `src/lib/merch/tagMatcher.ts`
`GalleryMatcher` implementation. Confidence = |intersection of query tags and asset tags|
/ |query tags|; returns undefined with zero overlap. **It is TAG OVERLAP, not visual
similarity — the label "tag overlap" must appear wherever its confidence surfaces.**

### 5.14 `src/lib/merch/printifyClient.ts`
`ProductCatalogClient` against the Printify API. 10s timeout; non-2xx and network errors
THROW (the sourcing layer converts to CatalogUnavailableError); no internal
catch-and-continue. Printify's API has no category filter — the category parameter is
structurally honored but semantically a no-op, documented in-file. Env:
`PRINTIFY_API_KEY`, `PRINTIFY_SHOP_ID`. **UNVERIFIED live.**

### 5.15 `src/lib/orchestrator.ts`
`assembleReviewBatch(brand, deps)` where deps = `{ assetStore, textBank, renderer,
catalogClient, galleryMatcher, lastUsedFreshTextIndex?, lastUsedRecombinationIndex?,
merchQuery?, matchThreshold? }`. Runs all three lanes via Promise.allSettled — one lane
failing (e.g. CatalogUnavailableError) NEVER sinks the batch; per-lane outcomes are
captured. Every candidate is oracle-gated with `runPrefilter`; all items are inserted into
review_queue under one `batch_id` with their oracle_result (the GET route excludes failed
ones from D's default view). Returns `{ batchId, queued, laneOutcomes }`. Merch defaults:
`DEFAULT_MERCH_QUERY = { misfit: 'misfit tee', forge: 'forge hoodie' }`, threshold 0.5,
both overridable via deps.

### 5.16 API routes (`src/app/api/...`)
- `gallery/route.ts` — GET: public list, brand/category filterable. POST auth chain:
  Bearer JWT → `verifyUserJwt` → **allowlist check against `GALLERY_WRITER_IDS`**
  (comma-separated Supabase user ids, parsed PER REQUEST; EMPTY LIST = NOBODY CAN WRITE —
  fails closed by design, because misfit-backend is shared with the community platform and
  "any authenticated user" is not "authorized gallery writer"). Then: brand/category
  validated against enum sets; MIME allowlist png/jpeg/webp; 15MB cap; extension derived
  from validated MIME (never from filename — spoofing defense); Storage upload to bucket
  `media-engine` at `gallery/{brand}/{uuid}.{ext}` with upsert:false; `addToGallery` with
  **source: 'seed'** (manual uploads are seeds; `generated_and_approved` is reserved for
  the decision path). PATCH/DELETE → 405 with append-only message.
- `batch/route.ts` — POST. Auth: allowlisted JWT OR header `x-cron-secret` ==
  `CRON_SECRET`. This is the cron entry point; vercel.json has the cron entry.
- `review/route.ts` — GET pending items per brand, paginated oldest-first (the queue grows
  unbounded; paginate at query time). Filters `oracle_result->>passed = 'true'` — this
  jsonb path syntax is **UNVERIFIED against live Supabase** and is the one known
  must-check before go-live.
- `review/[id]/route.ts` — POST `{ decision }`, same auth. Loads the queue row,
  reconstructs the ReviewItem (merchSource/sourceDetail from merch_meta when present),
  calls `handleReviewDecision`. `FinalityViolationError` → 409 with both decisions in the
  body. Other errors → 500 with message.

### 5.17 `src/app/review/page.tsx`
Client page, phone-first (D operates one-handed on an S25 Ultra). Supabase email-OTP
sign-in using the ANON key browser client (session may not persist across refreshes in
some configurations — accepted limitation, D is the only user). Brand toggle; fetches
pending items; renders `ReviewCard` per item — **named export**, props
`{ item, onDecide(decision), disabled? }`; optimistic removal on success; 409 → "already
decided" toast + refetch; pagination.

### 5.18 `src/components/ReviewCard.tsx`
Presentational only. Pending-state double-submit guard; merch source badge from a
controlled label map; sourceDetail rendered as escaped text (XSS-safe against catalog
product names); aria labels; exactly three buttons: Post / Remix / Reject.

### 5.19 `scripts/seed.ts`
Reads a local folder + JSON manifest `{file, brand, category, tags}`; uploads to Storage;
inserts via addToGallery with source 'seed'. Asset id = content hash → re-runs are
idempotent, never duplicate.

### 5.20 Tests
- `tests/mediaEngine.test.ts` (26): store immutability + idempotency; oracle reasons and
  lane scoping; deterministic selection incl. corrupted negative AND huge positive
  rotation state; merch hierarchy incl. CatalogUnavailableError and cause preservation.
- `tests/reviewQueue.test.ts` (6): the six pinned decision-handler behaviors (Section 3).
- `tests/stage2.test.ts` (16): text bank rotation/empty; renderer SVG content and paths
  (mocked I/O); fresh lane; tag matcher math; printify error paths; orchestrator lane
  isolation; typography real-field regression (asserts fontFamily/fontSize/fontWeight
  exist and phantom font/size/scrim do NOT).

---

## 6. FROZEN NAMES (do not rename, do not alias)
Env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`,
`GALLERY_WRITER_IDS`, `CRON_SECRET`, `PRINTIFY_API_KEY`, `PRINTIFY_SHOP_ID`.
Tables: `gallery_assets`, `rotation_state`, `text_rotation_state`, `lane_rotation_state`,
`review_queue`, `media_decisions`, `remix_queue`. Storage bucket: `media-engine`.
Errors: `DuplicateAssetError`, `NoEligibleBaseError`, `NoFreshTextBaseError`,
`EmptyTextBankError`, `CatalogUnavailableError`, `FinalityViolationError`,
`BaseImageFetchError`, `RenderUploadError`.
Functions: `getSupabaseAdmin`, `verifyUserJwt`, `addToGallery`, `onPostApproved`,
`runPrefilter`, `selectDeterministicBase`, `generateRecombinationPost`,
`generateFreshTextCard`, `findMerchandiseCandidate`, `handleReviewDecision`,
`getExistingDecision`, `assembleReviewBatch`, `getLaneRotationIndex`,
`advanceLaneRotation`.

---

## 7. STAGE 3 — GO-LIVE (mostly D's hands; models assist with live-verification fixes)

1. **D**: run `supabase/schema.sql`, then migrations 001 → 002 → 003, in the
   misfit-backend SQL editor.
2. **D**: create PUBLIC Storage bucket `media-engine`.
3. **D**: set Vercel env vars — the three SUPABASE_* values; `GALLERY_WRITER_IDS` = D's
   own Supabase auth user id (leave empty and nobody, including D, can write — by design);
   `CRON_SECRET` = a long random string; the two PRINTIFY_* values.
4. **D**: replace `doctrine.ts` prose + keyword lists and `textBanks.ts` lines with his
   actual voice. Nothing generated ships under Misfit's name until these are his words.
5. **Live checks no model could do statically** (fix-forward if any fail):
   the `oracle_result->>passed` jsonb filter on the review GET; one real sharp render
   end-to-end (fetch → composite → Storage upload → public URL loads); one real Printify
   search; email-OTP login on the phone.
6. `npm run seed` with D's starting images + manifest.
7. First cron batch → review on phone → first Post → confirm: gallery row exists, decision
   row exists, ids match, replaying the decision returns the same record.

Deferred until D asks: event_log table, storefront handoff to The Hall, taste curator,
vision scoring, MPX, video, ensembles.

## 8. VERIFICATION BAR FOR ANY NEW DELIVERY
`npx tsc --noEmit` clean under strict mode; all 48 existing tests still green; new tests
for every new module or fixed bug; any claim of executed verification states the actual
command and result, or is labeled unverified.
