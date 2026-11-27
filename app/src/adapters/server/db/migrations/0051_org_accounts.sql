-- org accounts (task.0181, `@cogni-dao/agent-grants` 0.14.0): org_accounts, org_events (append only), org_wallet_holds, org_connections, org_service_principals and org_connect_jtis. The table part is
-- `defineAgentAuthoritySchema`'s, written by this node's db:generate; the hand-written part below is `packages/agent-grants/migrations/org_accounts.sql` byte for byte. payer_bindings moved
-- into the factory with no change to its DDL (0046 stays as it is). The prototype's tables on candidate-a (org_invites, org_link_codes, org_links) are not touched.
-- ORDER_IS_ENFORCED (task.0181): this feature adopts only after release B (0050) dropped the old (principal, scope) live index. If it still exists, stop here: the whole migration rolls back.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'agent_roles_live_unique') THEN
		RAISE EXCEPTION 'org accounts need grants release B first: agent_roles_live_unique still exists (deploy 0.13.0, then 0.14.0)';
	END IF;
END
$$;--> statement-breakpoint
CREATE TABLE "org_accounts" (
	"org_user_id" text PRIMARY KEY NOT NULL,
	"billing_account_id" text NOT NULL,
	"node_id" text NOT NULL,
	"origin" text NOT NULL,
	"dao" text,
	"admins" text[] DEFAULT '{}'::text[] NOT NULL,
	"services" text[] DEFAULT '{}'::text[] NOT NULL,
	"statement_version" bigint NOT NULL,
	"statement_commit" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"suspended_by" text,
	"suspend_reason" text,
	CONSTRAINT "org_accounts_suspension_is_complete" CHECK (("org_accounts"."suspended_at" IS NULL) = ("org_accounts"."suspended_by" IS NULL) AND ("org_accounts"."suspended_at" IS NULL) = ("org_accounts"."suspend_reason" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "org_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "org_connect_jtis" (
	"jti" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_connect_jtis" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "org_connections" (
	"origin" text PRIMARY KEY NOT NULL,
	"node_id" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"statement_version" bigint,
	"last_op" text DEFAULT 'connect' NOT NULL,
	CONSTRAINT "org_connections_status_canonical" CHECK ("org_connections"."status" IN ('connected','disconnected','suspended','unreachable')),
	CONSTRAINT "org_connections_last_op_canonical" CHECK ("org_connections"."last_op" IN ('connect','disconnect'))
);
--> statement-breakpoint
ALTER TABLE "org_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "org_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_user_id" text NOT NULL,
	"act" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_events_act_canonical" CHECK ("org_events"."act" IN ('org.connected','org.admins_changed','org.services_changed','org.disconnected','org.spend_granted','org.spend_claimed','org.spend_removed','org.suspended','org.restored','org.funded'))
);
--> statement-breakpoint
ALTER TABLE "org_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "org_service_principals" (
	"service_user_id" text PRIMARY KEY NOT NULL,
	"org_user_id" text NOT NULL,
	"service" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_service_principals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "org_wallet_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_user_id" text NOT NULL,
	"wallet" text NOT NULL,
	"scope" text NOT NULL,
	"granted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "org_wallet_holds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_accounts" ADD CONSTRAINT "org_accounts_org_user_id_users_id_fk" FOREIGN KEY ("org_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_accounts" ADD CONSTRAINT "org_accounts_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_accounts" ADD CONSTRAINT "org_accounts_suspended_by_users_id_fk" FOREIGN KEY ("suspended_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_connections" ADD CONSTRAINT "org_connections_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_events" ADD CONSTRAINT "org_events_org_user_id_users_id_fk" FOREIGN KEY ("org_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_service_principals" ADD CONSTRAINT "org_service_principals_org_user_id_users_id_fk" FOREIGN KEY ("org_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_wallet_holds" ADD CONSTRAINT "org_wallet_holds_org_user_id_users_id_fk" FOREIGN KEY ("org_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_wallet_holds" ADD CONSTRAINT "org_wallet_holds_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_accounts_origin_unique" ON "org_accounts" USING btree ("origin");--> statement-breakpoint
CREATE UNIQUE INDEX "org_accounts_node_id_unique" ON "org_accounts" USING btree ("node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_accounts_billing_account_unique" ON "org_accounts" USING btree ("billing_account_id");--> statement-breakpoint
CREATE INDEX "org_connect_jtis_expires_idx" ON "org_connect_jtis" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "org_events_org_time_idx" ON "org_events" USING btree ("org_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "org_events_funded_payment_unique" ON "org_events" USING btree ("org_user_id",("detail"->>'paymentRef')) WHERE "org_events"."act" = 'org.funded';--> statement-breakpoint
CREATE UNIQUE INDEX "org_service_principals_org_service_unique" ON "org_service_principals" USING btree ("org_user_id","service");--> statement-breakpoint
CREATE UNIQUE INDEX "org_wallet_holds_open_unique" ON "org_wallet_holds" USING btree ("org_user_id","wallet","scope") WHERE "org_wallet_holds"."claimed_at" IS NULL AND "org_wallet_holds"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "org_wallet_holds_wallet_idx" ON "org_wallet_holds" USING btree ("wallet");
--> statement-breakpoint

-- Hand-written below: FORCE RLS, the append-only history trigger and its privileges are outside Drizzle's DDL scope.
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
