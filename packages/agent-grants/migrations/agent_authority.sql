-- agent_authority: the SQL TAIL for `agent_principals` and `agent_roles`, plus the seed of the node's two internal principals (node-template 0036 + 0037 + 0038).
-- The table part is NOT here: `defineAgentAuthoritySchema` (`@cogni-dao/agent-grants/schema`) owns it, and the node's own `db:generate` writes it, with the
-- account and org columns, their CHECKs and the two select policies. Append this file after that generated SQL. See README.md; never copy a snapshot.
-- FORCE RLS and the seed are outside Drizzle's DDL scope.
-- agent_roles has NO policy: ENABLE + FORCE = deny-all for the app role. Only a connection that bypasses row-level security reads or writes it
-- (the guard, the role routes). agent_principals is readable by all roles, writable only by that connection.
ALTER TABLE "agent_principals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_roles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Seed (idempotent): each internal principal is a `users` row with NO wallet and NO credential, plus an `agent_principals` row of kind 'internal'.
-- Ids and slugs match `INTERNAL_AGENT_PRINCIPALS` in `@cogni-dao/agent-grants`. No role rows are seeded: a node-admin turns each role On.
-- `users` has FORCE RLS (self_isolation): set the RLS context to each principal before its insert (transaction-local).
SELECT set_config('app.current_user_id', '00000000-0000-4000-a000-0000000a0001', true);--> statement-breakpoint
INSERT INTO "users" ("id", "name", "wallet_address") VALUES ('00000000-0000-4000-a000-0000000a0001', 'node-ai', NULL) ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
SELECT set_config('app.current_user_id', '00000000-0000-4000-a000-0000000a0002', true);--> statement-breakpoint
INSERT INTO "users" ("id", "name", "wallet_address") VALUES ('00000000-0000-4000-a000-0000000a0002', 'prioritizer', NULL) ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
-- agent_principals is FORCE RLS with a select-only policy, so even its owner cannot INSERT: lift FORCE for the seed only, inside the migration transaction.
ALTER TABLE "agent_principals" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO "agent_principals" ("kind", "slug", "user_id") VALUES ('internal', 'node-ai', '00000000-0000-4000-a000-0000000a0001') ON CONFLICT ("user_id") DO NOTHING;--> statement-breakpoint
INSERT INTO "agent_principals" ("kind", "slug", "user_id") VALUES ('internal', 'prioritizer', '00000000-0000-4000-a000-0000000a0002') ON CONFLICT ("user_id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "agent_principals" FORCE ROW LEVEL SECURITY;
