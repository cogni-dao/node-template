SET LOCAL lock_timeout='5s';
--> statement-breakpoint
DROP INDEX "agent_service_enrollments_credential_idx";--> statement-breakpoint
DROP INDEX "agent_service_links_secret_idx";--> statement-breakpoint
ALTER TABLE "agent_authority_maintenance" ADD COLUMN "audit_cursors" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD COLUMN "purge_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN "current_operation_digest" text;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD COLUMN "purge_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_service_link_operations" ADD COLUMN "audit_compacted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "agent_credentials_purge_idx" ON "agent_credentials" USING btree ("purge_after","id");--> statement-breakpoint
CREATE INDEX "agent_credentials_service_operation_idx" ON "agent_credentials" USING btree ("service_operation_id","id");--> statement-breakpoint
CREATE INDEX "agent_credentials_confirmed_predecessor_idx" ON "agent_credentials" USING btree ("predecessor_id","id") WHERE "agent_credentials"."confirmed_at" IS NOT NULL AND "agent_credentials"."predecessor_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_roles_purge_idx" ON "agent_roles" USING btree ("purge_after","id");--> statement-breakpoint
CREATE INDEX "agent_roles_enrollment_idx" ON "agent_roles" USING btree ("enrollment_operation_id","id");--> statement-breakpoint
CREATE INDEX "agent_service_links_connection_idx" ON "agent_service_link_operations" USING btree ("staged_connection_id","operation_id");--> statement-breakpoint
CREATE INDEX "agent_service_links_purge_idx" ON "agent_service_link_operations" USING btree ("purge_after","operation_id");--> statement-breakpoint
CREATE INDEX "agent_service_enrollments_credential_idx" ON "agent_service_enrollments" USING btree ("credential_id","id");--> statement-breakpoint
CREATE INDEX "agent_service_links_secret_idx" ON "agent_service_link_operations" USING btree ("secret_deadline","operation_id") WHERE "agent_service_link_operations"."encrypted_secrets" IS NOT NULL AND "agent_service_link_operations"."staged_connection_id" IS NULL AND "agent_service_link_operations"."confirm_authorized_at" IS NULL;
--> statement-breakpoint
SET LOCAL lock_timeout='5s';
--> statement-breakpoint
LOCK TABLE agent_credentials, agent_roles, agent_service_enrollments, agent_principals, agent_service_link_operations IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE agent_credentials NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_roles NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_service_enrollments NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_principals NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_service_link_operations NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_authority_maintenance NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION agent_credential_audit_deadline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.purge_after := GREATEST(NEW.renew_until,
    COALESCE(NEW.revoked_at, CASE WHEN NEW.confirmed_at IS NULL THEN COALESCE(NEW.pending_expires_at, NEW.renew_until) ELSE NEW.renew_until END) + interval '90 days');
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER agent_credential_audit_deadline BEFORE INSERT OR UPDATE ON agent_credentials
FOR EACH ROW EXECUTE FUNCTION agent_credential_audit_deadline();
--> statement-breakpoint
CREATE FUNCTION agent_role_audit_deadline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.purge_after := NEW.revoked_at + interval '90 days';
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER agent_role_audit_deadline BEFORE INSERT OR UPDATE ON agent_roles
FOR EACH ROW EXECUTE FUNCTION agent_role_audit_deadline();
--> statement-breakpoint
CREATE FUNCTION agent_enrollment_audit_deadline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.purge_after := CASE WHEN NEW.status <> 'open' AND NEW.terminal_at IS NOT NULL
    THEN GREATEST(NEW.terminal_at + interval '90 days', COALESCE(NEW.original_start_exp, NEW.expires_at)) ELSE NULL END;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER agent_enrollment_audit_deadline BEFORE INSERT OR UPDATE ON agent_service_enrollments
FOR EACH ROW EXECUTE FUNCTION agent_enrollment_audit_deadline();
--> statement-breakpoint
CREATE FUNCTION agent_current_operation_digest() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE FUNCTION agent_requester_audit_deadline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.purge_after := CASE WHEN NEW.terminal_at IS NOT NULL AND (NEW.audit_compacted_at IS NULL OR NOT NEW.current)
    AND NEW.phase IN ('disconnected','denied','expired','expired_unknown','needs_reenroll')
    THEN GREATEST(NEW.terminal_at + interval '90 days', NEW.secret_deadline) ELSE NULL END;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER agent_requester_audit_deadline BEFORE INSERT OR UPDATE ON agent_service_link_operations
FOR EACH ROW EXECUTE FUNCTION agent_requester_audit_deadline();
--> statement-breakpoint
UPDATE agent_credentials SET purge_after=NULL;
--> statement-breakpoint
UPDATE agent_roles SET purge_after=NULL;
--> statement-breakpoint
UPDATE agent_service_enrollments SET purge_after=NULL;
--> statement-breakpoint
UPDATE agent_service_link_operations SET purge_after=NULL;
--> statement-breakpoint
UPDATE agent_principals p SET current_operation_digest=e.intent_digest FROM agent_service_enrollments e
WHERE p.current_operation_id=e.operation_id AND p.user_id=e.principal_user_id;
--> statement-breakpoint
CREATE TRIGGER agent_current_operation_digest BEFORE UPDATE OF current_operation_id, current_generation, current_operation_digest ON agent_principals
FOR EACH ROW EXECUTE FUNCTION agent_current_operation_digest();
--> statement-breakpoint
UPDATE agent_authority_maintenance SET purge_enabled=false,minimum_reader_build=NULL,audit_cursors='{}'::jsonb WHERE id='service-enrollment';
--> statement-breakpoint
ALTER TABLE agent_credentials FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_roles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_service_enrollments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_principals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_service_link_operations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_authority_maintenance FORCE ROW LEVEL SECURITY;

--> statement-breakpoint
CREATE FUNCTION agent_audit_authority_lock(subject text) RETURNS void LANGUAGE plpgsql AS $$
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
CREATE FUNCTION agent_credential_audit_edge_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER agent_credential_audit_edge_guard BEFORE UPDATE OF predecessor_id ON agent_credentials
FOR EACH ROW EXECUTE FUNCTION agent_credential_audit_edge_guard();

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
