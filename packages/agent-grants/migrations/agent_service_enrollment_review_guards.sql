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
-- Dismiss is a terminal operation decision, not only a role-history edit. This trigger is installed only in full v2 hosts.
-- Role writers already own the user advisory/principal lock. Direct SQL must fail fast rather than invert that order.
CREATE FUNCTION agent_service_pending_denial()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_op uuid; current_gen bigint; receipt_id uuid;
BEGIN
  IF OLD.enrollment_operation_id IS NULL OR OLD.approved_by IS NOT NULL OR NEW.approved_by IS NOT NULL OR
     OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN RETURN NEW; END IF;
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
CREATE TRIGGER agent_service_pending_denial BEFORE UPDATE OF revoked_at ON agent_roles
FOR EACH ROW EXECUTE FUNCTION agent_service_pending_denial();
