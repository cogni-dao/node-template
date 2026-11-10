-- Seed: internal agent principals (idempotent). Precedent: 0008_seed_system_tenant.sql.
-- Each principal is a `users` row with NO wallet and NO credential, plus an `agent_principals` row of kind
-- 'internal' with a unique slug. The graph catalog names the slug; a missing row denies the run.
-- IDs are deterministic and match packages/node-shared/src/constants/agent-principals.ts.
-- No role rows are seeded: a DAO admin grants each role through the "This node's AI" block on /profile (POST /api/v1/agent-access/roles).

-- users has FORCE RLS (self_isolation): set the RLS context to each principal before its insert (transaction-local).
SELECT set_config('app.current_user_id', '00000000-0000-4000-a000-0000000a0001', true);
--> statement-breakpoint
INSERT INTO "users" ("id", "name", "wallet_address")
VALUES ('00000000-0000-4000-a000-0000000a0001', 'node-ai', NULL)
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
SELECT set_config('app.current_user_id', '00000000-0000-4000-a000-0000000a0002', true);
--> statement-breakpoint
INSERT INTO "users" ("id", "name", "wallet_address")
VALUES ('00000000-0000-4000-a000-0000000a0002', 'prioritizer', NULL)
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
-- agent_principals is FORCE RLS with a select-only policy, so even its owner cannot INSERT. The migrating role owns
-- the table, so lift FORCE for the seed only; this runs inside the migration transaction, so no other session sees it.
ALTER TABLE "agent_principals" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO "agent_principals" ("kind", "slug", "user_id")
VALUES ('internal', 'node-ai', '00000000-0000-4000-a000-0000000a0001')
ON CONFLICT ("user_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "agent_principals" ("kind", "slug", "user_id")
VALUES ('internal', 'prioritizer', '00000000-0000-4000-a000-0000000a0002')
ON CONFLICT ("user_id") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "agent_principals" FORCE ROW LEVEL SECURITY;
