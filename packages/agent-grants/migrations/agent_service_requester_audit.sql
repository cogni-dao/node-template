SET LOCAL lock_timeout='5s';
--> statement-breakpoint
ALTER TABLE agent_service_link_operations ADD COLUMN audit_compacted_at timestamptz;
--> statement-breakpoint
DROP INDEX agent_service_links_secret_idx;
--> statement-breakpoint
CREATE INDEX agent_service_links_secret_idx ON agent_service_link_operations(secret_deadline,operation_id)
  WHERE encrypted_secrets IS NOT NULL AND staged_connection_id IS NULL AND confirm_authorized_at IS NULL;
--> statement-breakpoint
CREATE INDEX agent_service_links_connection_idx ON agent_service_link_operations(staged_connection_id,operation_id);
--> statement-breakpoint
CREATE INDEX agent_service_links_purge_idx ON agent_service_link_operations(purge_after,operation_id);
--> statement-breakpoint
CREATE TABLE agent_authority_maintenance (
  id text PRIMARY KEY,backfill_ready boolean NOT NULL DEFAULT false,purge_enabled boolean NOT NULL DEFAULT false,
  minimum_reader_build text,next_run_at timestamptz NOT NULL DEFAULT now(),oldest_due_at timestamptz,
  cursor_expires_at timestamptz,cursor_enrollment_id uuid,audit_cursors jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT agent_authority_purge_qualified CHECK(NOT purge_enabled OR (backfill_ready AND minimum_reader_build IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE agent_authority_maintenance ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO agent_authority_maintenance(id,backfill_ready,purge_enabled) VALUES('requester-audit',true,false);
--> statement-breakpoint
ALTER TABLE agent_authority_maintenance FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_service_link_operations NO FORCE ROW LEVEL SECURITY;
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
UPDATE agent_service_link_operations SET purge_after=NULL;
--> statement-breakpoint
ALTER TABLE agent_service_link_operations FORCE ROW LEVEL SECURITY;
