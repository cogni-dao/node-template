CREATE TABLE "org_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_user_id" text NOT NULL,
	"wallet" text NOT NULL,
	"scope" text NOT NULL,
	"invited_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" text,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "org_invites_scope_canonical" CHECK ("org_invites"."scope" IN ('org:owner','org:admin')),
	CONSTRAINT "org_invites_accept_is_paired" CHECK (("org_invites"."accepted_at" IS NULL) = ("org_invites"."accepted_by" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "org_invites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "org_link_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_user_id" text NOT NULL,
	"origin" text NOT NULL,
	"code_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "org_link_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "org_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_user_id" text NOT NULL,
	"issuer" text NOT NULL,
	"services" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	CONSTRAINT "org_links_close_is_paired" CHECK (("org_links"."closed_at" IS NULL) = ("org_links"."closed_by" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "org_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payer_bindings" ADD COLUMN "link_id" uuid;--> statement-breakpoint
ALTER TABLE "org_invites" ADD CONSTRAINT "org_invites_org_user_id_users_id_fk" FOREIGN KEY ("org_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invites" ADD CONSTRAINT "org_invites_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invites" ADD CONSTRAINT "org_invites_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_link_codes" ADD CONSTRAINT "org_link_codes_org_user_id_users_id_fk" FOREIGN KEY ("org_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_link_codes" ADD CONSTRAINT "org_link_codes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_links" ADD CONSTRAINT "org_links_org_user_id_users_id_fk" FOREIGN KEY ("org_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_links" ADD CONSTRAINT "org_links_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_invites_open_per_wallet" ON "org_invites" USING btree ("org_user_id","wallet") WHERE "org_invites"."accepted_at" IS NULL AND "org_invites"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "org_invites_wallet_idx" ON "org_invites" USING btree ("wallet");--> statement-breakpoint
CREATE UNIQUE INDEX "org_link_codes_hash_unique" ON "org_link_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "org_link_codes_org_idx" ON "org_link_codes" USING btree ("org_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_links_open_per_issuer" ON "org_links" USING btree ("issuer") WHERE "org_links"."closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "org_links_org_idx" ON "org_links" USING btree ("org_user_id");--> statement-breakpoint
ALTER TABLE "payer_bindings" ADD CONSTRAINT "payer_bindings_link_id_org_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."org_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_roles_live_account_unique" ON "agent_roles" USING btree ("principal_user_id","scope",coalesce("account_id", '')) WHERE "agent_roles"."revoked_at" IS NULL;--> statement-breakpoint

-- Hand-written below: FORCE RLS is outside Drizzle's DDL scope (same as 0039 / 0041 / 0046 / 0049).
-- org_invites, org_link_codes and org_links have NO policy: ENABLE + FORCE = deny-all for the app role. Only the BYPASSRLS service role reads or writes them.
ALTER TABLE "org_invites" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_link_codes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_links" FORCE ROW LEVEL SECURITY;