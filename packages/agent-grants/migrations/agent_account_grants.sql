-- agent_account_grants: the SQL TAIL for account-resource grants on `agent_roles` (`authorizeAccount`, `approveAccountAsk`). node-template keeps it as 0041 + 0042.
-- The column, CHECK, index and select-policy part is NOT here: `defineAgentAuthoritySchema` owns it (`resource`, `account_id`, `expires_at`, `link_*`, the five CHECKs,
-- the unique `link_hash` index and `agent_roles_account_self_read`), and the node's own `db:generate` writes it. Append this file after that generated SQL.
-- DURABLE: an account row has no end date (it lasts until Off, like a node row); `expires_at` stays nullable and a row that carries an end keeps the expired state.
-- Release A of two (task.0181): `agent_roles_live_unique` (principal, scope) stays for a pod on the previous release; the factory also emits `agent_roles_live_account_unique` and the writers say a bare `ON CONFLICT DO NOTHING` (both indexes arbitrate). Release B drops the old index.
-- Functions and grants are outside Drizzle's DDL scope.
-- The one select policy above shows an app-role connection only the account rows that name it as the principal; the policy alone grants nothing, so the
-- table privilege is stated too. CURRENT_USER is the app role BY CONSTRUCTION: scripts/db/migrate.mjs connects with DATABASE_URL, the very URL the app's
-- RLS-subject client uses; the service role (DATABASE_SERVICE_URL) never migrates. Keep that true in a fork, or grant to the app role by name.
-- agent_roles stays ENABLE + FORCE RLS; there is no write policy.
GRANT SELECT ON "agent_roles" TO CURRENT_USER;--> statement-breakpoint
-- The ONE live predicate for an account grant, in SQL. SECURITY INVOKER (it sees only what the agent_roles policy lets the caller see).
-- `hasLiveAccountGrant` in the package uses the same test, so the app check and row-level security cannot disagree.
CREATE OR REPLACE FUNCTION agent_has_scope(p_account_id text, p_scope text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.agent_roles r
    WHERE r.resource = 'account'
      AND r.principal_user_id = current_setting('app.current_user_id', true)
      AND r.scope = p_scope
      AND r.account_id = p_account_id
      AND r.approved_by IS NOT NULL
      AND r.revoked_at IS NULL
      AND (r.expires_at IS NULL OR r.expires_at > now())
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION agent_has_scope(text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION agent_has_scope(text, text) TO CURRENT_USER;

-- Delegated reads (select only) are the node's own: add one policy for every table of the node that holds an account's data and may be read with `account:read`,
-- after this file. Permissive policies OR together, so the owner policies stay as they are. node-template's two, as the shape to copy:
--   CREATE POLICY "agent_delegated_read" ON "billing_accounts" AS PERMISSIVE FOR SELECT TO public USING (agent_has_scope("id", 'account:read'));
--   CREATE POLICY "agent_delegated_read" ON "credit_ledger" AS PERMISSIVE FOR SELECT TO public USING (agent_has_scope("billing_account_id", 'account:read'));
