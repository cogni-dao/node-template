-- payer_bindings: the SQL TAIL for payer bindings (`createPostgresPayerBindingStore`, story.0038 phase 2). node-template keeps the table as 0046.
-- The table part is NOT here: `defineAgentAuthoritySchema` (`@cogni-dao/agent-grants/schema`, `payerBindings`) owns it and the node's own `db:generate` writes it. Append this file after that generated SQL.
-- FORCE RLS is outside Drizzle's DDL scope.
-- payer_bindings has NO policy: ENABLE + FORCE = deny-all for the app role. Only the BYPASSRLS service role reads or writes it.
ALTER TABLE "payer_bindings" FORCE ROW LEVEL SECURITY;
