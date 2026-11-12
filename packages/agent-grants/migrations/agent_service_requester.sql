-- Requester-only host template: billing_accounts and connections are host prerequisites. No provider tables.
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
ALTER TABLE "agent_service_link_operations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "connections" DROP CONSTRAINT "connections_provider_check";
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "service_key_digest" text;
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "service_identity" jsonb;
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "service_operation_id" uuid;
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "service_generation" bigint;
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "service_credential_id" uuid;
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "service_state" text;
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "renew_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "agent_service_link_operations" ADD CONSTRAINT "agent_service_link_operations_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_service_link_operations" ADD CONSTRAINT "agent_service_link_operations_staged_connection_id_connections_id_fk" FOREIGN KEY ("staged_connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_service_links_identity_unique" ON "agent_service_link_operations" USING btree ("home_node_id","home_environment","home_origin","service","billing_account_id","target_node_id","target_environment","target_origin") WHERE "agent_service_link_operations"."current";
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_service_links_key_unique" ON "agent_service_link_operations" USING btree ("key_digest") WHERE "agent_service_link_operations"."current";
--> statement-breakpoint
CREATE INDEX "agent_service_links_due_idx" ON "agent_service_link_operations" USING btree ("next_attempt_at","operation_id");
--> statement-breakpoint
CREATE INDEX "agent_service_links_staged_expiry_idx" ON "agent_service_link_operations" USING btree ("secret_deadline","operation_id") WHERE "agent_service_link_operations"."staged_connection_id" IS NOT NULL AND COALESCE("agent_service_link_operations"."state"->>'quarantined','false') <> 'true' AND "agent_service_link_operations"."phase" <> 'expired';
--> statement-breakpoint
CREATE INDEX "agent_service_links_secret_idx" ON "agent_service_link_operations" USING btree ("secret_deadline","operation_id") WHERE "agent_service_link_operations"."encrypted_secrets" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "connections_service_ready_unique" ON "connections" USING btree ("service_key_digest") WHERE "connections"."provider" = 'cogni-node' AND "connections"."service_state" = 'ready';
--> statement-breakpoint
CREATE UNIQUE INDEX "connections_billing_account_provider_active_idx" ON "connections" USING btree ("billing_account_id","provider") WHERE "connections"."revoked_at" IS NULL AND "connections"."provider" <> 'cogni-node';
--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_provider_check" CHECK ("connections"."provider" IN ('openai-chatgpt', 'openai-compatible', 'github', 'google', 'bluesky', 'cogni-node'));
--> statement-breakpoint
ALTER TABLE agent_service_link_operations FORCE ROW LEVEL SECURITY;
