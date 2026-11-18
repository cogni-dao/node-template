-- Service enrollment (story.0038): the target-side provider and the requester's durable operations, as ONE forward, EXPAND-ONLY migration.
-- Collapses PRs #342/#345's ten steps (0041..0050) after main's 0042. DDL is the generated final shape (new tables, new nullable or defaulted columns, new
-- indexes; the two CHECKs it widens are added NOT VALID then validated, the FKs it adds on existing tables likewise). No LOCK TABLE, no row-level security
-- toggling of existing tables and no backfill UPDATE of existing rows: legacy confirmed keys are read through agent_credentials (everConfirmed), and an unfilled
-- audit summary only makes a legacy row ineligible for the (disabled) purge, never eligible. Audit purge stays OFF until a separate, batched backfill qualifies it.
-- Hand-written below the DDL: functions, triggers, FORCE RLS of the new tables and the maintenance row (function bodies reduced to their final version).
-- IDEMPOTENT ON A DIRTY DATABASE: every CREATE is IF NOT EXISTS, every ADD is preceded by its DROP IF EXISTS, every trigger is dropped before it is created.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_authority_maintenance" (
	"id" text PRIMARY KEY NOT NULL,
	"backfill_ready" boolean DEFAULT false NOT NULL,
	"purge_enabled" boolean DEFAULT false NOT NULL,
	"minimum_reader_build" text,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"oldest_due_at" timestamp with time zone,
	"cursor_expires_at" timestamp with time zone,
	"cursor_enrollment_id" uuid,
	"audit_cursors" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "agent_authority_purge_qualified" CHECK (NOT "agent_authority_maintenance"."purge_enabled" OR ("agent_authority_maintenance"."backfill_ready" AND "agent_authority_maintenance"."minimum_reader_build" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "agent_authority_maintenance" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_service_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jti" text NOT NULL,
	"operation_id" uuid,
	"generation" bigint,
	"original_start_iat" timestamp with time zone,
	"original_start_exp" timestamp with time zone,
	"original_token_digest" text,
	"intent_digest" text,
	"canonical_intent" text,
	"sealed_acceptance" text,
	"sealed_pending_key" text,
	"pending_expires_at" timestamp with time zone,
	"purge_after" timestamp with time zone,
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
	"historical_confirmed_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"last_polled_at" timestamp with time zone,
	CONSTRAINT "agent_service_enrollments_status_canonical" CHECK ("agent_service_enrollments"."status" IN ('open','redeemed','denied','expired'))
);
--> statement-breakpoint
ALTER TABLE "agent_service_enrollments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_service_link_operations" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"key_digest" text NOT NULL,
	"home_node_id" uuid NOT NULL,
	"home_environment" text NOT NULL,
	"home_origin" text NOT NULL,
	"service" text NOT NULL,
	"billing_account_id" text NOT NULL,
	"target_node_id" uuid NOT NULL,
	"target_environment" text NOT NULL,
	"target_origin" text NOT NULL,
	"generation" bigint NOT NULL,
	"phase" text NOT NULL,
	"current" boolean DEFAULT true NOT NULL,
	"state" jsonb NOT NULL,
	"encrypted_secrets" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"fence" integer DEFAULT 0 NOT NULL,
	"lease_owner" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"secret_deadline" timestamp with time zone NOT NULL,
	"staged_connection_id" uuid,
	"confirm_authorized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"terminal_at" timestamp with time zone,
	"purge_after" timestamp with time zone,
	"audit_compacted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_service_link_operations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_service_quotas" (
	"subject" text NOT NULL,
	"kind" text NOT NULL,
	"hour" bigint NOT NULL,
	"count" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_service_quotas" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_credentials" DROP CONSTRAINT IF EXISTS "agent_credentials_created_from_canonical";
--> statement-breakpoint
ALTER TABLE "connections" DROP CONSTRAINT IF EXISTS "connections_provider_check";
--> statement-breakpoint
DROP INDEX IF EXISTS "connections_billing_account_provider_active_idx";
--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD COLUMN IF NOT EXISTS "predecessor_provenance_id" uuid;
--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD COLUMN IF NOT EXISTS "service_operation_id" uuid;
--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD COLUMN IF NOT EXISTS "service_generation" bigint;
--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD COLUMN IF NOT EXISTS "purge_after" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN IF NOT EXISTS "service_key" text;
--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN IF NOT EXISTS "home_node_id" uuid;
--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN IF NOT EXISTS "home_environment" text;
--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN IF NOT EXISTS "home_origin" text;
--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN IF NOT EXISTS "home_service" text;
--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN IF NOT EXISTS "current_generation" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN IF NOT EXISTS "current_operation_id" uuid;
--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN IF NOT EXISTS "current_operation_digest" text;
--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN IF NOT EXISTS "ever_confirmed" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN IF NOT EXISTS "first_confirmed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN IF NOT EXISTS "active_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN IF NOT EXISTS "maintenance_after" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "agent_roles" ADD COLUMN IF NOT EXISTS "enrollment_operation_id" uuid;
--> statement-breakpoint
ALTER TABLE "agent_roles" ADD COLUMN IF NOT EXISTS "request_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "agent_roles" ADD COLUMN IF NOT EXISTS "closed_reason" text;
--> statement-breakpoint
ALTER TABLE "agent_roles" ADD COLUMN IF NOT EXISTS "purge_after" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "service_key_digest" text;
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "service_identity" jsonb;
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "service_operation_id" uuid;
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "service_generation" bigint;
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "service_credential_id" uuid;
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "service_state" text;
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "renew_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "agent_service_enrollments" DROP CONSTRAINT IF EXISTS "agent_service_enrollments_principal_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_service_enrollments" ADD CONSTRAINT "agent_service_enrollments_principal_user_id_users_id_fk" FOREIGN KEY ("principal_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_service_enrollments" DROP CONSTRAINT IF EXISTS "agent_service_enrollments_credential_id_agent_credentials_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_service_enrollments" ADD CONSTRAINT "agent_service_enrollments_credential_id_agent_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."agent_credentials"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_service_link_operations" DROP CONSTRAINT IF EXISTS "agent_service_link_operations_billing_account_id_billing_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_service_link_operations" ADD CONSTRAINT "agent_service_link_operations_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_service_link_operations" DROP CONSTRAINT IF EXISTS "agent_service_link_operations_staged_connection_id_connections_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_service_link_operations" ADD CONSTRAINT "agent_service_link_operations_staged_connection_id_connections_id_fk" FOREIGN KEY ("staged_connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_service_enrollments_operation_unique" ON "agent_service_enrollments" USING btree ("operation_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_service_enrollments_generation_unique" ON "agent_service_enrollments" USING btree ("principal_user_id","generation");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_service_enrollments_delivery_idx" ON "agent_service_enrollments" USING btree ("expires_at","id") WHERE "agent_service_enrollments"."sealed_acceptance" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_service_enrollments_pending_delivery_idx" ON "agent_service_enrollments" USING btree ("pending_expires_at","id") WHERE "agent_service_enrollments"."sealed_pending_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_service_enrollments_purge_idx" ON "agent_service_enrollments" USING btree ("purge_after","id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_service_enrollments_jti_unique" ON "agent_service_enrollments" USING btree ("jti");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_service_enrollments_device_code_hash_unique" ON "agent_service_enrollments" USING btree ("device_code_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_service_enrollments_credential_idx" ON "agent_service_enrollments" USING btree ("credential_id","id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_service_enrollments_principal_idx" ON "agent_service_enrollments" USING btree ("principal_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_service_enrollments_open_expiry_idx" ON "agent_service_enrollments" USING btree ("expires_at","id") WHERE "agent_service_enrollments"."status" = 'open';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_service_enrollments_open_principal_idx" ON "agent_service_enrollments" USING btree ("principal_user_id","expires_at","id") WHERE "agent_service_enrollments"."status" = 'open';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_service_links_identity_unique" ON "agent_service_link_operations" USING btree ("home_node_id","home_environment","home_origin","service","billing_account_id","target_node_id","target_environment","target_origin") WHERE "agent_service_link_operations"."current";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_service_links_key_unique" ON "agent_service_link_operations" USING btree ("key_digest") WHERE "agent_service_link_operations"."current";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_service_links_connection_idx" ON "agent_service_link_operations" USING btree ("staged_connection_id","operation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_service_links_purge_idx" ON "agent_service_link_operations" USING btree ("purge_after","operation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_service_links_due_idx" ON "agent_service_link_operations" USING btree ("next_attempt_at","operation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_service_links_staged_expiry_idx" ON "agent_service_link_operations" USING btree ("secret_deadline","operation_id") WHERE "agent_service_link_operations"."staged_connection_id" IS NOT NULL AND COALESCE("agent_service_link_operations"."state"->>'quarantined','false') <> 'true' AND "agent_service_link_operations"."phase" <> 'expired';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_service_links_secret_idx" ON "agent_service_link_operations" USING btree ("secret_deadline","operation_id") WHERE "agent_service_link_operations"."encrypted_secrets" IS NOT NULL AND "agent_service_link_operations"."staged_connection_id" IS NULL AND "agent_service_link_operations"."confirm_authorized_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_service_quotas_bucket_unique" ON "agent_service_quotas" USING btree ("subject","kind","hour");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_service_quotas_hour_idx" ON "agent_service_quotas" USING btree ("hour");
--> statement-breakpoint
ALTER TABLE "agent_credentials" DROP CONSTRAINT IF EXISTS "agent_credentials_service_operation_id_agent_service_enrollments_operation_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_service_operation_id_agent_service_enrollments_operation_id_fk" FOREIGN KEY ("service_operation_id") REFERENCES "public"."agent_service_enrollments"("operation_id") ON DELETE no action ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "agent_roles" DROP CONSTRAINT IF EXISTS "agent_roles_enrollment_operation_id_agent_service_enrollments_operation_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_enrollment_operation_id_agent_service_enrollments_operation_id_fk" FOREIGN KEY ("enrollment_operation_id") REFERENCES "public"."agent_service_enrollments"("operation_id") ON DELETE no action ON UPDATE no action NOT VALID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_credentials_purge_idx" ON "agent_credentials" USING btree ("purge_after","id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_credentials_service_operation_idx" ON "agent_credentials" USING btree ("service_operation_id","id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_credentials_confirmed_predecessor_idx" ON "agent_credentials" USING btree ("predecessor_id","id") WHERE "agent_credentials"."confirmed_at" IS NOT NULL AND "agent_credentials"."predecessor_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_credentials_predecessor_idx" ON "agent_credentials" USING btree ("predecessor_id","id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_credentials_confirmed_history_idx" ON "agent_credentials" USING btree ("user_id","confirmed_at") WHERE "agent_credentials"."confirmed_at" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_credentials_usable_idx" ON "agent_credentials" USING btree ("user_id","renew_until","id") WHERE "agent_credentials"."revoked_at" IS NULL AND "agent_credentials"."confirmed_at" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_credentials_pending_non_enrollment_idx" ON "agent_credentials" USING btree ("user_id","pending_expires_at","id") WHERE "agent_credentials"."revoked_at" IS NULL AND "agent_credentials"."confirmed_at" IS NULL AND "agent_credentials"."created_from" <> 'service_enrollment';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_credentials_pending_idx" ON "agent_credentials" USING btree ("user_id","pending_expires_at","id") WHERE "agent_credentials"."revoked_at" IS NULL AND "agent_credentials"."confirmed_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_principals_service_key_unique" ON "agent_principals" USING btree ("service_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_principals_home_service_unique" ON "agent_principals" USING btree ("home_node_id","home_environment","home_origin","home_service");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_principals_service_created_idx" ON "agent_principals" USING btree ("created_at","user_id") WHERE "agent_principals"."service_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_principals_service_active_idx" ON "agent_principals" USING btree ("active_until","user_id") WHERE "agent_principals"."service_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_roles_purge_idx" ON "agent_roles" USING btree ("purge_after","id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_roles_enrollment_idx" ON "agent_roles" USING btree ("enrollment_operation_id","id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_roles_principal_scope_latest_idx" ON "agent_roles" USING btree ("principal_user_id","scope","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_roles_explicit_control_idx" ON "agent_roles" USING btree ("principal_user_id","scope","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "agent_roles"."approved_by" IS NOT NULL OR ("agent_roles"."approved_by" IS NULL AND "agent_roles"."revoked_at" IS NOT NULL AND ("agent_roles"."closed_reason" IS NULL OR "agent_roles"."closed_reason" NOT IN ('enrollment_expired', 'request_expired')));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_roles_unrevoked_principal_idx" ON "agent_roles" USING btree ("principal_user_id","id") WHERE "agent_roles"."revoked_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connections_service_ready_unique" ON "connections" USING btree ("service_key_digest") WHERE "connections"."provider" = 'cogni-node' AND "connections"."service_state" = 'ready';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connections_billing_account_provider_active_idx" ON "connections" USING btree ("billing_account_id","provider") WHERE "connections"."revoked_at" IS NULL AND "connections"."provider" <> 'cogni-node';
--> statement-breakpoint
ALTER TABLE "agent_credentials" DROP CONSTRAINT IF EXISTS "agent_credentials_created_from_canonical";
--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_created_from_canonical" CHECK ("agent_credentials"."created_from" IN ('spawn_grant','rotation','key_upgrade','binding_recovery','recovery_grant','service_enrollment')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "connections" DROP CONSTRAINT IF EXISTS "connections_provider_check";
--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_provider_check" CHECK ("connections"."provider" IN ('openai-chatgpt', 'openai-compatible', 'github', 'google', 'bluesky', 'cogni-node')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "agent_credentials" VALIDATE CONSTRAINT "agent_credentials_service_operation_id_agent_service_enrollments_operation_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_roles" VALIDATE CONSTRAINT "agent_roles_enrollment_operation_id_agent_service_enrollments_operation_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_credentials" VALIDATE CONSTRAINT "agent_credentials_created_from_canonical";
--> statement-breakpoint
ALTER TABLE "connections" VALIDATE CONSTRAINT "connections_provider_check";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agent_credentials_enrollment_confirm_revokes_siblings()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE siblings uuid[];
BEGIN
  -- Three bounded working-set branches: confirmed keys, receipt-eligible pending service keys, and non-enrollment pending keys.
  -- The receipt branch starts at the open/deadline index, so obsolete unrevoked pending history cannot become a scan or a sibling.
  SELECT array_agg(id ORDER BY id) INTO siblings FROM (
    (SELECT c.id FROM agent_credentials c WHERE c.user_id = NEW.user_id AND c.id <> NEW.id AND c.revoked_at IS NULL
      AND c.confirmed_at IS NOT NULL AND c.renew_until > (SELECT clock_timestamp()) LIMIT 3)
    UNION ALL
    (SELECT c.id FROM agent_service_enrollments e JOIN agent_credentials c ON c.id = e.credential_id
      WHERE e.principal_user_id = NEW.user_id AND e.status = 'open' AND e.expires_at > (SELECT clock_timestamp())
        AND e.historical_confirmed_at IS NULL AND c.user_id = NEW.user_id AND c.created_from = 'service_enrollment' AND c.id <> NEW.id AND c.confirmed_at IS NULL AND c.revoked_at IS NULL
        AND c.pending_expires_at > (SELECT clock_timestamp()) LIMIT 3)
    UNION ALL
    (SELECT c.id FROM agent_credentials c WHERE c.user_id = NEW.user_id AND c.id <> NEW.id AND c.revoked_at IS NULL
      AND c.confirmed_at IS NULL AND c.created_from <> 'service_enrollment' AND c.pending_expires_at > (SELECT clock_timestamp())
      AND (c.created_from <> 'rotation' OR EXISTS (SELECT 1 FROM agent_credentials p WHERE p.id = c.predecessor_id
        AND p.confirmed_at IS NOT NULL AND p.revoked_at IS NULL)) LIMIT 3)
    LIMIT 3
  ) working;
  IF cardinality(siblings) > 2 THEN
    RAISE EXCEPTION 'service usable credential working set exceeds bound' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM id FROM agent_credentials WHERE id = ANY(siblings) ORDER BY id FOR UPDATE;
  UPDATE agent_credentials SET revoked_at = clock_timestamp(), revoked_reason = 'superseded' WHERE id = ANY(siblings) AND revoked_at IS NULL;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "agent_credentials_enrollment_confirm_siblings"
  AFTER UPDATE OF confirmed_at ON "agent_credentials"
  FOR EACH ROW
  WHEN (OLD.confirmed_at IS NULL AND NEW.confirmed_at IS NOT NULL AND NEW.created_from = 'service_enrollment')
  EXECUTE FUNCTION agent_credentials_enrollment_confirm_revokes_siblings();
--> statement-breakpoint
INSERT INTO agent_authority_maintenance (id, backfill_ready, purge_enabled) VALUES ('service-enrollment', false, false) ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agent_credential_state(c agent_credentials)
RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT CASE WHEN c.revoked_at IS NOT NULL THEN 'revoked'
    WHEN c.confirmed_at IS NULL THEN CASE WHEN c.pending_expires_at > clock_timestamp() THEN 'pending' ELSE 'pending_expired' END
    WHEN c.expires_at > clock_timestamp() THEN 'active'
    WHEN c.renew_until > clock_timestamp() THEN 'renew_only' ELSE 'expired' END
$$;
--> statement-breakpoint
-- These three indexed maxima inspect only the live working set, never all historical children.
CREATE OR REPLACE FUNCTION agent_refresh_active_until(subject text)
RETURNS void LANGUAGE sql AS $$
  UPDATE agent_principals SET active_until = GREATEST(
    (SELECT e.expires_at FROM agent_service_enrollments e WHERE e.principal_user_id = subject
      AND e.status = 'open' AND e.historical_confirmed_at IS NULL AND e.expires_at > (SELECT clock_timestamp())
      ORDER BY e.expires_at DESC LIMIT 1),
    (SELECT c.renew_until FROM agent_credentials c WHERE c.user_id = subject AND c.revoked_at IS NULL
      AND c.confirmed_at IS NOT NULL AND c.renew_until > (SELECT clock_timestamp()) ORDER BY c.renew_until DESC LIMIT 1),
    (SELECT c.pending_expires_at FROM agent_credentials c WHERE c.user_id = subject AND c.revoked_at IS NULL
      AND c.confirmed_at IS NULL AND c.pending_expires_at > (SELECT clock_timestamp()) AND c.created_from <> 'service_enrollment'
      ORDER BY c.pending_expires_at DESC LIMIT 1)
  ) WHERE user_id = subject AND service_key IS NOT NULL
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agent_principal_confirmation_monotonic()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.ever_confirmed AND NOT NEW.ever_confirmed OR
     OLD.first_confirmed_at IS NOT NULL AND (NEW.first_confirmed_at IS NULL OR NEW.first_confirmed_at > OLD.first_confirmed_at) THEN
    RAISE EXCEPTION 'historical confirmation is monotonic' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_principal_confirmation_monotonic ON agent_principals;
CREATE TRIGGER agent_principal_confirmation_monotonic BEFORE UPDATE OF ever_confirmed, first_confirmed_at ON agent_principals
FOR EACH ROW EXECUTE FUNCTION agent_principal_confirmation_monotonic();
--> statement-breakpoint
-- Forward repair after service_enrollment_v2; no table/index changes. Frozen history remains unchanged.
CREATE OR REPLACE FUNCTION agent_credential_confirmation_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE service_binding text; receipt agent_service_enrollments; predecessor agent_credentials; activation boolean; current_op uuid; current_gen bigint; quota_subject text; quota_limit integer; quota_count integer; bucket bigint;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.token_hash IS DISTINCT FROM OLD.token_hash OR NEW.created_from IS DISTINCT FROM OLD.created_from THEN
      RAISE EXCEPTION 'credential identity is immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.issued_at IS DISTINCT FROM OLD.issued_at OR (OLD.confirmed_at IS NULL AND NEW.pending_expires_at > OLD.pending_expires_at) THEN
      RAISE EXCEPTION 'pending deadline cannot be extended' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at THEN
      RAISE EXCEPTION 'confirmation cannot be erased or rewritten' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.predecessor_provenance_id IS NOT NULL AND NEW.predecessor_provenance_id IS DISTINCT FROM OLD.predecessor_provenance_id OR
       OLD.service_operation_id IS NOT NULL AND NEW.service_operation_id IS DISTINCT FROM OLD.service_operation_id OR
       OLD.service_generation IS NOT NULL AND NEW.service_generation IS DISTINCT FROM OLD.service_generation THEN
      RAISE EXCEPTION 'credential provenance is immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR
       OLD.confirmed_at IS NOT NULL AND (NEW.expires_at > OLD.expires_at OR NEW.renew_until > OLD.renew_until) THEN
      RAISE EXCEPTION 'terminal authority cannot be renewed by row mutation' USING ERRCODE = 'check_violation';
    END IF;
    activation := OLD.confirmed_at IS NULL AND NEW.confirmed_at IS NOT NULL;
  ELSE activation := NEW.confirmed_at IS NOT NULL;
  END IF;
  IF TG_OP = 'INSERT' AND (NEW.pending_expires_at > clock_timestamp() + interval '15 minutes' OR
      NEW.expires_at > clock_timestamp() + interval '30 days' OR NEW.renew_until > NEW.expires_at + interval '14 days') THEN
    RAISE EXCEPTION 'credential issue exceeds lifetime bounds' USING ERRCODE = 'check_violation';
  END IF;
  SELECT service_key INTO service_binding FROM agent_principals WHERE user_id = NEW.user_id;
  IF service_binding IS NOT NULL THEN
    IF NOT pg_try_advisory_xact_lock(hashtext('agent_service_enrollments')) THEN
      RAISE EXCEPTION 'retry credential mutation under admission lock' USING ERRCODE = 'serialization_failure';
    END IF;
    IF NOT pg_try_advisory_xact_lock(hashtext('service:' || service_binding)) THEN
      RAISE EXCEPTION 'retry credential mutation under service lock' USING ERRCODE = 'serialization_failure';
    END IF;
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext(NEW.user_id)) THEN
    RAISE EXCEPTION 'retry confirmation under user advisory' USING ERRCODE = 'serialization_failure';
  END IF;
  PERFORM 1 FROM agent_principals WHERE user_id = NEW.user_id FOR UPDATE;
  IF service_binding IS NOT NULL AND NEW.revoked_at IS NULL AND
     (NEW.confirmed_at IS NOT NULL AND NEW.renew_until > clock_timestamp() OR NEW.confirmed_at IS NULL AND NEW.pending_expires_at > clock_timestamp()) AND
     NOT EXISTS (SELECT 1 FROM agent_principals WHERE user_id = NEW.user_id AND active_until > clock_timestamp()) AND
     (SELECT count(*) FROM (SELECT 1 FROM agent_principals WHERE service_key IS NOT NULL AND user_id <> NEW.user_id
       AND active_until > (SELECT clock_timestamp()) LIMIT 25) active) >= 25 THEN
    RAISE EXCEPTION 'active service capacity exhausted' USING ERRCODE = 'check_violation';
  END IF;
  -- Preparation must see a live predecessor; confirmation may occur after its renew_until while the15m successor remains eligible.
  IF TG_OP = 'INSERT' AND NEW.created_from = 'rotation' THEN
    SELECT * INTO predecessor FROM agent_credentials WHERE id = NEW.predecessor_id FOR UPDATE;
    IF NOT FOUND OR predecessor.user_id <> NEW.user_id OR predecessor.revoked_at IS NOT NULL OR predecessor.confirmed_at IS NULL OR
       predecessor.renew_until <= clock_timestamp() THEN
      RAISE EXCEPTION 'rotation preparation predecessor is not eligible' USING ERRCODE = 'check_violation';
    END IF;
    NEW.predecessor_provenance_id := NEW.predecessor_id;
    NEW.service_operation_id := predecessor.service_operation_id;
    NEW.service_generation := predecessor.service_generation;
  END IF;
  SELECT current_operation_id,current_generation INTO current_op,current_gen FROM agent_principals WHERE user_id=NEW.user_id;
  IF service_binding IS NOT NULL AND (TG_OP='INSERT' OR activation) THEN
    IF current_gen > 0 AND (NEW.service_operation_id IS DISTINCT FROM current_op OR NEW.service_generation IS DISTINCT FROM current_gen) THEN
      RAISE EXCEPTION 'obsolete service operation cannot issue or activate' USING ERRCODE='check_violation';
    END IF;
    IF NEW.service_operation_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM agent_service_enrollments e WHERE e.operation_id=NEW.service_operation_id AND e.generation=NEW.service_generation
        AND e.principal_user_id=NEW.user_id) THEN
      RAISE EXCEPTION 'service origin does not belong to credential principal' USING ERRCODE='check_violation';
    END IF;
    IF TG_OP='INSERT' THEN
      bucket := floor(extract(epoch FROM clock_timestamp())/3600)::bigint;
      FOR quota_subject,quota_limit IN SELECT 'target'::text,25 UNION ALL SELECT service_binding,5 LOOP
        INSERT INTO agent_service_quotas(subject,kind,hour,count) VALUES(quota_subject,'issued',bucket,1)
          ON CONFLICT(subject,kind,hour) DO UPDATE SET count=agent_service_quotas.count+1
          WHERE agent_service_quotas.count<quota_limit RETURNING count INTO quota_count;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'service issuance quota exhausted' USING ERRCODE='check_violation',CONSTRAINT='agent_service_issuance_quota';
        END IF;
      END LOOP;
    END IF;
  END IF;
  IF NOT activation THEN RETURN NEW; END IF;
  -- Legacy confirmed rows remain readable; every new v2-bound activation has one supported lineage.
  IF service_binding IS NOT NULL AND (current_gen > 0 OR NEW.service_operation_id IS NOT NULL) AND
     NEW.created_from NOT IN ('service_enrollment','rotation') THEN
    RAISE EXCEPTION 'unsupported service activation origin' USING ERRCODE='check_violation';
  END IF;
  IF NEW.revoked_at IS NOT NULL OR NEW.pending_expires_at IS NULL OR NEW.pending_expires_at <= clock_timestamp() OR NEW.pending_expires_at > NEW.issued_at + interval '15 minutes' OR
     NEW.expires_at > clock_timestamp() + interval '30 days' OR NEW.renew_until > NEW.expires_at + interval '14 days' THEN
    RAISE EXCEPTION 'ineligible or oversized credential activation' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.created_from = 'service_enrollment' THEN
    SELECT * INTO receipt FROM agent_service_enrollments WHERE credential_id = NEW.id FOR UPDATE;
    IF NOT FOUND OR receipt.principal_user_id <> NEW.user_id OR receipt.status <> 'open' OR receipt.expires_at <= clock_timestamp() OR receipt.historical_confirmed_at IS NOT NULL OR
       NOT EXISTS (SELECT 1 FROM agent_roles r WHERE r.principal_user_id = NEW.user_id AND r.scope = receipt.scope
         AND r.approved_by IS NOT NULL AND r.revoked_at IS NULL) THEN
      RAISE EXCEPTION 'service receipt is no longer eligible' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.created_from = 'rotation' THEN
    SELECT * INTO predecessor FROM agent_credentials WHERE id = NEW.predecessor_id FOR UPDATE;
    IF NOT FOUND OR predecessor.user_id <> NEW.user_id OR predecessor.revoked_at IS NOT NULL OR predecessor.confirmed_at IS NULL OR
       NEW.service_operation_id IS DISTINCT FROM predecessor.service_operation_id OR
       NEW.service_generation IS DISTINCT FROM predecessor.service_generation THEN
      RAISE EXCEPTION 'rotation predecessor is not eligible' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- Locks above may have waited beyond the receipt or pending deadline.
  IF NEW.revoked_at IS NOT NULL OR NEW.pending_expires_at IS NULL OR NEW.pending_expires_at <= clock_timestamp() OR NEW.pending_expires_at > NEW.issued_at + interval '15 minutes' OR
     NEW.expires_at > clock_timestamp() + interval '30 days' OR NEW.renew_until > NEW.expires_at + interval '14 days' OR
     (NEW.created_from = 'service_enrollment' AND receipt.expires_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'activation deadline passed while waiting for authority locks' USING ERRCODE = 'check_violation', CONSTRAINT='agent_service_activation_deadline';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_credential_confirmation_guard ON agent_credentials;
CREATE TRIGGER agent_credential_confirmation_guard BEFORE INSERT OR UPDATE ON agent_credentials
FOR EACH ROW EXECUTE FUNCTION agent_credential_confirmation_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agent_credential_summary_write()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.confirmed_at IS NOT NULL THEN
    UPDATE agent_principals SET ever_confirmed = true,
      first_confirmed_at = LEAST(first_confirmed_at, NEW.confirmed_at) WHERE user_id = NEW.user_id;
    UPDATE agent_service_enrollments SET historical_confirmed_at = COALESCE(historical_confirmed_at, NEW.confirmed_at),
      status = 'redeemed', terminal_at = COALESCE(terminal_at, NEW.confirmed_at)
      WHERE credential_id = NEW.id AND historical_confirmed_at IS NULL;
  END IF;
  PERFORM agent_refresh_active_until(NEW.user_id);
  RETURN NULL;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_credential_summary_write ON agent_credentials;
CREATE TRIGGER agent_credential_summary_write AFTER INSERT OR UPDATE ON agent_credentials
FOR EACH ROW EXECUTE FUNCTION agent_credential_summary_write();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agent_enrollment_active_write()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Retained terminal inserts/history edits cannot change active occupancy; do not revisit their parent/working set.
  IF TG_OP = 'INSERT' AND NEW.status <> 'open' THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'open' AND NEW.status <> 'open' THEN RETURN NULL; END IF;
    IF NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at AND
       NEW.historical_confirmed_at IS NOT DISTINCT FROM OLD.historical_confirmed_at THEN RETURN NULL; END IF;
  END IF;
  PERFORM agent_refresh_active_until(NEW.principal_user_id);
  RETURN NULL;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_enrollment_active_write ON agent_service_enrollments;
CREATE TRIGGER agent_enrollment_active_write AFTER INSERT OR UPDATE ON agent_service_enrollments
FOR EACH ROW EXECUTE FUNCTION agent_enrollment_active_write();
--> statement-breakpoint
-- Even a direct role-row approval cannot race the deadline or invert the ordinary authority advisory.
CREATE OR REPLACE FUNCTION agent_role_approval_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.approved_by IS NULL AND NEW.approved_by IS NOT NULL THEN
    IF NOT pg_try_advisory_xact_lock(hashtext(NEW.principal_user_id)) THEN
      RAISE EXCEPTION 'retry approval under user advisory' USING ERRCODE = 'serialization_failure';
    END IF;
    IF OLD.request_expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'pending approval deadline passed' USING ERRCODE = 'check_violation', CONSTRAINT = 'agent_role_request_expired';
    END IF;
    IF NEW.principal_user_id = NEW.approved_by OR OLD.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'pending approval is no longer eligible' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_role_approval_guard ON agent_roles;
CREATE TRIGGER agent_role_approval_guard BEFORE UPDATE OF approved_by ON agent_roles
FOR EACH ROW EXECUTE FUNCTION agent_role_approval_guard();
--> statement-breakpoint
ALTER TABLE agent_service_enrollments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_authority_maintenance FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- V2 custom RLS and guards; retained provider fixes remain in force.
ALTER TABLE agent_service_link_operations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_service_quotas FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agent_enrollment_v2_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.operation_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.operation_id IS DISTINCT FROM OLD.operation_id OR NEW.generation IS DISTINCT FROM OLD.generation OR
     NEW.principal_user_id IS DISTINCT FROM OLD.principal_user_id OR NEW.jti IS DISTINCT FROM OLD.jti OR
     NEW.issuer IS DISTINCT FROM OLD.issuer OR NEW.service IS DISTINCT FROM OLD.service OR NEW.scope IS DISTINCT FROM OLD.scope OR
     NEW.original_start_iat IS DISTINCT FROM OLD.original_start_iat OR NEW.original_start_exp IS DISTINCT FROM OLD.original_start_exp OR
     NEW.original_token_digest IS DISTINCT FROM OLD.original_token_digest OR NEW.intent_digest IS DISTINCT FROM OLD.intent_digest OR
     NEW.canonical_intent IS DISTINCT FROM OLD.canonical_intent OR NEW.cnf_jwk IS DISTINCT FROM OLD.cnf_jwk OR
     NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at OR
     NEW.device_code_hash IS DISTINCT FROM OLD.device_code_hash THEN
    RAISE EXCEPTION 'accepted enrollment intent and deadlines are immutable' USING ERRCODE='check_violation';
  END IF;
  IF OLD.credential_id IS NOT NULL AND NEW.credential_id IS DISTINCT FROM OLD.credential_id THEN
    PERFORM agent_audit_authority_lock(OLD.principal_user_id);
    IF NEW.credential_id IS NOT NULL OR OLD.status='open' OR NEW.status='open' OR OLD.purge_after IS NULL OR OLD.purge_after>clock_timestamp() OR
      NOT EXISTS(SELECT 1 FROM agent_credentials c WHERE c.id=OLD.credential_id AND c.user_id=OLD.principal_user_id
        AND c.purge_after<=clock_timestamp() AND c.renew_until<=clock_timestamp()) OR
      EXISTS(SELECT 1 FROM agent_credentials WHERE predecessor_id=OLD.credential_id LIMIT 1) THEN
      RAISE EXCEPTION 'enrollment credential reference is not compactable' USING ERRCODE='check_violation';
    END IF;
  END IF;
  IF OLD.historical_confirmed_at IS NOT NULL AND NEW.historical_confirmed_at IS DISTINCT FROM OLD.historical_confirmed_at OR
     OLD.sealed_acceptance IS NOT NULL AND NEW.sealed_acceptance IS NOT NULL AND NEW.sealed_acceptance<>OLD.sealed_acceptance OR
     OLD.sealed_pending_key IS NOT NULL AND NEW.sealed_pending_key IS NOT NULL AND NEW.sealed_pending_key<>OLD.sealed_pending_key THEN
    RAISE EXCEPTION 'enrollment delivery and confirmation are stable' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_enrollment_v2_immutable ON agent_service_enrollments;
CREATE TRIGGER agent_enrollment_v2_immutable BEFORE UPDATE ON agent_service_enrollments
FOR EACH ROW EXECUTE FUNCTION agent_enrollment_v2_immutable();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agent_service_pending_denial()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_op uuid; current_gen bigint; receipt_id uuid;
BEGIN
  IF OLD.enrollment_operation_id IS NULL OR OLD.approved_by IS NOT NULL OR NEW.approved_by IS NOT NULL OR
     OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR
     COALESCE(NEW.closed_reason IN ('enrollment_expired','request_expired'),false) THEN RETURN NEW; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext(OLD.principal_user_id)) THEN
    RAISE EXCEPTION 'retry denial under user advisory' USING ERRCODE='serialization_failure';
  END IF;
  SELECT current_operation_id,current_generation INTO current_op,current_gen FROM agent_principals
    WHERE user_id=OLD.principal_user_id FOR UPDATE NOWAIT;
  IF current_op IS DISTINCT FROM OLD.enrollment_operation_id THEN RETURN NEW; END IF;
  SELECT id INTO receipt_id FROM agent_service_enrollments WHERE operation_id=current_op AND generation=current_gen
    AND principal_user_id=OLD.principal_user_id AND scope=OLD.scope AND status='open' AND historical_confirmed_at IS NULL
    FOR UPDATE NOWAIT;
  IF FOUND THEN
    UPDATE agent_service_enrollments SET status='denied',terminal_at=COALESCE(terminal_at,clock_timestamp())
      WHERE id=receipt_id;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_service_pending_denial ON agent_roles;
CREATE TRIGGER agent_service_pending_denial BEFORE UPDATE OF revoked_at ON agent_roles
FOR EACH ROW EXECUTE FUNCTION agent_service_pending_denial();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agent_credential_audit_deadline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.purge_after := GREATEST(NEW.renew_until,
    COALESCE(NEW.revoked_at, CASE WHEN NEW.confirmed_at IS NULL THEN COALESCE(NEW.pending_expires_at, NEW.renew_until) ELSE NEW.renew_until END) + interval '90 days');
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_credential_audit_deadline ON agent_credentials;
CREATE TRIGGER agent_credential_audit_deadline BEFORE INSERT OR UPDATE ON agent_credentials
FOR EACH ROW EXECUTE FUNCTION agent_credential_audit_deadline();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agent_role_audit_deadline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.purge_after := NEW.revoked_at + interval '90 days';
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_role_audit_deadline ON agent_roles;
CREATE TRIGGER agent_role_audit_deadline BEFORE INSERT OR UPDATE ON agent_roles
FOR EACH ROW EXECUTE FUNCTION agent_role_audit_deadline();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agent_enrollment_audit_deadline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.purge_after := CASE WHEN NEW.status <> 'open' AND NEW.terminal_at IS NOT NULL
    THEN GREATEST(NEW.terminal_at + interval '90 days', COALESCE(NEW.original_start_exp, NEW.expires_at)) ELSE NULL END;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_enrollment_audit_deadline ON agent_service_enrollments;
CREATE TRIGGER agent_enrollment_audit_deadline BEFORE INSERT OR UPDATE ON agent_service_enrollments
FOR EACH ROW EXECUTE FUNCTION agent_enrollment_audit_deadline();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agent_current_operation_digest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_generation<OLD.current_generation OR NEW.current_generation>OLD.current_generation+1 OR
    (NEW.current_generation=OLD.current_generation AND NEW.current_operation_id IS DISTINCT FROM OLD.current_operation_id) OR
    (NEW.current_generation>OLD.current_generation AND (NEW.current_operation_id IS NULL OR NEW.current_operation_id IS NOT DISTINCT FROM OLD.current_operation_id)) THEN
    RAISE EXCEPTION 'current operation high-water mark is monotonic' USING ERRCODE='check_violation';
  END IF;
  IF NEW.current_operation_id IS DISTINCT FROM OLD.current_operation_id THEN
    SELECT intent_digest INTO NEW.current_operation_digest FROM agent_service_enrollments WHERE operation_id=NEW.current_operation_id AND principal_user_id=NEW.user_id AND generation=NEW.current_generation;
    IF NEW.current_operation_id IS NOT NULL AND NEW.current_operation_digest IS NULL THEN
      RAISE EXCEPTION 'current operation must have immutable receipt digest' USING ERRCODE='check_violation';
    END IF;
  ELSIF NEW.current_operation_digest IS DISTINCT FROM OLD.current_operation_digest THEN
    RAISE EXCEPTION 'current operation digest is immutable' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agent_requester_audit_deadline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.purge_after := CASE WHEN NEW.terminal_at IS NOT NULL AND (NEW.audit_compacted_at IS NULL OR NOT NEW.current)
    AND NEW.phase IN ('disconnected','denied','expired','expired_unknown','needs_reenroll')
    THEN GREATEST(NEW.terminal_at + interval '90 days', NEW.secret_deadline) ELSE NULL END;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_requester_audit_deadline ON agent_service_link_operations;
CREATE TRIGGER agent_requester_audit_deadline BEFORE INSERT OR UPDATE ON agent_service_link_operations
FOR EACH ROW EXECUTE FUNCTION agent_requester_audit_deadline();
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_current_operation_digest ON agent_principals;
CREATE TRIGGER agent_current_operation_digest BEFORE UPDATE OF current_operation_id, current_generation, current_operation_digest ON agent_principals
FOR EACH ROW EXECUTE FUNCTION agent_current_operation_digest();
--> statement-breakpoint
ALTER TABLE agent_service_enrollments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_service_link_operations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_authority_maintenance FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agent_audit_authority_lock(subject text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE binding text;
BEGIN
  SELECT service_key INTO binding FROM agent_principals WHERE user_id=subject;
  IF binding IS NOT NULL THEN
    IF NOT pg_try_advisory_xact_lock(hashtext('agent_service_enrollments')) THEN
      RAISE EXCEPTION 'retry audit under admission authority' USING ERRCODE='serialization_failure';
    END IF;
    IF NOT pg_try_advisory_xact_lock(hashtext('service:'||binding)) THEN
      RAISE EXCEPTION 'retry audit under service authority' USING ERRCODE='serialization_failure';
    END IF;
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext(subject)) THEN
    RAISE EXCEPTION 'retry audit under user authority' USING ERRCODE='serialization_failure';
  END IF;
  PERFORM 1 FROM agent_principals WHERE user_id=subject FOR UPDATE NOWAIT;
  IF NOT EXISTS(SELECT 1 FROM agent_authority_maintenance WHERE id='service-enrollment' AND backfill_ready AND purge_enabled
    AND minimum_reader_build ~ '^[a-f0-9]{40}$') THEN
    RAISE EXCEPTION 'audit purge cutover is not qualified' USING ERRCODE='check_violation';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agent_credential_audit_edge_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent agent_credentials;
BEGIN
  IF NEW.predecessor_id IS NOT DISTINCT FROM OLD.predecessor_id THEN RETURN NEW; END IF;
  PERFORM agent_audit_authority_lock(OLD.user_id);
  IF NEW.predecessor_id IS NOT NULL OR OLD.confirmed_at IS NULL OR NEW.confirmed_at IS NULL OR NEW.predecessor_provenance_id IS DISTINCT FROM OLD.predecessor_id THEN
    RAISE EXCEPTION 'only confirmed obsolete predecessor edges may detach' USING ERRCODE='check_violation';
  END IF;
  SELECT * INTO parent FROM agent_credentials WHERE id=OLD.predecessor_id FOR UPDATE NOWAIT;
  IF NOT FOUND OR parent.user_id<>OLD.user_id OR parent.purge_after IS NULL OR parent.purge_after>clock_timestamp() OR parent.renew_until>clock_timestamp() OR
    EXISTS(SELECT 1 FROM agent_credentials WHERE predecessor_id=OLD.predecessor_id AND confirmed_at IS NULL AND revoked_at IS NULL
      AND pending_expires_at>clock_timestamp() LIMIT 1) THEN
    RAISE EXCEPTION 'credential predecessor is not compactable' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_credential_audit_edge_guard ON agent_credentials;
CREATE TRIGGER agent_credential_audit_edge_guard BEFORE UPDATE OF predecessor_id ON agent_credentials
FOR EACH ROW EXECUTE FUNCTION agent_credential_audit_edge_guard();
