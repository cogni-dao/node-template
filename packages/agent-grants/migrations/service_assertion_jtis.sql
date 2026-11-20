-- service_assertion_jtis: the durable replay store of `@cogni-dao/agent-grants/service-auth` (`createPostgresReplayStore`, 0.10.0).
-- node-template keeps this as 0049_service_assertion_jtis.sql; everything below this header is that file byte for byte. Do not copy it blind into a fork: see README.md.
CREATE TABLE "service_assertion_jtis" (
	"jti" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "service_assertion_jtis" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "service_assertion_jtis_expires_idx" ON "service_assertion_jtis" USING btree ("expires_at");--> statement-breakpoint

-- Hand-written below: FORCE RLS is outside Drizzle's DDL scope (same as 0039 / 0041 / 0046 / 0048).
-- service_assertion_jtis has NO policy: ENABLE + FORCE = deny-all for the app role. Only the BYPASSRLS service role reads or writes it.
ALTER TABLE "service_assertion_jtis" FORCE ROW LEVEL SECURITY;