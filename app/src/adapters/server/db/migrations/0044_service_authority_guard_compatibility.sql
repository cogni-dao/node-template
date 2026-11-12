-- Custom function-only forward repair generated with db:generate --custom. Exercised0043 stays immutable.
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
       NEW.service_operation_id IS DISTINCT FROM predecessor.service_operation_id OR
       NEW.service_generation IS DISTINCT FROM predecessor.service_generation THEN
      RAISE EXCEPTION 'rotation predecessor is not eligible' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
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
