ALTER TABLE "agents" ADD COLUMN "parsed_flags" jsonb DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE "executions" ADD COLUMN "cli_flags" jsonb DEFAULT '{}'::jsonb NOT NULL;
