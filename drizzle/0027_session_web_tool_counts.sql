-- Custom SQL migration file, put your code below! --
ALTER TABLE "sessions" ADD COLUMN "web_search_requests" integer DEFAULT 0;
ALTER TABLE "sessions" ADD COLUMN "web_fetch_requests" integer DEFAULT 0;