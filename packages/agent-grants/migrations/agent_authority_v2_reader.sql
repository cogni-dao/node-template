-- Required authority-only prerequisites for current credential and role readers.
ALTER TABLE agent_principals ADD COLUMN current_generation bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE agent_principals ADD COLUMN current_operation_id uuid;
--> statement-breakpoint
ALTER TABLE agent_principals ADD COLUMN home_origin text;
