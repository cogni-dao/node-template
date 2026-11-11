-- 0039 shipped with an older name for the upgrade value of created_from. Applied migrations are immutable (a deployed DB already ran
-- 0039), so this migration converges a fresh DB and an already-migrated DB on 'key_upgrade': drop the CHECK, rewrite any existing row,
-- add the CHECK back with the new value. Also drops the first draft's partial user index if an earlier flight created it (0039 now makes
-- agent_credentials_user_idx with IF NOT EXISTS).
ALTER TABLE "agent_credentials" DROP CONSTRAINT IF EXISTS "agent_credentials_created_from_canonical";--> statement-breakpoint
-- Data, hand-written (same as 0038): agent_credentials is FORCE RLS with no policy, so an UPDATE by the owner would silently touch 0 rows.
-- Lift FORCE for this statement only, inside the migration transaction, then restore it.
ALTER TABLE "agent_credentials" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "agent_credentials" SET "created_from" = 'key_upgrade' WHERE "created_from" = 'legacy_upgrade';--> statement-breakpoint
ALTER TABLE "agent_credentials" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP INDEX IF EXISTS "agent_credentials_user_live_idx";--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_created_from_canonical" CHECK ("agent_credentials"."created_from" IN ('spawn_grant','rotation','key_upgrade','binding_recovery','recovery_grant'));
