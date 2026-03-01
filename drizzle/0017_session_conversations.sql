-- Make taskId nullable (was NOT NULL) — conversations have no task
ALTER TABLE "sessions" ALTER COLUMN "task_id" DROP NOT NULL;

-- Add projectId (direct link, no need to go through task)
ALTER TABLE "sessions" ADD COLUMN "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL;

-- Add session kind discriminator
ALTER TABLE "sessions" ADD COLUMN "kind" text NOT NULL DEFAULT 'execution';
-- Valid values: 'conversation', 'execution'

-- Backfill projectId from existing tasks
UPDATE sessions s
SET project_id = t.project_id
FROM tasks t
WHERE t.id = s.task_id;

-- Index for project-scoped conversation queries
CREATE INDEX "idx_sessions_project" ON "sessions" ("project_id", "kind", "created_at" DESC)
  WHERE "project_id" IS NOT NULL;
