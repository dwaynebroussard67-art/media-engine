-- supabase/schema.sql
-- Append-only immutability enforced at the PostgreSQL trigger layer.
-- No UPDATE or DELETE is permitted on core event tables.

-- ============================================================
-- Reusable trigger function: blocks all mutations post-insert
-- ============================================================
create or replace function reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'Table "%" is append-only. UPDATE and DELETE are strictly prohibited.',
    TG_TABLE_NAME;
end;
$$;

-- ============================================================
-- gallery_assets
-- Permanent, append-only store of approved visual assets.
-- ============================================================
create table if not exists gallery_assets (
  id                   text    primary key,
  url                  text    not null
                               check (url ~ '^https?://'),
  brand                text    not null
                               check (brand in ('misfit', 'forge', 'shared')),
  category             text    not null
                               check (category in (
                                 'logo', 'apparel', 'art',
                                 'atmosphere', 'approved_post'
                               )),
  for_sale             boolean not null default false,
  source               text    not null
                               check (source in ('seed', 'generated_and_approved')),
  original_template_id text,
  added_at             bigint  not null,
  -- Structural sentinel: this column must always be true.
  -- The check constraint prevents any inserted row from being non-permanent.
  permanent            boolean not null default true
                               check (permanent = true)
);

create index if not exists idx_gallery_assets_brand_category
  on gallery_assets (brand, category);

drop trigger if exists enforce_gallery_assets_append_only on gallery_assets;
create trigger enforce_gallery_assets_append_only
  before update or delete on gallery_assets
  for each row execute function reject_mutation();

-- ============================================================
-- rotation_state
-- Mutable pointer: tracks sequential base selection per brand.
-- Intentionally excluded from the append-only constraint
-- because its sole purpose is to be updated on each run.
-- ============================================================
create table if not exists rotation_state (
  brand              text    primary key
                             check (brand in ('misfit', 'forge')),
  last_used_asset_id text    not null,
  last_used_index    integer not null,
  updated_at         bigint  not null
);

-- ============================================================
-- review_queue
-- Transient staging area for items awaiting human review.
-- `status` transitions from 'pending' -> 'decided' only.
-- ============================================================
create table if not exists review_queue (
  id          uuid    primary key,
  batch_id    uuid    not null,
  brand       text    not null check (brand in ('misfit', 'forge')),
  lane        text    not null,
  image_url   text    not null,
  source_data jsonb   not null,
  oracle_result jsonb not null,
  merch_meta  jsonb,
  queued_at   bigint  not null,
  status      text    not null default 'pending'
                      check (status in ('pending', 'decided')),
  decided_at  bigint
);

create index if not exists idx_review_queue_brand_status
  on review_queue (brand, status, queued_at asc);

-- ============================================================
-- media_decisions
-- Append-only audit log of every review decision made.
-- gallery_entry_id is pre-calculated and written on INSERT;
-- no UPDATE path exists or is permitted.
-- ============================================================
create table if not exists media_decisions (
  id               uuid    primary key,
  item_id          text    not null,
  decision         text    not null
                           check (decision in ('post', 'remix', 'reject')),
  brand            text    not null
                           check (brand in ('misfit', 'forge')),
  lane             text    not null,
  oracle_result    jsonb   not null,
  -- Populated at INSERT time when decision = 'post'.
  -- NULL for 'remix' and 'reject'. Never backfilled via UPDATE.
  gallery_entry_id text,
  decided_at       bigint  not null
);

create index if not exists idx_media_decisions_item
  on media_decisions (item_id);

-- Uniqueness: one decision per item, ever.
create unique index if not exists idx_media_decisions_item_unique
  on media_decisions (item_id);

drop trigger if exists enforce_media_decisions_append_only on media_decisions;
create trigger enforce_media_decisions_append_only
  before update or delete on media_decisions
  for each row execute function reject_mutation();

-- ============================================================
-- remix_queue
-- Work queue for items routed back for regeneration.
-- References review_queue to maintain referential integrity.
-- ============================================================
create table if not exists remix_queue (
  id               uuid    primary key default gen_random_uuid(),
  -- Soft reference: review_queue rows may be purged separately.
  -- FK omitted intentionally to allow queue archival without
  -- cascading deletes into the remix backlog.
  original_item_id text    not null,
  brand            text    not null
                           check (brand in ('misfit', 'forge')),
  lane             text    not null,
  queued_at        bigint  not null,
  reason           text    not null,
  processed        boolean not null default false
);

create index if not exists idx_remix_queue_unprocessed
  on remix_queue (brand, processed, queued_at asc)
  where processed = false;

-- A lost decision race must not leave duplicate regeneration work behind.
create unique index if not exists idx_remix_queue_original_item_unique
  on remix_queue (original_item_id);
