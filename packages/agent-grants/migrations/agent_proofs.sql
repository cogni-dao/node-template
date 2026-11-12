CREATE TABLE "agent_proof_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"nonce_hash" text NOT NULL,
	"secret_hash" text NOT NULL,
	"principal_user_id" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"fetched_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "agent_proof_challenges_purpose_canonical" CHECK ("agent_proof_challenges"."purpose" IN ('bind','recover')),
	CONSTRAINT "agent_proof_challenges_bind_has_principal" CHECK ("agent_proof_challenges"."purpose" <> 'bind' OR "agent_proof_challenges"."principal_user_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "agent_proof_challenges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_stops" (
	"user_id" text PRIMARY KEY NOT NULL,
	"stopped_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_by" text NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_by" text
);
--> statement-breakpoint
ALTER TABLE "agent_stops" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_proof_challenges" ADD CONSTRAINT "agent_proof_challenges_principal_user_id_users_id_fk" FOREIGN KEY ("principal_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_stops" ADD CONSTRAINT "agent_stops_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_proof_challenges_issued_idx" ON "agent_proof_challenges" USING btree ("issued_at");--> statement-breakpoint
CREATE INDEX "agent_proof_challenges_principal_idx" ON "agent_proof_challenges" USING btree ("principal_user_id");
--> statement-breakpoint
-- Hand-written below: FORCE RLS is outside Drizzle's DDL scope (same as 0027 / 0031 / 0036 / 0039).
-- Both tables have NO policy: ENABLE + FORCE = deny-all for the app role. Only the BYPASSRLS service role reads or writes them.
ALTER TABLE "agent_proof_challenges" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_stops" FORCE ROW LEVEL SECURITY;
