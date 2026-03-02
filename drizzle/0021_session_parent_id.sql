-- Add parent_session_id to sessions for fork tracking
ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "parent_session_id" uuid
    REFERENCES "sessions"("id") ON DELETE SET NULL;
