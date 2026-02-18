CREATE TYPE session_status AS ENUM ('active', 'awaiting_input', 'idle', 'ended');

CREATE TABLE sessions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id          UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id         UUID NOT NULL REFERENCES agents(id),
  capability_id    UUID NOT NULL REFERENCES agent_capabilities(id),
  status           session_status NOT NULL DEFAULT 'active',
  pid              INTEGER,
  worker_id        TEXT,
  session_ref      TEXT,
  event_seq        INTEGER NOT NULL DEFAULT 0,
  heartbeat_at     TIMESTAMPTZ,
  started_at       TIMESTAMPTZ,
  last_active_at   TIMESTAMPTZ,
  idle_timeout_sec INTEGER NOT NULL DEFAULT 600,
  ended_at         TIMESTAMPTZ,
  log_file_path    TEXT,
  total_cost_usd   NUMERIC(10,6),
  total_turns      INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sessions_task      ON sessions(task_id, created_at);
CREATE INDEX idx_sessions_active    ON sessions(status, worker_id) WHERE status IN ('active', 'awaiting_input');
CREATE INDEX idx_sessions_heartbeat ON sessions(heartbeat_at) WHERE status = 'active';

-- Add session_id to executions (nullable — backfilled later, existing rows stay NULL)
ALTER TABLE executions ADD COLUMN session_id UUID REFERENCES sessions(id);
CREATE INDEX idx_executions_session ON executions(session_id, created_at);
