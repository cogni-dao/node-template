CREATE TABLE "knowledge_read_daily" (
	"day" date NOT NULL,
	"atom_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"principal_class" text NOT NULL,
	"ok_count" integer DEFAULT 0 NOT NULL,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_read_daily_day_atom_id_principal_id_principal_class_pk" PRIMARY KEY("day","atom_id","principal_id","principal_class"),
	CONSTRAINT "knowledge_read_daily_principal_class_check" CHECK ("knowledge_read_daily"."principal_class" IN ('internal_run', 'external_agent'))
);
--> statement-breakpoint
ALTER TABLE "knowledge_read_daily" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Hand-written: RLS FORCE is outside Drizzle's DDL scope, same as 0031. ENABLE + FORCE with NO policy is
-- deny-all for app_user: read counters are written and read only by the service role (story.0061).
ALTER TABLE "knowledge_read_daily" FORCE ROW LEVEL SECURITY;
