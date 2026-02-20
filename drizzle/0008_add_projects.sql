-- Migration: 0008_add_projects
-- Adds the projects table and links tasks to projects via project_id FK.

CREATE TABLE IF NOT EXISTS "projects" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "name" varchar(255) NOT NULL,
    "description" text,
    "root_path" text NOT NULL,
    "env_overrides" jsonb NOT NULL DEFAULT '{}',
    "color" varchar(7) NOT NULL DEFAULT '#6366f1',
    "icon" varchar(50),
    "is_active" boolean NOT NULL DEFAULT true,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "projects_root_path_unique" UNIQUE ("root_path")
);

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "idx_tasks_project_id" ON "tasks" ("project_id");
