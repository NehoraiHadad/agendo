-- Brainstorm Rooms feature: 2 enums + 3 tables
-- Migration: 0006_brainstorm_rooms

-- Enums
DO $$ BEGIN
  CREATE TYPE "brainstorm_status" AS ENUM ('waiting', 'active', 'paused', 'synthesizing', 'ended');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "brainstorm_participant_status" AS ENUM ('pending', 'active', 'passed', 'left');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Brainstorm Rooms
CREATE TABLE IF NOT EXISTS "brainstorm_rooms" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "task_id" uuid REFERENCES "tasks"("id") ON DELETE SET NULL,
  "title" text NOT NULL,
  "topic" text NOT NULL,
  "status" "brainstorm_status" NOT NULL DEFAULT 'waiting',
  "current_wave" integer NOT NULL DEFAULT 0,
  "max_waves" integer NOT NULL DEFAULT 10,
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "synthesis" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_brainstorm_rooms_project" ON "brainstorm_rooms" ("project_id", "status", "created_at");

-- Brainstorm Participants
CREATE TABLE IF NOT EXISTS "brainstorm_participants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "room_id" uuid NOT NULL REFERENCES "brainstorm_rooms"("id") ON DELETE CASCADE,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id"),
  "session_id" uuid REFERENCES "sessions"("id") ON DELETE SET NULL,
  "model" text,
  "status" "brainstorm_participant_status" NOT NULL DEFAULT 'pending',
  "joined_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_brainstorm_participants_room" ON "brainstorm_participants" ("room_id", "status");

-- Brainstorm Messages
CREATE TABLE IF NOT EXISTS "brainstorm_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "room_id" uuid NOT NULL REFERENCES "brainstorm_rooms"("id") ON DELETE CASCADE,
  "wave" integer NOT NULL,
  "sender_type" text NOT NULL,
  "sender_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "is_pass" boolean NOT NULL DEFAULT false,
  "content" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_brainstorm_messages_room_wave" ON "brainstorm_messages" ("room_id", "wave", "created_at");
