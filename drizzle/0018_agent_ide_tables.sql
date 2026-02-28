-- Agent IDE: plans, context_snapshots, workspaces

-- Plan status enum
DO $$ BEGIN
  CREATE TYPE "public"."plan_status" AS ENUM('draft', 'ready', 'stale', 'executing', 'done', 'archived');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Plans table
CREATE TABLE IF NOT EXISTS "plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "content" text NOT NULL,
  "status" "plan_status" DEFAULT 'draft' NOT NULL,
  "source_session_id" uuid REFERENCES "sessions"("id") ON DELETE SET NULL,
  "executing_session_id" uuid REFERENCES "sessions"("id") ON DELETE SET NULL,
  "last_validated_at" timestamp with time zone,
  "codebase_hash" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_plans_project" ON "plans" ("project_id", "status", "created_at");

-- Context Snapshots table
CREATE TABLE IF NOT EXISTS "context_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "session_id" uuid REFERENCES "sessions"("id") ON DELETE SET NULL,
  "name" text NOT NULL,
  "summary" text NOT NULL,
  "key_findings" jsonb DEFAULT '{"filesExplored":[],"findings":[],"hypotheses":[],"nextSteps":[]}'::jsonb NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_snapshots_project" ON "context_snapshots" ("project_id", "created_at");

-- Workspaces table
CREATE TABLE IF NOT EXISTS "workspaces" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
  "name" text NOT NULL,
  "layout" jsonb DEFAULT '{"panels":[],"gridCols":2}'::jsonb NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_workspaces_project" ON "workspaces" ("project_id", "is_active");
