CREATE TABLE "payout_addresses" (
	"user_id" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payout_addresses_address_lower_hex" CHECK ("payout_addresses"."address" ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
ALTER TABLE "payout_addresses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payout_beneficiaries" (
	"id" text PRIMARY KEY NOT NULL,
	"earner_user_id" text NOT NULL,
	"beneficiary_user_id" text,
	"link_hash" text,
	"link_expires_at" timestamp with time zone,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "payout_beneficiaries_no_self_benefit" CHECK ("payout_beneficiaries"."beneficiary_user_id" IS NULL OR "payout_beneficiaries"."beneficiary_user_id" <> "payout_beneficiaries"."earner_user_id"),
	CONSTRAINT "payout_beneficiaries_accepted_shape" CHECK (("payout_beneficiaries"."accepted_at" IS NULL) = ("payout_beneficiaries"."beneficiary_user_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "payout_beneficiaries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payout_addresses" ADD CONSTRAINT "payout_addresses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_beneficiaries" ADD CONSTRAINT "payout_beneficiaries_earner_user_id_users_id_fk" FOREIGN KEY ("earner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_beneficiaries" ADD CONSTRAINT "payout_beneficiaries_beneficiary_user_id_users_id_fk" FOREIGN KEY ("beneficiary_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payout_beneficiaries_one_live_per_earner" ON "payout_beneficiaries" USING btree ("earner_user_id") WHERE "payout_beneficiaries"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payout_beneficiaries_link_hash_unique" ON "payout_beneficiaries" USING btree ("link_hash");--> statement-breakpoint
CREATE INDEX "payout_beneficiaries_beneficiary_idx" ON "payout_beneficiaries" USING btree ("beneficiary_user_id");--> statement-breakpoint
-- Hand-written below: RLS FORCE and triggers are outside Drizzle's DDL scope (same as 0036, 0043).
-- Payout config is written by the BYPASSRLS service role only: ENABLE + FORCE with no policy denies the app role.
ALTER TABLE "payout_addresses" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payout_beneficiaries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- AUTH_IS_NOT_PAYMENT replaces AGENT_WALLET_IS_NOT_A_PAYEE (0043): a payee is a principal's explicit payout address (or its accepted beneficiary's), never a
-- sign-in wallet, so the kind-based leaf guard has nothing left to guard. Replace, do not stack: drop both triggers and the function.
DROP TRIGGER "epoch_distribution_leaves_agent_wallet_is_not_a_payee" ON "epoch_distribution_leaves";--> statement-breakpoint
DROP TRIGGER "distribution_settlement_leaves_agent_wallet_is_not_a_payee" ON "distribution_settlement_leaves";--> statement-breakpoint
DROP FUNCTION agent_wallet_is_not_a_payee();