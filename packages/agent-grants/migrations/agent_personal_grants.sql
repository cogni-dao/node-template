-- agent_roles personal grants + the `agent_has_scope` RLS function: the FINAL shape a node applies for personal (owner-approved) grants (`authorizeAccount()` in `@cogni-dao/agent-grants`).
-- node-template keeps it as `0042_agent_roles_personal.sql`. Do not copy it blind into a fork: generate the table part with the node's own `db:generate`, then append the
-- hand-written part (everything after the line `Hand-written below`). It needs `agent_roles`, `agent_principals` (with `owner_user_id`, the spawn-grant migration) and `billing_accounts`.
-- EXPAND-ONLY: every existing role row is a node row (the default). Node reads in the package filter on resource_kind = 'node'.
ALTER TABLE "agent_roles" ADD COLUMN "resource_kind" text DEFAULT 'node' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_resource_kind_canonical" CHECK ("agent_roles"."resource_kind" IN ('node','own','account'));--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_owner_shape" CHECK (("agent_roles"."resource_kind" = 'node') = ("agent_roles"."owner_user_id" IS NULL));--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_personal_approver" CHECK ("agent_roles"."resource_kind" = 'node' OR "agent_roles"."approved_by" IS NULL OR ("agent_roles"."approved_by" = "agent_roles"."owner_user_id" AND "agent_roles"."approved_by" <> "agent_roles"."principal_user_id" AND "agent_roles"."expires_at" IS NOT NULL));
--> statement-breakpoint
-- Hand-written below: a function and policies are outside Drizzle's DDL scope (same as 0027 / 0031 / 0036 / 0039). EXPAND-ONLY: three nullable or defaulted
-- columns and three CHECKs on a table whose every existing row is a node row (the DEFAULT 'node' backfills them; each CHECK holds for node rows with no owner).
-- A personal grant is the owner's decision (approved_by = owner_user_id, never the agent) and always ends (expires_at). Node reads in the package filter on resource_kind = 'node'.
--
-- agent_has_scope: the RLS twin of the package's `authorizeAccount()`. The context user (`app.current_user_id`) is the agent. It is true only for a live personal
-- grant: this agent, whose owner is p_owner, holding p_scope as a non-node row the owner approved, not revoked, not expired, by the DATABASE clock. SECURITY INVOKER: it reads
-- agent_roles as the caller, through the one select policy below. No context user, an unknown agent or an expired row is false (deny by default).
CREATE OR REPLACE FUNCTION agent_has_scope(p_owner text, p_scope text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM agent_roles r
    JOIN agent_principals ap ON ap.user_id = r.principal_user_id
    WHERE r.principal_user_id = nullif(current_setting('app.current_user_id', true), '')
      AND r.owner_user_id = p_owner
      AND ap.owner_user_id = p_owner
      AND r.approved_by = p_owner
      AND r.scope = p_scope
      AND r.resource_kind <> 'node'
      AND r.revoked_at IS NULL
      AND r.expires_at > now()
  )
$$;--> statement-breakpoint
-- agent_roles stays FORCE RLS and written only by the service role. This ONE select policy lets an agent read its OWN personal rows as the app role,
-- so agent_has_scope can see its grant. Node rows (resource_kind = 'node') stay deny-all for the app role.
CREATE POLICY "agent_roles_personal_read" ON "agent_roles"
  AS PERMISSIVE FOR SELECT TO public
  USING ("resource_kind" <> 'node' AND "principal_user_id" = current_setting('app.current_user_id', true));--> statement-breakpoint
-- The grant-read policy (Poly 0074 shape): SELECT only, PERMISSIVE, next to the owner's tenant_isolation, which is unchanged. An agent with a live account:read
-- grant from the account's owner sees that one row. It cannot write it: UPDATE and DELETE still need tenant_isolation.
CREATE POLICY "billing_accounts_agent_grant_read" ON "billing_accounts"
  AS PERMISSIVE FOR SELECT TO public
  USING (agent_has_scope("owner_user_id", 'account:read'));
