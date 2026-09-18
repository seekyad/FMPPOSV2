CREATE TABLE "auth_throttle" (
	"key" text PRIMARY KEY NOT NULL,
	"attempts" integer NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "terminal_pairings" (
	"id" serial PRIMARY KEY NOT NULL,
	"store_id" integer NOT NULL,
	"kind" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"created_by" integer,
	CONSTRAINT "terminal_pairings_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
ALTER TABLE "terminals" ADD COLUMN "kind" text DEFAULT 'pos' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "session_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "terminal_pairings" ADD CONSTRAINT "terminal_pairings_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_pairings" ADD CONSTRAINT "terminal_pairings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Preserve existing paired POS devices while removing plaintext bearer credentials.
UPDATE terminals SET device_token = encode(sha256(convert_to(device_token, 'UTF8')), 'hex');
