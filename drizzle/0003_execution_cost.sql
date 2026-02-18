ALTER TABLE executions ADD COLUMN IF NOT EXISTS total_cost_usd numeric(10,6);
ALTER TABLE executions ADD COLUMN IF NOT EXISTS total_turns integer;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS total_duration_ms integer;
