CREATE TABLE "identity_signin_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"nonce_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_signin_challenges_nonce_hash_unique" UNIQUE("nonce_hash")
);
--> statement-breakpoint
ALTER TABLE "identity_signin_challenges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "identity_signin_challenges_expires_at_idx" ON "identity_signin_challenges" USING btree ("expires_at");