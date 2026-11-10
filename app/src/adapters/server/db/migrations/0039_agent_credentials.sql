CREATE TABLE "agent_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_from" text NOT NULL,
	"predecessor_id" uuid,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"renew_until" timestamp with time zone NOT NULL,
	"pending_expires_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"revoked_by" text,
	CONSTRAINT "agent_credentials_created_from_canonical" CHECK ("agent_credentials"."created_from" IN ('spawn_grant','rotation','legacy_upgrade','binding_recovery','recovery_grant')),
	CONSTRAINT "agent_credentials_renew_after_expiry" CHECK ("agent_credentials"."renew_until" > "agent_credentials"."expires_at")
);
--> statement-breakpoint
ALTER TABLE "agent_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_predecessor_id_fk" FOREIGN KEY ("predecessor_id") REFERENCES "public"."agent_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_credentials_token_hash_unique" ON "agent_credentials" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_credentials_one_pending_successor" ON "agent_credentials" USING btree ("predecessor_id") WHERE "agent_credentials"."confirmed_at" IS NULL AND "agent_credentials"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "agent_credentials_user_idx" ON "agent_credentials" USING btree ("user_id");
--> statement-breakpoint
-- Hand-written below: FORCE RLS, a function and a trigger are outside Drizzle's DDL scope (same as 0027 / 0031 / 0036).
-- agent_credentials has NO policy: ENABLE + FORCE = deny-all for the app role. Only the BYPASSRLS service role reads or writes it.
ALTER TABLE "agent_credentials" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- STATE_IS_DERIVED: the one derivation of a credential's state from its timestamps, against the DATABASE clock. Never stored.
CREATE OR REPLACE FUNCTION agent_credential_state(c agent_credentials)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN c.revoked_at IS NOT NULL THEN 'revoked'
    WHEN c.confirmed_at IS NULL THEN CASE WHEN c.pending_expires_at > now() THEN 'pending' ELSE 'pending_expired' END
    WHEN c.expires_at > now() THEN 'active'
    WHEN c.renew_until > now() THEN 'renew_only'
    ELSE 'expired'
  END
$$;--> statement-breakpoint
-- CREDENTIALS_ONLY_ON_AGENT_PRINCIPALS: a credential may belong only to a user with an EXTERNAL agent_principals row. An internal
-- principal (this node's AI) never holds a key, and a plain user has no agent row until `upgrade` writes one.
CREATE OR REPLACE FUNCTION agent_credentials_require_external_principal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM agent_principals ap WHERE ap.user_id = NEW.user_id AND ap.kind = 'external') THEN
    RAISE EXCEPTION 'agent credential for % requires an external agent principal', NEW.user_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'agent_credentials_external_principal_only';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "agent_credentials_external_principal_only"
  BEFORE INSERT OR UPDATE OF user_id ON "agent_credentials"
  FOR EACH ROW EXECUTE FUNCTION agent_credentials_require_external_principal();
