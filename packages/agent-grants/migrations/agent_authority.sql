-- agent_authority: the FINAL base shape of `agent_principals` and `agent_roles`, plus the seed of the node's two internal principals
-- (node-template 0036 + 0037 + 0038 folded into one). Account columns come from `agent_account_grants.sql`, org columns from
-- `agent_principals_orgs.sql`, keys from `agent_credentials.sql`. See README.md for the steps; never copy a snapshot.
CREATE TABLE "agent_principals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"slug" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_principals_kind_canonical" CHECK ("agent_principals"."kind" IN ('internal','external')),
	CONSTRAINT "agent_principals_internal_has_slug" CHECK ("agent_principals"."kind" <> 'internal' OR "agent_principals"."slug" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "agent_principals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"principal_user_id" text NOT NULL,
	"scope" text NOT NULL,
	"approved_by" text,
	"granted_at" timestamp with time zone,
	"requested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_principals" ADD CONSTRAINT "agent_principals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_principal_user_id_users_id_fk" FOREIGN KEY ("principal_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_principals_slug_unique" ON "agent_principals" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_principals_user_id_unique" ON "agent_principals" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_roles_live_unique" ON "agent_roles" USING btree ("principal_user_id","scope") WHERE "agent_roles"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "agent_roles_principal_idx" ON "agent_roles" USING btree ("principal_user_id");--> statement-breakpoint
CREATE POLICY "agent_principals_read" ON "agent_principals" AS PERMISSIVE FOR SELECT TO public USING (true);
--> statement-breakpoint
-- Hand-written below: FORCE RLS and the seed are outside Drizzle's DDL scope.
-- agent_roles has NO policy: ENABLE + FORCE = deny-all for the app role. Only a connection that bypasses row-level security reads or writes it
-- (the guard, the role routes). agent_principals is readable by all roles, writable only by that connection.
ALTER TABLE "agent_principals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_roles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Seed (idempotent): each internal principal is a `users` row with NO wallet and NO credential, plus an `agent_principals` row of kind 'internal'.
-- Ids and slugs match `INTERNAL_AGENT_PRINCIPALS` in `@cogni-dao/agent-grants`. No role rows are seeded: a node-admin turns each role On.
-- `users` has FORCE RLS (self_isolation): set the RLS context to each principal before its insert (transaction-local).
SELECT set_config('app.current_user_id', '00000000-0000-4000-a000-0000000a0001', true);--> statement-breakpoint
INSERT INTO "users" ("id", "name", "wallet_address") VALUES ('00000000-0000-4000-a000-0000000a0001', 'node-ai', NULL) ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
SELECT set_config('app.current_user_id', '00000000-0000-4000-a000-0000000a0002', true);--> statement-breakpoint
INSERT INTO "users" ("id", "name", "wallet_address") VALUES ('00000000-0000-4000-a000-0000000a0002', 'prioritizer', NULL) ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
-- agent_principals is FORCE RLS with a select-only policy, so even its owner cannot INSERT: lift FORCE for the seed only, inside the migration transaction.
ALTER TABLE "agent_principals" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO "agent_principals" ("kind", "slug", "user_id") VALUES ('internal', 'node-ai', '00000000-0000-4000-a000-0000000a0001') ON CONFLICT ("user_id") DO NOTHING;--> statement-breakpoint
INSERT INTO "agent_principals" ("kind", "slug", "user_id") VALUES ('internal', 'prioritizer', '00000000-0000-4000-a000-0000000a0002') ON CONFLICT ("user_id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "agent_principals" FORCE ROW LEVEL SECURITY;
