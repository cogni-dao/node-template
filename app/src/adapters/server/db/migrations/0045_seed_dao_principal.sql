-- Seed: the DAO principal (idempotent). Precedent: 0037_seed_agent_principals.sql.
-- One `users` row named 'dao' with NO wallet and NO credential, and NO agent_principals row (it is not an AI: it must not appear in the admin
-- table). It is the approver recorded on an agent_roles row a passed DAO grant:role vote wrote, so an audit can tell a DAO vote from a bug.
-- A node has one DAO (repo-spec governance.dao_contract); the signal handler refuses any signal from another dao_contract before this row is used.
-- The ID is deterministic and matches packages/node-shared/src/constants/agent-principals.ts (DAO_PRINCIPAL_USER_ID).

-- users has FORCE RLS (self_isolation): set the RLS context to the principal before its insert (transaction-local).
SELECT set_config('app.current_user_id', '00000000-0000-4000-a000-0000000a00d0', true);
--> statement-breakpoint
INSERT INTO "users" ("id", "name", "wallet_address")
VALUES ('00000000-0000-4000-a000-0000000a00d0', 'dao', NULL)
ON CONFLICT ("id") DO NOTHING;
