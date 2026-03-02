-- Migration: Remove CLI Tools feature
-- Drops executions table, execution_status enum, template-mode columns, and CLI tool agents.

-- 1. Drop executions table FIRST (has FK to agents, agent_capabilities, sessions)
DROP TABLE IF EXISTS executions CASCADE;

-- 2. Drop execution_status enum
DROP TYPE IF EXISTS execution_status;

-- 3. Delete non-AI-agent agents (now safe — executions FK is gone; cascades to their capabilities)
DELETE FROM agents WHERE tool_type != 'ai-agent';

-- 4. Drop CLI-Tools-only columns and constraint from agent_capabilities
ALTER TABLE agent_capabilities
  DROP CONSTRAINT IF EXISTS capability_mode_consistency,
  DROP COLUMN IF EXISTS command_tokens,
  DROP COLUMN IF EXISTS args_schema;

-- 5. Drop the column default (which references the old enum type) before recreating the type
ALTER TABLE agent_capabilities
  ALTER COLUMN interaction_mode DROP DEFAULT;

-- 6. Recreate interaction_mode enum with only 'prompt' value
CREATE TYPE interaction_mode_new AS ENUM ('prompt');

ALTER TABLE agent_capabilities
  ALTER COLUMN interaction_mode TYPE interaction_mode_new
  USING interaction_mode::text::interaction_mode_new;

-- 7. Swap old enum for new one
DROP TYPE interaction_mode;
ALTER TYPE interaction_mode_new RENAME TO interaction_mode;

-- 8. Restore default on the column (now using the renamed type)
ALTER TABLE agent_capabilities
  ALTER COLUMN interaction_mode SET DEFAULT 'prompt';
