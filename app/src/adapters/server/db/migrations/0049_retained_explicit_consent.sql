CREATE INDEX "agent_roles_explicit_control_idx" ON "agent_roles" USING btree ("principal_user_id","scope","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "agent_roles"."approved_by" IS NOT NULL OR ("agent_roles"."approved_by" IS NULL AND "agent_roles"."revoked_at" IS NOT NULL AND ("agent_roles"."closed_reason" IS NULL OR "agent_roles"."closed_reason" NOT IN ('enrollment_expired', 'request_expired')));
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
