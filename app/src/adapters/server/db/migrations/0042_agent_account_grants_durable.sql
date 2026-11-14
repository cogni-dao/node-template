-- Account grants are DURABLE (task.5465): an account row lasts until Off, exactly like a node row. The person asks once and keeps it for months; no end date is picked.
-- 0041 (already applied on candidate-a, so it is not edited) required an end within 30 days. This migration relaxes the CHECK so `expires_at` may be NULL, and
-- keeps the expired state for any row that already carries an end (R14: expired is read from expires_at, never written). EXPAND-ONLY and idempotent: every
-- existing row still satisfies the new CHECK; DROP-then-ADD, CREATE OR REPLACE, and the grants are re-issued.
ALTER TABLE "agent_roles" DROP CONSTRAINT IF EXISTS "agent_roles_account_live_shape";--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_account_live_shape" CHECK ("agent_roles"."resource" <> 'account' OR "agent_roles"."approved_by" IS NULL OR ("agent_roles"."account_id" IS NOT NULL AND "agent_roles"."granted_at" IS NOT NULL AND ("agent_roles"."expires_at" IS NULL OR "agent_roles"."expires_at" > "agent_roles"."granted_at")));--> statement-breakpoint
-- The ONE live predicate, in SQL, now null-safe: no end date, or an end in the future. `hasLiveAccountGrant` in the package uses the same test.
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
