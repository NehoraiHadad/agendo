-- Custom SQL migration file, put your code below! --
ALTER TABLE "sessions" ADD COLUMN "effort" text CHECK ("effort" IN ('low', 'medium', 'high'));