-- Provider maintenance indexes (@cogni-dao/agent-grants 0.4.0, task.0105).
-- Apply after agent_service_enrollments.sql and BEFORE serving the corrected provider.
-- Add these indexes to the node's OWN schema TS and generate its OWN SQL/journal/snapshot.
-- This reference is generated DDL from node-template migration0042; never rewrite exercised0041.
CREATE INDEX "agent_principals_service_created_idx" ON "agent_principals" USING btree ("created_at","user_id") WHERE "agent_principals"."service_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_roles_principal_scope_latest_idx" ON "agent_roles" USING btree ("principal_user_id","scope","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_roles_unrevoked_principal_idx" ON "agent_roles" USING btree ("principal_user_id","id") WHERE "agent_roles"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "agent_service_enrollments_open_expiry_idx" ON "agent_service_enrollments" USING btree ("expires_at","id") WHERE "agent_service_enrollments"."status" = 'open';--> statement-breakpoint
CREATE INDEX "agent_service_enrollments_open_principal_idx" ON "agent_service_enrollments" USING btree ("principal_user_id","id") WHERE "agent_service_enrollments"."status" = 'open';