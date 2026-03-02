-- Add fork_source_ref to sessions: stores the parent's Claude sessionRef used with
-- --resume --fork-session on the first start of a forked session.
ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "fork_source_ref" text;
