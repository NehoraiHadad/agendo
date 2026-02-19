-- Add initial_prompt, total_duration_ms, and tmux_session_name to sessions table.
-- sessions now own their full lifecycle independently of executions.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS initial_prompt    text,
  ADD COLUMN IF NOT EXISTS total_duration_ms integer,
  ADD COLUMN IF NOT EXISTS tmux_session_name text;
