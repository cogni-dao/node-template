CREATE TABLE "agent_service_link_operations" (
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
	"purge_after" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_service_link_operations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_service_quotas" (
	"subject" text NOT NULL,
	"kind" text NOT NULL,
	"hour" bigint NOT NULL,
	"count" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_service_quotas" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "connections" DROP CONSTRAINT "connections_provider_check";--> statement-breakpoint
DROP INDEX "connections_billing_account_provider_active_idx";--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN "home_node_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN "home_environment" text;--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN "home_origin" text;--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN "home_service" text;--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN "current_generation" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN "current_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD COLUMN "enrollment_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_service_enrollments" ADD COLUMN "operation_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_service_enrollments" ADD COLUMN "generation" bigint;--> statement-breakpoint
ALTER TABLE "agent_service_enrollments" ADD COLUMN "original_start_iat" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_service_enrollments" ADD COLUMN "original_start_exp" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_service_enrollments" ADD COLUMN "original_token_digest" text;--> statement-breakpoint
ALTER TABLE "agent_service_enrollments" ADD COLUMN "intent_digest" text;--> statement-breakpoint
ALTER TABLE "agent_service_enrollments" ADD COLUMN "canonical_intent" text;--> statement-breakpoint
ALTER TABLE "agent_service_enrollments" ADD COLUMN "sealed_acceptance" text;--> statement-breakpoint
ALTER TABLE "agent_service_enrollments" ADD COLUMN "sealed_pending_key" text;--> statement-breakpoint
ALTER TABLE "agent_service_enrollments" ADD COLUMN "pending_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_service_enrollments" ADD COLUMN "purge_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "service_key_digest" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "service_identity" jsonb;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "service_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "service_generation" bigint;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "service_credential_id" uuid;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "service_state" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "renew_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_service_link_operations" ADD CONSTRAINT "agent_service_link_operations_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_service_link_operations" ADD CONSTRAINT "agent_service_link_operations_staged_connection_id_connections_id_fk" FOREIGN KEY ("staged_connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_service_links_identity_unique" ON "agent_service_link_operations" USING btree ("home_node_id","home_environment","home_origin","service","billing_account_id","target_node_id","target_environment","target_origin") WHERE "agent_service_link_operations"."current";--> statement-breakpoint
CREATE UNIQUE INDEX "agent_service_links_key_unique" ON "agent_service_link_operations" USING btree ("key_digest") WHERE "agent_service_link_operations"."current";--> statement-breakpoint
CREATE INDEX "agent_service_links_due_idx" ON "agent_service_link_operations" USING btree ("next_attempt_at","operation_id");--> statement-breakpoint
CREATE INDEX "agent_service_links_secret_idx" ON "agent_service_link_operations" USING btree ("secret_deadline","operation_id") WHERE "agent_service_link_operations"."encrypted_secrets" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_service_quotas_bucket_unique" ON "agent_service_quotas" USING btree ("subject","kind","hour");--> statement-breakpoint
CREATE INDEX "agent_service_quotas_hour_idx" ON "agent_service_quotas" USING btree ("hour");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_service_enrollments_operation_unique" ON "agent_service_enrollments" USING btree ("operation_id");--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_service_operation_id_agent_service_enrollments_operation_id_fk" FOREIGN KEY ("service_operation_id") REFERENCES "public"."agent_service_enrollments"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_enrollment_operation_id_agent_service_enrollments_operation_id_fk" FOREIGN KEY ("enrollment_operation_id") REFERENCES "public"."agent_service_enrollments"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_principals_home_service_unique" ON "agent_principals" USING btree ("home_node_id","home_environment","home_origin","home_service");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_service_enrollments_generation_unique" ON "agent_service_enrollments" USING btree ("principal_user_id","generation");--> statement-breakpoint
CREATE INDEX "agent_service_enrollments_delivery_idx" ON "agent_service_enrollments" USING btree ("expires_at","id") WHERE "agent_service_enrollments"."sealed_acceptance" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_service_enrollments_pending_delivery_idx" ON "agent_service_enrollments" USING btree ("pending_expires_at","id") WHERE "agent_service_enrollments"."sealed_pending_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_service_enrollments_purge_idx" ON "agent_service_enrollments" USING btree ("purge_after","id");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_service_ready_unique" ON "connections" USING btree ("service_key_digest") WHERE "connections"."provider" = 'cogni-node' AND "connections"."service_state" = 'ready';--> statement-breakpoint
CREATE UNIQUE INDEX "connections_billing_account_provider_active_idx" ON "connections" USING btree ("billing_account_id","provider") WHERE "connections"."revoked_at" IS NULL AND "connections"."provider" <> 'cogni-node';--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_provider_check" CHECK ("connections"."provider" IN ('openai-chatgpt', 'openai-compatible', 'github', 'google', 'bluesky', 'cogni-node'));
--> statement-breakpoint
-- V2 custom triggers and forced RLS; provider guard repairs remain in force.
ALTER TABLE agent_service_link_operations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_service_quotas FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
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
    RAISE EXCEPTION 'activation deadline passed while waiting for authority locks' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

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
  IF OLD.credential_id IS NOT NULL AND NEW.credential_id IS DISTINCT FROM OLD.credential_id OR
     OLD.historical_confirmed_at IS NOT NULL AND NEW.historical_confirmed_at IS DISTINCT FROM OLD.historical_confirmed_at OR
     OLD.sealed_acceptance IS NOT NULL AND NEW.sealed_acceptance IS NOT NULL AND NEW.sealed_acceptance<>OLD.sealed_acceptance OR
     OLD.sealed_pending_key IS NOT NULL AND NEW.sealed_pending_key IS NOT NULL AND NEW.sealed_pending_key<>OLD.sealed_pending_key THEN
    RAISE EXCEPTION 'enrollment delivery and confirmation are stable' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER agent_enrollment_v2_immutable BEFORE UPDATE ON agent_service_enrollments
FOR EACH ROW EXECUTE FUNCTION agent_enrollment_v2_immutable();
