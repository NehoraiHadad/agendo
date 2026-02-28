ALTER TABLE "plans" ADD COLUMN "conversation_session_id" uuid
  REFERENCES "sessions"("id") ON DELETE SET NULL;
