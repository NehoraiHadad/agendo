CREATE TYPE "public"."capability_source" AS ENUM('manual', 'builtin', 'preset', 'scan_help', 'scan_completion', 'scan_fig', 'scan_mcp', 'scan_man', 'llm_generated');--> statement-breakpoint
CREATE TYPE "public"."interaction_mode" AS ENUM('template', 'prompt');--> statement-breakpoint
CREATE TYPE "public"."support_status" AS ENUM('verified', 'untested', 'unsupported');--> statement-breakpoint
CREATE TABLE "agent_capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"source" "capability_source" DEFAULT 'manual' NOT NULL,
	"interaction_mode" "interaction_mode" DEFAULT 'template' NOT NULL,
	"command_tokens" jsonb,
	"prompt_template" text,
	"args_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"danger_level" smallint DEFAULT 0 NOT NULL,
	"timeout_sec" integer DEFAULT 300 NOT NULL,
	"max_output_bytes" integer DEFAULT 10485760 NOT NULL,
	"support_status" "support_status" DEFAULT 'untested' NOT NULL,
	"provider_notes" text,
	"last_tested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_agent_capability_key" UNIQUE("agent_id","key"),
	CONSTRAINT "capability_mode_consistency" CHECK ((interaction_mode = 'template' AND command_tokens IS NOT NULL) OR (interaction_mode = 'prompt'))
);
--> statement-breakpoint
ALTER TABLE "agent_capabilities" ADD CONSTRAINT "agent_capabilities_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_capabilities_agent" ON "agent_capabilities" USING btree ("agent_id","is_enabled");