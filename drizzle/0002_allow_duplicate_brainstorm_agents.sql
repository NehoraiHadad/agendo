DROP INDEX "idx_brainstorm_participants_room_agent";--> statement-breakpoint
CREATE INDEX "idx_brainstorm_participants_room_agent" ON "brainstorm_participants" USING btree ("room_id","agent_id");