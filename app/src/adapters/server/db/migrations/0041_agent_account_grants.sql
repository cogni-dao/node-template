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
-- Hand-written below: functions, grants and policies on other tables are outside Drizzle's DDL scope (same as 0036 / 0039).
-- EXPAND-ONLY (task.5465): six nullable or defaulted columns and five CHECKs on a table whose every existing row is a node row (DEFAULT 'node'
-- backfills the resource; each CHECK holds for a node row with no account and no end). agent_roles_live_unique and the old ON CONFLICT
-- targets are kept, so a pod on the previous release keeps working while this migration is applied.
--
-- R11: agent_roles stays ENABLE + FORCE RLS. The one select policy above shows an app-role connection only the account rows that name it
-- as the principal. The policy alone grants nothing, so the table privilege is stated here too.
-- CURRENT_USER is the app role BY CONSTRUCTION: the migrating role equals the runtime role. scripts/db/migrate.mjs (the initContainer, copied to
-- /app/app/migrate.mjs) connects with DATABASE_URL, the very URL the app's RLS-subject client uses (drizzle.client.ts); the service role is
-- DATABASE_SERVICE_URL and never migrates. app/tests/unit/app/migration-role.test.ts and the component suite fail if the two ever differ.
GRANT SELECT ON "agent_roles" TO CURRENT_USER;--> statement-breakpoint
-- The ONE live predicate for an account grant, in SQL. SECURITY INVOKER: it runs with the caller's rights and sees only what the
-- agent_roles policy lets that caller see, so RLS cannot be widened by the function. `authorizeAccount()` in @cogni-dao/agent-grants
-- uses the same test (hasLiveAccountGrant), so the app check and RLS cannot disagree.
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
-- Delegated reads (select only): a bearer agent with a live account:read grant reads that one account and its ledger. The owner policies
-- (0004) are unchanged; permissive policies OR together.
CREATE POLICY "agent_delegated_read" ON "billing_accounts" AS PERMISSIVE FOR SELECT TO public
  USING (agent_has_scope("id", 'account:read'));--> statement-breakpoint
CREATE POLICY "agent_delegated_read" ON "credit_ledger" AS PERMISSIVE FOR SELECT TO public
  USING (agent_has_scope("billing_account_id", 'account:read'));
