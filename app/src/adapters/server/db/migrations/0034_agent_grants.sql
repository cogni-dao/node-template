CREATE TABLE "agent_access_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requester_principal_id" text NOT NULL,
	"requester_display_name" text,
	"requested_scopes" text[] NOT NULL,
	"grant_expires_at" timestamp with time zone NOT NULL,
	"approval_token_hash" text NOT NULL,
	"approval_token_expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"billing_account_id" text,
	"approved_grant_id" uuid,
	"decision_by_user_id" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_access_requests_status_canonical" CHECK ("agent_access_requests"."status" IN ('pending','approved','denied','expired','revoked')),
	CONSTRAINT "agent_access_requests_scopes_nonempty" CHECK (cardinality("agent_access_requests"."requested_scopes") > 0)
);
--> statement-breakpoint
ALTER TABLE "agent_access_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_capability_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"billing_account_id" text NOT NULL,
	"grantee_principal_id" text NOT NULL,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by_user_id" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_capability_grants_scopes_nonempty" CHECK (cardinality("agent_capability_grants"."scopes") > 0),
	CONSTRAINT "agent_capability_grants_expiry_after_creation" CHECK ("agent_capability_grants"."expires_at" > "agent_capability_grants"."created_at"),
	CONSTRAINT "agent_capability_grants_revocation_audit" CHECK (("agent_capability_grants"."revoked_at" IS NULL AND "agent_capability_grants"."revoked_by_user_id" IS NULL) OR ("agent_capability_grants"."revoked_at" IS NOT NULL AND "agent_capability_grants"."revoked_by_user_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "agent_capability_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"key_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_access_requests" ADD CONSTRAINT "agent_access_requests_requester_principal_id_users_id_fk" FOREIGN KEY ("requester_principal_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_access_requests" ADD CONSTRAINT "agent_access_requests_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_access_requests" ADD CONSTRAINT "agent_access_requests_approved_grant_id_agent_capability_grants_id_fk" FOREIGN KEY ("approved_grant_id") REFERENCES "public"."agent_capability_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_access_requests" ADD CONSTRAINT "agent_access_requests_decision_by_user_id_users_id_fk" FOREIGN KEY ("decision_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_capability_grants" ADD CONSTRAINT "agent_capability_grants_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_capability_grants" ADD CONSTRAINT "agent_capability_grants_grantee_principal_id_users_id_fk" FOREIGN KEY ("grantee_principal_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_capability_grants" ADD CONSTRAINT "agent_capability_grants_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_capability_grants" ADD CONSTRAINT "agent_capability_grants_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_access_requests_token_hash_idx" ON "agent_access_requests" USING btree ("approval_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_access_requests_requester_pending_idx" ON "agent_access_requests" USING btree ("requester_principal_id") WHERE "agent_access_requests"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "agent_capability_grants_current_idx" ON "agent_capability_grants" USING btree ("billing_account_id","grantee_principal_id") WHERE "agent_capability_grants"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "agent_capability_grants_grantee_active_idx" ON "agent_capability_grants" USING btree ("grantee_principal_id","expires_at");--> statement-breakpoint
CREATE INDEX "agent_capability_grants_account_created_idx" ON "agent_capability_grants" USING btree ("billing_account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_credentials_key_hash_idx" ON "agent_credentials" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "agent_credentials_user_idx" ON "agent_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE POLICY "agent_access_requests_select" ON "agent_access_requests" AS PERMISSIVE FOR SELECT TO public USING ("agent_access_requests"."requester_principal_id" = current_setting('app.current_user_id', true)
        OR "agent_access_requests"."billing_account_id" IN (
          SELECT id FROM billing_accounts
          WHERE owner_user_id = current_setting('app.current_user_id', true)
        )
        OR (
          "agent_access_requests"."status" = 'pending'
          AND "agent_access_requests"."approval_token_hash" = current_setting('app.agent_access_request_token_hash', true)
          AND "agent_access_requests"."approval_token_expires_at" > now()
        ));--> statement-breakpoint
CREATE POLICY "agent_access_requests_insert" ON "agent_access_requests" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("agent_access_requests"."requester_principal_id" = current_setting('app.current_user_id', true)
        AND "agent_access_requests"."status" = 'pending'
        AND "agent_access_requests"."billing_account_id" IS NULL
        AND "agent_access_requests"."approved_grant_id" IS NULL
        AND "agent_access_requests"."decision_by_user_id" IS NULL);--> statement-breakpoint
CREATE POLICY "agent_access_requests_requester_expire" ON "agent_access_requests" AS PERMISSIVE FOR UPDATE TO public USING ("agent_access_requests"."requester_principal_id" = current_setting('app.current_user_id', true)
        AND "agent_access_requests"."status" = 'pending'
        AND "agent_access_requests"."approval_token_expires_at" <= now()) WITH CHECK ("agent_access_requests"."requester_principal_id" = current_setting('app.current_user_id', true)
        AND "agent_access_requests"."status" = 'expired'
        AND "agent_access_requests"."billing_account_id" IS NULL
        AND "agent_access_requests"."approved_grant_id" IS NULL
        AND "agent_access_requests"."decision_by_user_id" IS NULL);--> statement-breakpoint
CREATE POLICY "agent_access_requests_owner_update" ON "agent_access_requests" AS PERMISSIVE FOR UPDATE TO public USING ("agent_access_requests"."billing_account_id" IN (
          SELECT id FROM billing_accounts
          WHERE owner_user_id = current_setting('app.current_user_id', true)
        ) OR (
          "agent_access_requests"."status" = 'pending'
          AND "agent_access_requests"."approval_token_hash" = current_setting('app.agent_access_request_token_hash', true)
          AND "agent_access_requests"."approval_token_expires_at" > now()
        )) WITH CHECK ("agent_access_requests"."billing_account_id" IN (
          SELECT id FROM billing_accounts
          WHERE owner_user_id = current_setting('app.current_user_id', true)
        )
        AND "agent_access_requests"."decision_by_user_id" = current_setting('app.current_user_id', true));--> statement-breakpoint
CREATE POLICY "agent_capability_grants_select" ON "agent_capability_grants" AS PERMISSIVE FOR SELECT TO public USING ("agent_capability_grants"."created_by_user_id" = current_setting('app.current_user_id', true)
        OR "agent_capability_grants"."grantee_principal_id" = current_setting('app.current_user_id', true));--> statement-breakpoint
CREATE POLICY "agent_capability_grants_insert" ON "agent_capability_grants" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("agent_capability_grants"."billing_account_id" IN (
        SELECT id FROM billing_accounts
        WHERE owner_user_id = current_setting('app.current_user_id', true)
      ) AND "agent_capability_grants"."created_by_user_id" = current_setting('app.current_user_id', true));--> statement-breakpoint
CREATE POLICY "agent_capability_grants_update" ON "agent_capability_grants" AS PERMISSIVE FOR UPDATE TO public USING ("agent_capability_grants"."billing_account_id" IN (
        SELECT id FROM billing_accounts
        WHERE owner_user_id = current_setting('app.current_user_id', true)
      )) WITH CHECK ("agent_capability_grants"."billing_account_id" IN (
        SELECT id FROM billing_accounts
        WHERE owner_user_id = current_setting('app.current_user_id', true)
      ));--> statement-breakpoint
-- Hand-written below: FORCE RLS, SQL functions, and a policy on an existing
-- table are outside Drizzle's DDL scope (same as 0031 / 0033).
-- Without FORCE the table owner (app role) bypasses RLS entirely.
-- agent_credentials has NO policy: ENABLE + FORCE = deny-all for the app role;
-- only the BYPASSRLS service role reads/writes it (register, bearer resolver,
-- self-revoke).
ALTER TABLE "agent_credentials" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_capability_grants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_access_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- RLS backstop (node-capability-grants-standard row 4). The delegated half:
-- a live (unrevoked, unexpired) grant to the current principal carrying the
-- exact scope. Grant-only on purpose: billing_accounts' delegated policy calls
-- it, and an owner branch reading billing_accounts would recurse.
CREATE OR REPLACE FUNCTION agent_grant_has_scope(p_account_id text, p_scope text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM agent_capability_grants g
    WHERE g.billing_account_id = p_account_id
      AND g.grantee_principal_id = current_setting('app.current_user_id', true)
      AND g.revoked_at IS NULL
      AND g.expires_at > now()
      AND p_scope = ANY (g.scopes)
  )
$$;--> statement-breakpoint
-- The full decision authorize() mirrors: owner OR delegated grant.
CREATE OR REPLACE FUNCTION agent_has_scope(p_account_id text, p_scope text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM billing_accounts ba
    WHERE ba.id = p_account_id
      AND ba.owner_user_id = current_setting('app.current_user_id', true)
  ) OR agent_grant_has_scope(p_account_id, p_scope)
$$;--> statement-breakpoint
-- Delegated account read: a grantee holding `account:read` may SELECT the
-- granted billing account row (credit balance). Owner reads stay on
-- tenant_isolation (0004); writes are unchanged.
CREATE POLICY "agent_delegated_read" ON "billing_accounts"
  AS PERMISSIVE FOR SELECT TO public
  USING (agent_grant_has_scope("billing_accounts"."id", 'account:read'));
