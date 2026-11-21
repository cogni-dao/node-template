ALTER TABLE "agent_principals" ADD COLUMN "suspended_by" text;--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD COLUMN "revoked_by" text;--> statement-breakpoint
ALTER TABLE "org_links" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "agent_principals" ADD CONSTRAINT "agent_principals_suspended_by_users_id_fk" FOREIGN KEY ("suspended_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_principals" ADD CONSTRAINT "agent_principals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_links" ADD CONSTRAINT "org_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Hand-written below: the forward repair of the live-row indexes, RELEASE 1 of two (task.0181). The old (principal, scope) index stays for the previous release's ON CONFLICT and for rollback;
-- release 2 (task.0175) drops it once no pod runs the old writer. Every statement is safe to run again.
-- A database that ran the first, rejected 0050 has `agent_roles_live_unique` as the account-aware three-column index and may hold several live rows per (principal, scope).
-- On production nothing changes: the old index never allowed a duplicate, so step 1 ends no row and steps 2 and 3 find both indexes in place.
-- 1. Keep the OLDEST live row per (principal, scope), end the rest. revoked_by stays NULL: the migration, not a person, ended them (there is no system actor row to name).
UPDATE "agent_roles" r SET "revoked_at" = now()
FROM (
	SELECT "id", row_number() OVER (PARTITION BY "principal_user_id", "scope" ORDER BY "created_at", "id") AS n
	FROM "agent_roles" WHERE "revoked_at" IS NULL
) d
WHERE r."id" = d."id" AND d.n > 1;--> statement-breakpoint
-- 2. Restore the old two-column index: drop an account-aware index that took its name, then create it if it is missing.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'agent_roles_live_unique' AND indexdef ILIKE '%coalesce%') THEN
		DROP INDEX "agent_roles_live_unique";
	END IF;
END
$$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_roles_live_unique" ON "agent_roles" USING btree ("principal_user_id","scope") WHERE "agent_roles"."revoked_at" IS NULL;--> statement-breakpoint
-- 3. The account-aware index, under its own name, if it is missing.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_roles_live_account_unique" ON "agent_roles" USING btree ("principal_user_id","scope",coalesce("account_id", '')) WHERE "agent_roles"."revoked_at" IS NULL;