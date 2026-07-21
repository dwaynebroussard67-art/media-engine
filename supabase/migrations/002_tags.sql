-- supabase/migrations/002_tags.sql
-- Additive only. Adds optional tags column to gallery_assets.
-- NEVER modifies or drops the append-only triggers (reject_mutation).
-- Safe to run on a live database; adds a nullable column with no backfill required.
-- Idempotent: wrapped in a DO block that checks for column existence first.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'gallery_assets'
      AND column_name  = 'tags'
  ) THEN
    ALTER TABLE public.gallery_assets
      ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
  END IF;
END;
$$;

-- Index for tag-overlap queries (GIN supports array containment operators).
CREATE INDEX IF NOT EXISTS idx_gallery_assets_tags
  ON public.gallery_assets USING GIN (tags);

-- text_rotation_state: same shape as rotation_state, keyed by brand.
-- Used exclusively by the text bank to persist rotation position.
CREATE TABLE IF NOT EXISTS public.text_rotation_state (
  brand           text PRIMARY KEY,
  last_used_index int  NOT NULL DEFAULT -1,
  updated_at      bigint NOT NULL
);
