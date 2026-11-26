-- org_accounts: the SQL TAIL for org accounts (task.0181, `@cogni-dao/agent-grants/org-accounts`). The tables are NOT here: `defineAgentAuthoritySchema` owns `org_accounts`, `org_events`,
-- `org_wallet_holds`, `org_connections`, `org_service_principals` and `org_connect_jtis`, and the node's own `db:generate` writes them. Append this file after that generated SQL (and after `agent_authority.sql`).
-- FORCE RLS, a function and triggers are outside Drizzle's DDL scope.
-- Each of the six tables has NO policy: ENABLE + FORCE = deny-all for the app role. Only the BYPASSRLS service role (the host's connection) reads or writes them.
ALTER TABLE "org_accounts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_wallet_holds" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_connections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_service_principals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_connect_jtis" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- EVERY_ACT_LOGGED / history tampering: org_events is APPEND ONLY. INSERT and SELECT stay; a trigger refuses UPDATE, DELETE and TRUNCATE for EVERY role (the service role
-- and the table owner included). The privileges are taken from public only: the owner keeps its own, because Postgres checks the foreign key from org_events to users as the owner
-- with a row lock that needs UPDATE (revoking it from the owner makes every delete of a users row fail). The trigger, not the privilege, is what refuses a rewrite.
CREATE OR REPLACE FUNCTION org_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'org_events is append only' USING ERRCODE = 'integrity_constraint_violation';
END
$$;--> statement-breakpoint
CREATE TRIGGER "org_events_no_update_delete"
  BEFORE UPDATE OR DELETE ON "org_events"
  FOR EACH ROW EXECUTE FUNCTION org_events_append_only();--> statement-breakpoint
CREATE TRIGGER "org_events_no_truncate"
  BEFORE TRUNCATE ON "org_events"
  FOR EACH STATEMENT EXECUTE FUNCTION org_events_append_only();--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "org_events" FROM PUBLIC;
