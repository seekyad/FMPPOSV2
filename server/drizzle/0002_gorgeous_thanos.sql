CREATE TABLE "service_tiers" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_id" integer NOT NULL,
	"label" text NOT NULL,
	"price_cents" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" serial PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"name" text NOT NULL,
	"device_group" text DEFAULT 'Any device' NOT NULL,
	"time_minutes" integer DEFAULT 45 NOT NULL,
	"time_label" text,
	"parts_cost_cents" integer DEFAULT 0 NOT NULL,
	"base_price_cents" integer NOT NULL,
	"warranty_days" integer DEFAULT 90 NOT NULL,
	"intake_notes" text,
	"part_item_id" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ticket_lines" ADD COLUMN "service_id" integer;--> statement-breakpoint
ALTER TABLE "ticket_lines" ADD COLUMN "tier_label" text;--> statement-breakpoint
ALTER TABLE "service_tiers" ADD CONSTRAINT "service_tiers_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_lines" ADD CONSTRAINT "ticket_lines_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;