CREATE TABLE "payer_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_user_id" text NOT NULL,
	"billing_account_id" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payer_bindings_no_self_approval" CHECK ("payer_bindings"."approved_by" IS NULL OR "payer_bindings"."approved_by" <> "payer_bindings"."subject_user_id"),
	CONSTRAINT "payer_bindings_approval_is_paired" CHECK (("payer_bindings"."approved_by" IS NULL) = ("payer_bindings"."approved_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "payer_bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payer_bindings" ADD CONSTRAINT "payer_bindings_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer_bindings" ADD CONSTRAINT "payer_bindings_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer_bindings" ADD CONSTRAINT "payer_bindings_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer_bindings" ADD CONSTRAINT "payer_bindings_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payer_bindings_open_per_subject" ON "payer_bindings" USING btree ("subject_user_id") WHERE "payer_bindings"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "payer_bindings_account_idx" ON "payer_bindings" USING btree ("billing_account_id");--> statement-breakpoint

-- Hand-written below: FORCE RLS is outside Drizzle's DDL scope (same as 0039 / 0041).
-- payer_bindings has NO policy: ENABLE + FORCE = deny-all for the app role. Only the BYPASSRLS service role reads or writes it.
ALTER TABLE "payer_bindings" FORCE ROW LEVEL SECURITY;
