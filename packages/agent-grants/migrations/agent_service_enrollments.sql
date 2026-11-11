-- agent_service_enrollments migration template (@cogni-dao/agent-grants 0.4.0, story.0038).
--
-- This is the FINAL shape a node applies for `@cogni-dao/agent-grants/enrollment`: node-template's `0041_agent_service_enrollments.sql`. Do not copy it blind into a fork:
--
-- 1. Needs `agent_principals` (0036 shape) and `agent_credentials` (`agent_credentials.sql` in this folder, which already holds the 0039 and 0040 shape) first.
-- 2. Add the `agentServiceEnrollments` table and the `service_key` column of `agentPrincipals` to the node's own schema package, and add
--    `'service_enrollment'` to the `agent_credentials_created_from_canonical` CHECK, then run the node's `db:generate`. drizzle-kit writes the DDL
--    (everything above the line `Hand-written below`) and the snapshot against the node's own prior snapshot. Never copy a snapshot.
--    A fork that applied `agent_credentials.sql` with the older CHECK must also run the DROP and ADD of that CHECK (the first and last statements here).
-- 3. Append the hand-written part (everything after the line `Hand-written below`): FORCE RLS and the sibling-revoking trigger. Drizzle cannot emit them.
-- 4. Run `db:check`. The journal `when` must be greater than every earlier entry. Apply the migration BEFORE the code serves traffic.
--
-- The store needs a BYPASSRLS (service role) connection, like `agent_credentials`: the tables have no policy, so the app role sees nothing.

CREATE TABLE "agent_service_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jti" text NOT NULL,
	"issuer" text NOT NULL,
	"service" text NOT NULL,
	"principal_user_id" text NOT NULL,
	"scope" text NOT NULL,
	"device_code_hash" text NOT NULL,
	"cnf_jwk" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"credential_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_polled_at" timestamp with time zone,
	CONSTRAINT "agent_service_enrollments_status_canonical" CHECK ("agent_service_enrollments"."status" IN ('open','redeemed','denied','expired'))
);
--> statement-breakpoint
ALTER TABLE "agent_service_enrollments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_credentials" DROP CONSTRAINT "agent_credentials_created_from_canonical";--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN "service_key" text;--> statement-breakpoint
ALTER TABLE "agent_service_enrollments" ADD CONSTRAINT "agent_service_enrollments_principal_user_id_users_id_fk" FOREIGN KEY ("principal_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_service_enrollments" ADD CONSTRAINT "agent_service_enrollments_credential_id_agent_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."agent_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_service_enrollments_jti_unique" ON "agent_service_enrollments" USING btree ("jti");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_service_enrollments_device_code_hash_unique" ON "agent_service_enrollments" USING btree ("device_code_hash");--> statement-breakpoint
CREATE INDEX "agent_service_enrollments_principal_idx" ON "agent_service_enrollments" USING btree ("principal_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_principals_service_key_unique" ON "agent_principals" USING btree ("service_key");--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_created_from_canonical" CHECK ("agent_credentials"."created_from" IN ('spawn_grant','rotation','key_upgrade','binding_recovery','recovery_grant','service_enrollment'));
--> statement-breakpoint
-- Hand-written below: FORCE RLS and a trigger are outside Drizzle's DDL scope (same as 0027 / 0031 / 0036 / 0039).
-- agent_service_enrollments has NO policy: ENABLE + FORCE = deny-all for the app role. Only the BYPASSRLS service role reads or writes it.
ALTER TABLE "agent_service_enrollments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- ENROLLED_KEY_REPLACES_SIBLINGS: when a key made by a service enrollment is CONFIRMED, every other unrevoked key of that principal dies in
-- the same statement (a re-enrollment replaces the older keys only once the new key is stored). Keys made any other way never fire it.
-- It is a trigger so it holds for every writer of `confirmed_at` and the credential store (confirm) needs no special case.
CREATE OR REPLACE FUNCTION agent_credentials_enrollment_confirm_revokes_siblings()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE agent_credentials
     SET revoked_at = now(), revoked_reason = 'superseded'
   WHERE user_id = NEW.user_id AND id <> NEW.id AND revoked_at IS NULL;
  RETURN NULL;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_credentials_enrollment_confirm_siblings" ON "agent_credentials";--> statement-breakpoint
CREATE TRIGGER "agent_credentials_enrollment_confirm_siblings"
  AFTER UPDATE OF confirmed_at ON "agent_credentials"
  FOR EACH ROW
  WHEN (OLD.confirmed_at IS NULL AND NEW.confirmed_at IS NOT NULL AND NEW.created_from = 'service_enrollment')
  EXECUTE FUNCTION agent_credentials_enrollment_confirm_revokes_siblings();
