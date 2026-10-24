ALTER TABLE "execution_requests" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "execution_requests" ADD COLUMN "graph_run_id" uuid;--> statement-breakpoint
ALTER TABLE "graph_runs" ADD COLUMN "terminal_result" jsonb;--> statement-breakpoint
ALTER TABLE "graph_runs" ADD COLUMN "accepted_input_key" text;--> statement-breakpoint
ALTER TABLE "execution_requests" ADD CONSTRAINT "execution_requests_graph_run_id_graph_runs_id_fk" FOREIGN KEY ("graph_run_id") REFERENCES "public"."graph_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "execution_requests_graph_run_unique" ON "execution_requests" USING btree ("graph_run_id") WHERE graph_run_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "graph_runs_accepted_input_unique" ON "graph_runs" USING btree ("accepted_input_key") WHERE accepted_input_key IS NOT NULL;