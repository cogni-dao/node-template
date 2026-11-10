CREATE TABLE "agent_principals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"slug" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_principals_kind_canonical" CHECK ("agent_principals"."kind" IN ('internal','external')),
	CONSTRAINT "agent_principals_internal_has_slug" CHECK ("agent_principals"."kind" <> 'internal' OR "agent_principals"."slug" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "agent_principals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"principal_user_id" text NOT NULL,
	"scope" text NOT NULL,
	"approved_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_principals" ADD CONSTRAINT "agent_principals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_principal_user_id_users_id_fk" FOREIGN KEY ("principal_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_principals_slug_unique" ON "agent_principals" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_principals_user_id_unique" ON "agent_principals" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_roles_live_unique" ON "agent_roles" USING btree ("principal_user_id","scope") WHERE "agent_roles"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "agent_roles_principal_idx" ON "agent_roles" USING btree ("principal_user_id");--> statement-breakpoint
CREATE POLICY "agent_principals_read" ON "agent_principals" AS PERMISSIVE FOR SELECT TO public USING (true);
--> statement-breakpoint
-- Hand-written below: FORCE RLS and a trigger are outside Drizzle's DDL scope (same as 0027 / 0031).
-- agent_roles has NO policy: ENABLE + FORCE = deny-all for the app role. Only the BYPASSRLS service role reads or
-- writes it (the guard, the role routes). agent_principals is readable by all roles, writable only by the service role.
ALTER TABLE "agent_principals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_roles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- AGENTS_HOLD_NO_WALLET (a payout guard: no user-centric payout reaches an AI), enforced in the database on every binding path (SIWE, import, operator-attested): a user that has
-- an agent_principals row can never bind a wallet. This is a kind-based payout guard, not an admin rule: an AI admin needs no wallet.
CREATE OR REPLACE FUNCTION agent_principals_refuse_wallet_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.provider = 'wallet'
     AND EXISTS (SELECT 1 FROM agent_principals ap WHERE ap.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'agent principal % cannot bind a wallet', NEW.user_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'agent_principals_no_wallet_binding';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "agent_principals_no_wallet_binding"
  BEFORE INSERT OR UPDATE OF user_id, provider ON "user_bindings"
  FOR EACH ROW EXECUTE FUNCTION agent_principals_refuse_wallet_binding();
