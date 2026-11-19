CREATE TABLE "outbound_connections" (
	"target_origin" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"cap" bigint NOT NULL,
	"seq" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_connections_status_canonical" CHECK ("outbound_connections"."status" IN ('connected','disconnected')),
	CONSTRAINT "outbound_connections_cap_nonnegative" CHECK ("outbound_connections"."cap" >= 0),
	CONSTRAINT "outbound_connections_seq_nonnegative" CHECK ("outbound_connections"."seq" >= 0)
);
--> statement-breakpoint
ALTER TABLE "outbound_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Hand-written below: FORCE RLS is outside Drizzle's DDL scope (same as 0039 / 0041 / 0046 / 0048).
-- outbound_connections has NO policy: ENABLE + FORCE = deny-all for the app role. Only the BYPASSRLS service role reads or writes it.
ALTER TABLE "outbound_connections" FORCE ROW LEVEL SECURITY;
