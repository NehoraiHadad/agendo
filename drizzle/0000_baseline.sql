CREATE TYPE "public"."agent_kind" AS ENUM('builtin', 'custom');--> statement-breakpoint
CREATE TYPE "public"."artifact_type" AS ENUM('html', 'svg');--> statement-breakpoint
CREATE TYPE "public"."brainstorm_participant_status" AS ENUM('pending', 'active', 'passed', 'left');--> statement-breakpoint
CREATE TYPE "public"."brainstorm_status" AS ENUM('waiting', 'active', 'paused', 'synthesizing', 'ended');--> statement-breakpoint
CREATE TYPE "public"."discovery_method" AS ENUM('preset', 'path_scan', 'manual');--> statement-breakpoint
CREATE TYPE "public"."mcp_transport_type" AS ENUM('stdio', 'http');--> statement-breakpoint
CREATE TYPE "public"."plan_status" AS ENUM('draft', 'ready', 'stale', 'executing', 'done', 'archived');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('active', 'awaiting_input', 'idle', 'ended');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('todo', 'in_progress', 'blocked', 'done', 'cancelled');--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"layout" jsonb DEFAULT '{"panels":[],"gridCols":2}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"workspace_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"kind" "agent_kind" DEFAULT 'custom' NOT NULL,
	"binary_path" text NOT NULL,
	"base_args" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"working_dir" text,
	"env_allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"max_concurrent" integer DEFAULT 1 NOT NULL,
	"discovery_method" "discovery_method" DEFAULT 'manual' NOT NULL,
	"version" text,
	"package_name" text,
	"package_section" text,
	"tool_type" text,
	"mcp_enabled" boolean DEFAULT false NOT NULL,
	"session_config" jsonb,
	"last_scanned_at" timestamp with time zone,
	"parsed_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid,
	"plan_id" uuid,
	"title" text NOT NULL,
	"type" "artifact_type" DEFAULT 'html' NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brainstorm_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"session_id" uuid,
	"model" text,
	"role" text,
	"status" "brainstorm_participant_status" DEFAULT 'pending' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brainstorm_rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid,
	"title" text NOT NULL,
	"topic" text NOT NULL,
	"status" "brainstorm_status" DEFAULT 'waiting' NOT NULL,
	"current_wave" integer DEFAULT 0 NOT NULL,
	"max_waves" integer DEFAULT 10 NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"synthesis" text,
	"log_file_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"session_id" uuid,
	"name" text NOT NULL,
	"summary" text NOT NULL,
	"key_findings" jsonb DEFAULT '{"filesExplored":[],"findings":[],"hypotheses":[],"nextSteps":[]}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"transport_type" "mcp_transport_type" DEFAULT 'stdio' NOT NULL,
	"command" text,
	"args" jsonb DEFAULT '[]'::jsonb,
	"env" jsonb DEFAULT '{}'::jsonb,
	"url" text,
	"headers" jsonb DEFAULT '{}'::jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "plan_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"status" "plan_status" DEFAULT 'draft' NOT NULL,
	"source_session_id" uuid,
	"executing_session_id" uuid,
	"conversation_session_id" uuid,
	"last_validated_at" timestamp with time zone,
	"codebase_hash" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_mcp_servers" (
	"project_id" uuid NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"env_overrides" jsonb DEFAULT '{}'::jsonb,
	CONSTRAINT "project_mcp_servers_project_id_mcp_server_id_pk" PRIMARY KEY("project_id","mcp_server_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"root_path" text NOT NULL,
	"env_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"color" varchar(7) DEFAULT '#6366f1' NOT NULL,
	"icon" varchar(50),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_root_path_unique" UNIQUE("root_path")
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid,
	"project_id" uuid,
	"kind" text DEFAULT 'execution' NOT NULL,
	"agent_id" uuid NOT NULL,
	"status" "session_status" DEFAULT 'active' NOT NULL,
	"pid" integer,
	"worker_id" text,
	"session_ref" text,
	"event_seq" integer DEFAULT 0 NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"last_active_at" timestamp with time zone,
	"idle_timeout_sec" integer DEFAULT 600 NOT NULL,
	"ended_at" timestamp with time zone,
	"log_file_path" text,
	"total_cost_usd" numeric(10, 6),
	"total_turns" integer DEFAULT 0 NOT NULL,
	"permission_mode" text DEFAULT 'bypassPermissions' NOT NULL,
	"allowed_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"initial_prompt" text,
	"title" text,
	"model" text,
	"effort" text,
	"web_search_requests" integer DEFAULT 0,
	"web_fetch_requests" integer DEFAULT 0,
	"plan_file_path" text,
	"auto_resume_count" integer DEFAULT 0 NOT NULL,
	"total_duration_ms" integer,
	"tmux_session_name" text,
	"parent_session_id" uuid,
	"fork_source_ref" text,
	"fork_point_uuid" text,
	"mcp_server_ids" jsonb,
	"use_worktree" boolean DEFAULT false NOT NULL,
	"max_budget_usd" numeric(10, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"task_id" uuid NOT NULL,
	"depends_on_task_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_dependencies_task_id_depends_on_task_id_pk" PRIMARY KEY("task_id","depends_on_task_id"),
	CONSTRAINT "no_self_dependency" CHECK (task_id <> depends_on_task_id)
);
--> statement-breakpoint
CREATE TABLE "task_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "task_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"task_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"workspace_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"parent_task_id" uuid,
	"project_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"status" "task_status" DEFAULT 'todo' NOT NULL,
	"priority" smallint DEFAULT 3 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"execution_order" integer,
	"assignee_agent_id" uuid,
	"input_context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"current_executions" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brainstorm_participants" ADD CONSTRAINT "brainstorm_participants_room_id_brainstorm_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."brainstorm_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brainstorm_participants" ADD CONSTRAINT "brainstorm_participants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brainstorm_participants" ADD CONSTRAINT "brainstorm_participants_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brainstorm_rooms" ADD CONSTRAINT "brainstorm_rooms_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brainstorm_rooms" ADD CONSTRAINT "brainstorm_rooms_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_snapshots" ADD CONSTRAINT "context_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_snapshots" ADD CONSTRAINT "context_snapshots_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_source_session_id_sessions_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_executing_session_id_sessions_id_fk" FOREIGN KEY ("executing_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_conversation_session_id_sessions_id_fk" FOREIGN KEY ("conversation_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_mcp_servers" ADD CONSTRAINT "project_mcp_servers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_mcp_servers" ADD CONSTRAINT "project_mcp_servers_mcp_server_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_parent_session_id_sessions_id_fk" FOREIGN KEY ("parent_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_depends_on_task_id_tasks_id_fk" FOREIGN KEY ("depends_on_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_workspaces_project" ON "workspaces" USING btree ("project_id","is_active");--> statement-breakpoint
CREATE INDEX "idx_agents_workspace" ON "agents" USING btree ("workspace_id","is_active");--> statement-breakpoint
CREATE INDEX "idx_artifacts_session" ON "artifacts" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_artifacts_plan" ON "artifacts" USING btree ("plan_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_brainstorm_participants_room" ON "brainstorm_participants" USING btree ("room_id","status");--> statement-breakpoint
CREATE INDEX "idx_brainstorm_participants_room_agent" ON "brainstorm_participants" USING btree ("room_id","agent_id");--> statement-breakpoint
CREATE INDEX "idx_brainstorm_rooms_project" ON "brainstorm_rooms" USING btree ("project_id","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_snapshots_project" ON "context_snapshots" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_plan_versions_unique" ON "plan_versions" USING btree ("plan_id","version");--> statement-breakpoint
CREATE INDEX "idx_plan_versions_plan" ON "plan_versions" USING btree ("plan_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_plans_project" ON "plans" USING btree ("project_id","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_sessions_task" ON "sessions" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_sessions_active" ON "sessions" USING btree ("status","worker_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_heartbeat" ON "sessions" USING btree ("heartbeat_at");--> statement-breakpoint
CREATE INDEX "idx_sessions_project" ON "sessions" USING btree ("project_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "idx_task_events_task" ON "task_events" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_tasks_board" ON "tasks" USING btree ("workspace_id","status","sort_order");--> statement-breakpoint
CREATE INDEX "idx_tasks_parent" ON "tasks" USING btree ("parent_task_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_project_id" ON "tasks" USING btree ("project_id");