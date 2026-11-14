-- agent_roles account grants: the FINAL shape a node applies for account-resource grants (`@cogni-dao/agent-grants` 0.6.0, `authorizeAccount`, `approveAccountAsk`).
-- node-template keeps it as `0041_agent_account_grants.sql`. Do not copy it blind into a fork: generate the column and constraint part with the node's own
-- `db:generate` (add the new columns and CHECKs to the node's `agentRoles` schema, with the one select policy), then append the hand-written part
-- (everything after the line `Hand-written below`). It needs `agent_roles` (0036 + 0038 shape) and `billing_accounts`.
-- EXPAND-ONLY: every existing role row is a node row (the DEFAULT 'node' backfills `resource`; each CHECK holds for a node row with no account and no end).
-- Keep `agent_roles_live_unique` (principal, scope) and the old ON CONFLICT targets: a pod on the previous release keeps working. The contract migration (task.5484) replaces it.
ALTER TABLE "agent_roles" ADD COLUMN "resource" text DEFAULT 'node' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD COLUMN "account_id" text;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD COLUMN "link_hash" text;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD COLUMN "link_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD COLUMN "link_consumed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_account_id_billing_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_roles_link_hash_unique" ON "agent_roles" USING btree ("link_hash");--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_resource_canonical" CHECK ("agent_roles"."resource" IN ('node','account'));--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_node_shape" CHECK ("agent_roles"."resource" <> 'node' OR ("agent_roles"."account_id" IS NULL AND "agent_roles"."expires_at" IS NULL));--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_account_live_shape" CHECK ("agent_roles"."resource" <> 'account' OR "agent_roles"."approved_by" IS NULL OR ("agent_roles"."account_id" IS NOT NULL AND "agent_roles"."granted_at" IS NOT NULL AND "agent_roles"."expires_at" IS NOT NULL AND "agent_roles"."expires_at" > "agent_roles"."granted_at" AND "agent_roles"."expires_at" <= "agent_roles"."granted_at" + interval '30 days'));--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_no_self_approval" CHECK ("agent_roles"."approved_by" IS NULL OR "agent_roles"."approved_by" <> "agent_roles"."principal_user_id");--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_link_consumed_has_no_hash" CHECK ("agent_roles"."link_consumed_at" IS NULL OR "agent_roles"."link_hash" IS NULL);--> statement-breakpoint
CREATE POLICY "agent_roles_account_self_read" ON "agent_roles" AS PERMISSIVE FOR SELECT TO public USING ("agent_roles"."resource" = 'account' AND "agent_roles"."principal_user_id" = current_setting('app.current_user_id', true));
--> statement-breakpoint
-- Hand-written below: functions, grants and policies on other tables are outside Drizzle's DDL scope.
-- The one select policy above shows an app-role connection only the account rows that name it as the principal; the policy alone grants nothing, so the
-- table privilege is stated too (the migrating role is the app role). agent_roles stays ENABLE + FORCE RLS; there is no write policy.
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
      AND r.expires_at > now()
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION agent_has_scope(text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION agent_has_scope(text, text) TO CURRENT_USER;--> statement-breakpoint
-- Delegated reads (select only). Add one such policy for every table of the node that holds an account's data and may be read with `account:read`.
-- Permissive policies OR together, so the owner policies stay as they are.
CREATE POLICY "agent_delegated_read" ON "billing_accounts" AS PERMISSIVE FOR SELECT TO public
  USING (agent_has_scope("id", 'account:read'));--> statement-breakpoint
CREATE POLICY "agent_delegated_read" ON "credit_ledger" AS PERMISSIVE FOR SELECT TO public
  USING (agent_has_scope("billing_account_id", 'account:read'));
