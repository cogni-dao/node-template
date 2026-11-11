-- 0039 first named the upgrade value of created_from 'legacy_upgrade'. 0040 renames it to 'key_upgrade': drop the CHECK, rewrite any existing
-- row, add the CHECK back with the new value. On every database that runs 0039 and 0040 together (a fresh one, or candidate-a after 0039
-- drops the leaked #204 table) the table is empty at this point, so the rewrite touches no rows; it stays so a database that applied
-- 0039 alone converges too. The DROP INDEX IF EXISTS below only clears a partial user index that an earlier draft of this PR may have created; it is a no-op where none exists.
ALTER TABLE "agent_credentials" DROP CONSTRAINT IF EXISTS "agent_credentials_created_from_canonical";--> statement-breakpoint
-- Data, hand-written (same as 0038): agent_credentials is FORCE RLS with no policy, so an UPDATE by the owner would silently touch 0 rows.
-- Lift FORCE for this statement only, inside the migration transaction, then restore it.
ALTER TABLE "agent_credentials" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "agent_credentials" SET "created_from" = 'key_upgrade' WHERE "created_from" = 'legacy_upgrade';--> statement-breakpoint
ALTER TABLE "agent_credentials" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP INDEX IF EXISTS "agent_credentials_user_live_idx";--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_created_from_canonical" CHECK ("agent_credentials"."created_from" IN ('spawn_grant','rotation','key_upgrade','binding_recovery','recovery_grant'));
