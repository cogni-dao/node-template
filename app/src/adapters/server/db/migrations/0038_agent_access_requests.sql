ALTER TABLE "agent_roles" ALTER COLUMN "approved_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD COLUMN "granted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD COLUMN "requested_by" text;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Data, hand-written (same as 0037): rows an admin wrote directly are already granted; the two seeded AIs get their plain names.
-- A live lock now needs approved_by IS NOT NULL, so a pending row (an ask) never opens a lock.
-- Both tables are FORCE RLS with no write policy for the owner, so an UPDATE would silently touch 0 rows: lift FORCE for these
-- statements only, inside the migration transaction, then restore it.
ALTER TABLE "agent_roles" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_principals" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "agent_roles" SET "granted_at" = "created_at" WHERE "approved_by" IS NOT NULL AND "granted_at" IS NULL;--> statement-breakpoint
UPDATE "agent_principals" SET "display_name" = 'General assistant' WHERE "slug" = 'node-ai' AND "display_name" IS NULL;--> statement-breakpoint
UPDATE "agent_principals" SET "display_name" = 'Priority scorer' WHERE "slug" = 'prioritizer' AND "display_name" IS NULL;--> statement-breakpoint
ALTER TABLE "agent_roles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_principals" FORCE ROW LEVEL SECURITY;
