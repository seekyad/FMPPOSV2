CREATE TABLE "checkout_recoveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"store_id" integer NOT NULL,
	"terminal_id" integer NOT NULL,
	"key" text NOT NULL,
	"sale_id" integer,
	"acknowledged_at" timestamp,
	"created_by" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "checkout_recoveries" ADD CONSTRAINT "checkout_recoveries_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_recoveries" ADD CONSTRAINT "checkout_recoveries_terminal_id_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_recoveries" ADD CONSTRAINT "checkout_recoveries_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_recoveries" ADD CONSTRAINT "checkout_recoveries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_recovery_store_key_idx" ON "checkout_recoveries" USING btree ("store_id","key");