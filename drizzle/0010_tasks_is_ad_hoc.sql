-- Migration: 0010_tasks_is_ad_hoc
-- Adds is_ad_hoc flag to tasks to distinguish auto-created scratch tasks from user tasks.
-- Ad-hoc tasks are created by the quick-launch endpoint and excluded from the Kanban board by default.

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "is_ad_hoc" boolean NOT NULL DEFAULT false;
