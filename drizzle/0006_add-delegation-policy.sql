CREATE TYPE "public"."delegation_policy" AS ENUM('forbid', 'suggest', 'allow', 'auto');--> statement-breakpoint
CREATE TYPE "public"."team_role" AS ENUM('lead', 'member');--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "delegation_policy" "delegation_policy" DEFAULT 'forbid' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "team_role" "team_role";