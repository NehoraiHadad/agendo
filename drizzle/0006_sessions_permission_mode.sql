-- Migration 0006: Add permissionMode and allowedTools to sessions
-- permissionMode controls per-tool-call gating within a running session.
-- 'default' = ask user before each tool call (Claude emits control_request).
-- 'bypassPermissions' = auto-allow all tools (previous hardcoded behaviour).
-- 'acceptEdits' = auto-allow file edits, ask for shell/bash.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS permission_mode VARCHAR(32) NOT NULL DEFAULT 'bypassPermissions',
  ADD COLUMN IF NOT EXISTS allowed_tools JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Update existing rows that got 'default' from the first migration run
UPDATE sessions SET permission_mode = 'bypassPermissions' WHERE permission_mode = 'default';
