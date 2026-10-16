-- supabase/migrations/004_batch_runs.sql
-- Additive only. Never touches the append-only triggers (reject_mutation).
--
-- WHY (red-team finding F-01, 2026-10-15):
-- Rotation pointers (rotation_state, text_rotation_state, lane_rotation_state)
-- are read-modify-write. Two overlapping batches — a Vercel cron firing while D
-- taps "Run batch" on his phone, or a cron retry — both read the same pointer,
-- both select the SAME base asset, both advance to the SAME next index. The
-- result is duplicate renders, permanently skipped assets, and duplicate
-- catalog/AI spend. Nothing in the code or the schema prevented it.
--
-- This table is two things at once:
--   1. A single-flight lock per brand, enforced by the partial unique index
--      below (a second concurrent claim for the same brand gets 23505).
--   2. The batch audit log the system never had (dossier §7 deferred event_log;
--      DEBUG-REPORT Bug 2 was a cron that failed silently for weeks because
--      nothing recorded that it had run).
--
-- Mutable by design, like rotation_state: rows are inserted, then closed out.

CREATE TABLE IF NOT EXISTS public.batch_runs (
  id           uuid   PRIMARY KEY,
  brand        text   NOT NULL CHECK (brand IN ('misfit', 'forge')),
  status       text   NOT NULL CHECK (status IN ('running', 'done', 'error')),
  started_at   bigint NOT NULL,
  finished_at  bigint,
  queued       int,
  note         text
);

-- At most ONE running batch per brand. The DB is the authority, not the app.
CREATE UNIQUE INDEX IF NOT EXISTS idx_batch_runs_one_running_per_brand
  ON public.batch_runs (brand)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_batch_runs_started_at
  ON public.batch_runs (started_at DESC);
