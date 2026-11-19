CREATE TABLE "knowledge_cite_pairs" (
	"atom_id" text NOT NULL,
	"work_item_id" text NOT NULL,
	"first_item_revision" integer NOT NULL,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_cite_pairs_atom_id_work_item_id_pk" PRIMARY KEY("atom_id","work_item_id")
);
--> statement-breakpoint
ALTER TABLE "knowledge_cite_pairs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Hand-written: RLS FORCE is outside Drizzle's DDL scope, same as 0031 and 0047. ENABLE + FORCE with NO policy is
-- deny-all for app_user: cite pairs are written and read only by the service role (story.0061).
ALTER TABLE "knowledge_cite_pairs" FORCE ROW LEVEL SECURITY;
