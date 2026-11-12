-- Bound the migration runner's credential-writer quiescence before generated ALTER statements.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
LOCK TABLE agent_credentials IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
CREATE TABLE "agent_authority_maintenance" (
	"id" text PRIMARY KEY NOT NULL,
	"backfill_ready" boolean DEFAULT false NOT NULL,
	"purge_enabled" boolean DEFAULT false NOT NULL,
	"minimum_reader_build" text,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"oldest_due_at" timestamp with time zone,
	CONSTRAINT "agent_authority_purge_qualified" CHECK (NOT "agent_authority_maintenance"."purge_enabled" OR ("agent_authority_maintenance"."backfill_ready" AND "agent_authority_maintenance"."minimum_reader_build" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "agent_authority_maintenance" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP INDEX "agent_service_enrollments_open_principal_idx";--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD COLUMN "predecessor_provenance_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD COLUMN "service_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD COLUMN "service_generation" bigint;--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN "ever_confirmed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN "first_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN "active_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN "maintenance_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD COLUMN "request_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD COLUMN "closed_reason" text;--> statement-breakpoint
ALTER TABLE "agent_service_enrollments" ADD COLUMN "historical_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_service_enrollments" ADD COLUMN "terminal_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "agent_credentials_predecessor_idx" ON "agent_credentials" USING btree ("predecessor_id","id");--> statement-breakpoint
CREATE INDEX "agent_credentials_confirmed_history_idx" ON "agent_credentials" USING btree ("user_id","confirmed_at") WHERE "agent_credentials"."confirmed_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_credentials_usable_idx" ON "agent_credentials" USING btree ("user_id","renew_until","id") WHERE "agent_credentials"."revoked_at" IS NULL AND "agent_credentials"."confirmed_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_credentials_pending_idx" ON "agent_credentials" USING btree ("user_id","pending_expires_at","id") WHERE "agent_credentials"."revoked_at" IS NULL AND "agent_credentials"."confirmed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "agent_principals_service_active_idx" ON "agent_principals" USING btree ("active_until","user_id") WHERE "agent_principals"."service_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_service_enrollments_credential_idx" ON "agent_service_enrollments" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "agent_service_enrollments_open_principal_idx" ON "agent_service_enrollments" USING btree ("principal_user_id","expires_at","id") WHERE "agent_service_enrollments"."status" = 'open';
--> statement-breakpoint
-- Hand-authored functions/triggers only. DDL, indexes, journal and snapshot above were generated from schema TS.
-- The normal migration runner holds the initial credential mutation lock through all backfill and state changes.
-- The actual node migration role owns these FORCE-RLS tables and is not BYPASSRLS. Temporarily lift FORCE for the owner only,
-- inside this atomic migration transaction, so backfill cannot silently read/write zero rows. Restore every FORCE before commit.
ALTER TABLE agent_credentials NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE agent_principals NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE agent_roles NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE agent_service_enrollments NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO agent_authority_maintenance (id, backfill_ready, purge_enabled) VALUES ('service-enrollment', false, false);--> statement-breakpoint
CREATE OR REPLACE FUNCTION agent_credential_state(c agent_credentials)
RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT CASE WHEN c.revoked_at IS NOT NULL THEN 'revoked'
    WHEN c.confirmed_at IS NULL THEN CASE WHEN c.pending_expires_at > clock_timestamp() THEN 'pending' ELSE 'pending_expired' END
    WHEN c.expires_at > clock_timestamp() THEN 'active'
    WHEN c.renew_until > clock_timestamp() THEN 'renew_only' ELSE 'expired' END
$$;--> statement-breakpoint
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
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION agent_principal_confirmation_monotonic()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.ever_confirmed AND NOT NEW.ever_confirmed OR
     OLD.first_confirmed_at IS NOT NULL AND (NEW.first_confirmed_at IS NULL OR NEW.first_confirmed_at > OLD.first_confirmed_at) THEN
    RAISE EXCEPTION 'historical confirmation is monotonic' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER agent_principal_confirmation_monotonic BEFORE UPDATE OF ever_confirmed, first_confirmed_at ON agent_principals
FOR EACH ROW EXECUTE FUNCTION agent_principal_confirmation_monotonic();--> statement-breakpoint
-- A direct row writer already holds a credential lock: NEVER wait for an earlier advisory lock here.
-- Supported writers acquire these locks before any rows; direct SQL fails serialization instead of inverting their order.
CREATE OR REPLACE FUNCTION agent_credential_confirmation_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE service_binding text; receipt agent_service_enrollments; predecessor agent_credentials; activation boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.token_hash IS DISTINCT FROM OLD.token_hash OR NEW.created_from IS DISTINCT FROM OLD.created_from THEN
      RAISE EXCEPTION 'credential identity is immutable' USING ERRCODE = 'check_violation';
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
  IF NOT activation THEN RETURN NEW; END IF;
  IF NEW.revoked_at IS NOT NULL OR NEW.pending_expires_at IS NULL OR NEW.pending_expires_at <= clock_timestamp() OR
     NEW.expires_at > clock_timestamp() + interval '30 days' OR NEW.renew_until > NEW.expires_at + interval '14 days' THEN
    RAISE EXCEPTION 'ineligible or oversized credential activation' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.created_from = 'service_enrollment' THEN
    SELECT * INTO receipt FROM agent_service_enrollments WHERE credential_id = NEW.id FOR UPDATE;
    IF NOT FOUND OR receipt.status <> 'open' OR receipt.expires_at <= clock_timestamp() OR receipt.historical_confirmed_at IS NOT NULL OR
       NOT EXISTS (SELECT 1 FROM agent_roles r WHERE r.principal_user_id = NEW.user_id AND r.scope = receipt.scope
         AND r.approved_by IS NOT NULL AND r.revoked_at IS NULL) THEN
      RAISE EXCEPTION 'service receipt is no longer eligible' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.created_from = 'rotation' THEN
    SELECT * INTO predecessor FROM agent_credentials WHERE id = NEW.predecessor_id FOR UPDATE;
    IF NOT FOUND OR predecessor.user_id <> NEW.user_id OR predecessor.revoked_at IS NOT NULL OR predecessor.confirmed_at IS NULL OR
       predecessor.renew_until <= clock_timestamp() OR NEW.service_operation_id IS DISTINCT FROM predecessor.service_operation_id OR
       NEW.service_generation IS DISTINCT FROM predecessor.service_generation THEN
      RAISE EXCEPTION 'rotation predecessor is not eligible' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER agent_credential_confirmation_guard BEFORE INSERT OR UPDATE ON agent_credentials
FOR EACH ROW EXECUTE FUNCTION agent_credential_confirmation_guard();--> statement-breakpoint
-- Replace0041's all-history sibling update. LIMIT3 proves the at-most-two-other-usable invariant before touching any sibling.
CREATE OR REPLACE FUNCTION agent_credentials_enrollment_confirm_revokes_siblings()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE siblings uuid[];
BEGIN
  SELECT array_agg(id ORDER BY id) INTO siblings FROM (
    (SELECT id FROM agent_credentials WHERE user_id = NEW.user_id AND id <> NEW.id AND revoked_at IS NULL
      AND confirmed_at IS NOT NULL AND renew_until > (SELECT clock_timestamp()) LIMIT 3)
    UNION ALL
    (SELECT id FROM agent_credentials WHERE user_id = NEW.user_id AND id <> NEW.id AND revoked_at IS NULL
      AND confirmed_at IS NULL AND pending_expires_at > (SELECT clock_timestamp()) LIMIT 3)
    LIMIT 3
  ) working;
  IF cardinality(siblings) > 2 THEN
    RAISE EXCEPTION 'service usable credential working set exceeds bound' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM id FROM agent_credentials WHERE id = ANY(siblings) ORDER BY id FOR UPDATE;
  UPDATE agent_credentials SET revoked_at = clock_timestamp(), revoked_reason = 'superseded' WHERE id = ANY(siblings) AND revoked_at IS NULL;
  RETURN NULL;
END
$$;--> statement-breakpoint
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
$$;--> statement-breakpoint
CREATE TRIGGER agent_credential_summary_write AFTER INSERT OR UPDATE ON agent_credentials
FOR EACH ROW EXECUTE FUNCTION agent_credential_summary_write();--> statement-breakpoint
CREATE OR REPLACE FUNCTION agent_enrollment_active_write()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM agent_refresh_active_until(NEW.principal_user_id);
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER agent_enrollment_active_write AFTER INSERT OR UPDATE ON agent_service_enrollments
FOR EACH ROW EXECUTE FUNCTION agent_enrollment_active_write();--> statement-breakpoint
-- Backfill ALL confirmations, including revoked/expired rows. No state filter or current-key heuristic.
UPDATE agent_principals p SET ever_confirmed = p.ever_confirmed OR history.first_at IS NOT NULL,
  first_confirmed_at = LEAST(p.first_confirmed_at, history.first_at)
FROM (SELECT user_id, min(confirmed_at) AS first_at FROM agent_credentials WHERE confirmed_at IS NOT NULL GROUP BY user_id) history
WHERE p.user_id = history.user_id;--> statement-breakpoint
UPDATE agent_credentials SET predecessor_provenance_id = predecessor_id WHERE predecessor_id IS NOT NULL;--> statement-breakpoint
UPDATE agent_service_enrollments e SET historical_confirmed_at = c.confirmed_at, status = 'redeemed', terminal_at = COALESCE(e.terminal_at, c.confirmed_at)
FROM agent_credentials c WHERE c.id = e.credential_id AND c.confirmed_at IS NOT NULL;--> statement-breakpoint
UPDATE agent_roles r SET request_expires_at = latest.expires_at
FROM (SELECT DISTINCT ON (principal_user_id, scope) principal_user_id, scope, expires_at
      FROM agent_service_enrollments ORDER BY principal_user_id, scope, created_at DESC, id DESC) latest
WHERE r.principal_user_id = latest.principal_user_id AND r.scope = latest.scope AND r.approved_by IS NULL AND r.revoked_at IS NULL;--> statement-breakpoint
SELECT agent_refresh_active_until(user_id) FROM agent_principals WHERE service_key IS NOT NULL;--> statement-breakpoint
UPDATE agent_authority_maintenance SET backfill_ready = true, purge_enabled = false, minimum_reader_build = NULL WHERE id = 'service-enrollment';
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
$$;--> statement-breakpoint
CREATE TRIGGER agent_role_approval_guard BEFORE UPDATE OF approved_by ON agent_roles
FOR EACH ROW EXECUTE FUNCTION agent_role_approval_guard();

--> statement-breakpoint
ALTER TABLE agent_credentials FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE agent_principals FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE agent_roles FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE agent_service_enrollments FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE agent_authority_maintenance FORCE ROW LEVEL SECURITY;
