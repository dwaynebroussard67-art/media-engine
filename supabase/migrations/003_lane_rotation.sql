-- supabase/migrations/003_lane_rotation.sql
-- Additive only. Generic per-scope rotation pointers so every deterministic
-- lane persists its own position instead of sharing (or skipping) state.
-- Scope convention: '<lane>:<brand>', e.g. 'fresh_text_card:misfit'.
CREATE TABLE IF NOT EXISTS public.lane_rotation_state (
  scope           text PRIMARY KEY,
  last_used_index int    NOT NULL DEFAULT -1,
  updated_at      bigint NOT NULL
);
