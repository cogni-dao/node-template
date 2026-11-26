-- agent_roles account-aware live index, RELEASE A of two (task.0181 / task.5484). The old (principal, scope) index `agent_roles_live_unique` stays for a pod on the previous
-- release's ON CONFLICT target and for rollback; release B drops it once no pod runs the old writer. Every statement is safe to run again and safe on a database that already holds either index.
-- Candidate-a ran the prototype's 0050 and 0051 (PR 454), so it may hold `agent_roles_live_unique` as the account-aware three-column index and several live rows per (principal, scope).
-- Production, preview and a fresh database never allowed such a duplicate: step 1 ends no row there and steps 2 and 3 find the old index and add the new one.
-- 1. Keep the OLDEST live row per (principal, scope) and end the rest. The migration, not a person, ended them.
-- `agent_roles` has ENABLE + FORCE row-level security and the migrator is its owner WITHOUT BYPASSRLS, so under FORCE the owner's UPDATE matches no policy and ends ZERO rows, while the
-- unique-index build below still sees every row and fails (23505). The drizzle migrator runs every pending migration in ONE transaction, so lifting FORCE for this one UPDATE and putting
-- it back is atomic with the rest: a failure anywhere rolls the FORCE setting back too, and it is on again before the migration commits.
ALTER TABLE "agent_roles" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "agent_roles" r SET "revoked_at" = now()
FROM (
	SELECT "id", row_number() OVER (PARTITION BY "principal_user_id", "scope" ORDER BY "created_at", "id") AS n
	FROM "agent_roles" WHERE "revoked_at" IS NULL
) d
WHERE r."id" = d."id" AND d.n > 1;--> statement-breakpoint
ALTER TABLE "agent_roles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- 2. The old two-column index under its own name: drop an account-aware index that took the name, then create it if it is missing.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'agent_roles_live_unique' AND indexdef ILIKE '%coalesce%') THEN
		DROP INDEX "agent_roles_live_unique";
	END IF;
END
$$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_roles_live_unique" ON "agent_roles" USING btree ("principal_user_id","scope") WHERE "agent_roles"."revoked_at" IS NULL;--> statement-breakpoint
-- 3. The account-aware index, under its own name.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_roles_live_account_unique" ON "agent_roles" USING btree ("principal_user_id","scope",coalesce("account_id", '')) WHERE "agent_roles"."revoked_at" IS NULL;
