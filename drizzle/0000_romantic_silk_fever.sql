CREATE TYPE "public"."agent_kind" AS ENUM('builtin', 'custom');--> statement-breakpoint
CREATE TYPE "public"."capability_source" AS ENUM('manual', 'builtin', 'preset', 'scan_help', 'scan_completion', 'scan_fig', 'scan_mcp', 'scan_man', 'llm_generated');--> statement-breakpoint
CREATE TYPE "public"."discovery_method" AS ENUM('preset', 'path_scan', 'manual');--> statement-breakpoint
CREATE TYPE "public"."execution_status" AS ENUM('queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'timed_out');--> statement-breakpoint
CREATE TYPE "public"."interaction_mode" AS ENUM('template', 'prompt');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('todo', 'in_progress', 'blocked', 'done', 'cancelled');--> statement-breakpoint
CREATE TABLE "agent_capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"source" "capability_source" NOT NULL,
	"interaction_mode" "interaction_mode" DEFAULT 'template' NOT NULL,
	"command_tokens" jsonb,
	"prompt_template" text,
	"args_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"danger_level" smallint DEFAULT 0 NOT NULL,
	"timeout_sec" integer DEFAULT 300 NOT NULL,
	"max_output_bytes" integer DEFAULT 10485760 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_agent_capability_key" UNIQUE("agent_id","key"),
	CONSTRAINT "capability_mode_consistency" CHECK ((interaction_mode = 'template' AND command_tokens IS NOT NULL) OR (interaction_mode = 'prompt'))
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
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"capability_id" uuid NOT NULL,
	"requested_by" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"status" "execution_status" DEFAULT 'queued' NOT NULL,
	"mode" "interaction_mode" DEFAULT 'template' NOT NULL,
	"args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prompt" text,
	"pid" integer,
	"session_ref" text,
	"tmux_session_name" text,
	"parent_execution_id" uuid,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"exit_code" integer,
	"error" text,
	"worker_id" text,
	"heartbeat_at" timestamp with time zone,
	"log_file_path" text,
	"log_byte_size" bigint DEFAULT 0 NOT NULL,
	"log_line_count" integer DEFAULT 0 NOT NULL,
	"log_updated_at" timestamp with time zone,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"max_retries" integer DEFAULT 0 NOT NULL,
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
	"title" text NOT NULL,
	"description" text,
	"status" "task_status" DEFAULT 'todo' NOT NULL,
	"priority" smallint DEFAULT 3 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
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
ALTER TABLE "agent_capabilities" ADD CONSTRAINT "agent_capabilities_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_capability_id_agent_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."agent_capabilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_parent_execution_id_executions_id_fk" FOREIGN KEY ("parent_execution_id") REFERENCES "public"."executions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_depends_on_task_id_tasks_id_fk" FOREIGN KEY ("depends_on_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_capabilities_agent" ON "agent_capabilities" USING btree ("agent_id","is_enabled");--> statement-breakpoint
CREATE INDEX "idx_agents_workspace" ON "agents" USING btree ("workspace_id","is_active");--> statement-breakpoint
CREATE INDEX "idx_executions_queue" ON "executions" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_executions_task" ON "executions" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_executions_stale" ON "executions" USING btree ("heartbeat_at");--> statement-breakpoint
CREATE INDEX "idx_executions_agent_active" ON "executions" USING btree ("agent_id","status");--> statement-breakpoint
CREATE INDEX "idx_task_events_task" ON "task_events" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_tasks_board" ON "tasks" USING btree ("workspace_id","status","sort_order");--> statement-breakpoint
CREATE INDEX "idx_tasks_parent" ON "tasks" USING btree ("parent_task_id");