CREATE TABLE "org_connections" (
	"org_user_id" text PRIMARY KEY NOT NULL,
	"billing_account_id" text NOT NULL,
	"issuer" text NOT NULL,
	"status" text NOT NULL,
	"suspended" boolean DEFAULT false NOT NULL,
	"cap" bigint NOT NULL,
	"seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_connections_status_canonical" CHECK ("org_connections"."status" IN ('connected','disconnected')),
	CONSTRAINT "org_connections_cap_nonnegative" CHECK ("org_connections"."cap" >= 0),
	CONSTRAINT "org_connections_seq_positive" CHECK ("org_connections"."seq" >= 1)
);
--> statement-breakpoint
ALTER TABLE "org_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "service_assertion_jtis" (
	"jti" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "service_assertion_jtis" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_connections" ADD CONSTRAINT "org_connections_org_user_id_users_id_fk" FOREIGN KEY ("org_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_connections" ADD CONSTRAINT "org_connections_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_connections_issuer_unique" ON "org_connections" USING btree ("issuer");--> statement-breakpoint
CREATE UNIQUE INDEX "org_connections_billing_account_unique" ON "org_connections" USING btree ("billing_account_id");--> statement-breakpoint
CREATE INDEX "service_assertion_jtis_expires_idx" ON "service_assertion_jtis" USING btree ("expires_at");--> statement-breakpoint

-- Hand-written below: FORCE RLS is outside Drizzle's DDL scope (same as 0039 / 0041 / 0046).
-- org_connections and service_assertion_jtis have NO policy: ENABLE + FORCE = deny-all for the app role. Only the BYPASSRLS service role reads or writes them.
ALTER TABLE "org_connections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "service_assertion_jtis" FORCE ROW LEVEL SECURITY;
