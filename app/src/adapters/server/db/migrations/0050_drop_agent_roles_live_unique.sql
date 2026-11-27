-- agent_roles live index, RELEASE B of two (task.0181 / task.5484): the old (principal, scope) index goes. Release A (0049) added the account-aware index and moved every writer to a bare ON CONFLICT DO NOTHING.
DROP INDEX IF EXISTS "agent_roles_live_unique";
