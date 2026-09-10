-- ============================================================================
-- Misfit / Forge Media Engine — Supabase schema
-- Project: misfit-backend (ref seoguauzvvrefoupxgom)
-- Run this in the Supabase SQL editor once. Safe to re-run (IF NOT EXISTS).
-- ============================================================================

-- Autonomous + app-generated batches. Full batch stored as JSONB so the schema
-- never fights the app's shape.
create table if not exists public.media_batches (
  id            text primary key,
  brand         text,
  brand_name    text,
  hour_slot     int,
  generated_at  timestamptz default now(),
  created_at    timestamptz default now(),
  posts         jsonb,          -- written by the Vercel cron
  payload       jsonb           -- full PostBatch written by the app
);
create index if not exists media_batches_generated_at_idx
  on public.media_batches (generated_at desc);

-- Latest approve/reject/remix status per item (upsert by item_id).
create table if not exists public.media_decisions (
  item_id     text primary key,
  item_type   text not null,          -- 'post' | 'merch'
  status      text not null,          -- pending | approved | rejected | remix | posted
  notes       text,
  decided_at  timestamptz default now()
);

-- TASTE LEDGER — append-only. NOTHING is ever deleted here. This is the memory.
create table if not exists public.taste_events (
  id         text primary key,
  brand      text not null,           -- 'misfit' | 'forge'
  kind       text not null,           -- hashtag | styleToken | angle | platform | merchCategory | phrase
  value      text not null,
  decision   text not null,           -- approved | rejected | remix
  at         timestamptz not null default now(),
  source_id  text                     -- provenance: the post/merch id it came from
);
create index if not exists taste_events_brand_at_idx
  on public.taste_events (brand, at desc);

-- ----------------------------------------------------------------------------
-- Row Level Security. This is a single-operator tool, so the simplest safe
-- setup is: enable RLS and allow the anon key to read/write these tables.
-- If you later add auth, tighten these policies.
-- ----------------------------------------------------------------------------
alter table public.media_batches  enable row level security;
alter table public.media_decisions enable row level security;
alter table public.taste_events    enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'media_batches' and policyname = 'anon_all') then
    create policy anon_all on public.media_batches for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'media_decisions' and policyname = 'anon_all') then
    create policy anon_all on public.media_decisions for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'taste_events' and policyname = 'anon_all') then
    create policy anon_all on public.taste_events for all using (true) with check (true);
  end if;
end $$;
