ALTER TABLE "agent_principals" DROP CONSTRAINT "agent_principals_kind_canonical";--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN "owner_source_kind" text;--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN "owner_source_ref" text;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_principals_org_source_unique" ON "agent_principals" USING btree ("owner_source_kind","owner_source_ref") WHERE "agent_principals"."kind" = 'org';--> statement-breakpoint
ALTER TABLE "agent_principals" ADD CONSTRAINT "agent_principals_org_has_owner_source" CHECK ("agent_principals"."kind" <> 'org' OR ("agent_principals"."owner_source_kind" IS NOT NULL AND "agent_principals"."owner_source_ref" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "agent_principals" ADD CONSTRAINT "agent_principals_kind_canonical" CHECK ("agent_principals"."kind" IN ('internal','external','org'));