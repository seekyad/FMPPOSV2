CREATE TABLE "document_counters" (
	"key" text PRIMARY KEY NOT NULL,
	"value" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refund_allocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"original_line_id" integer NOT NULL,
	"refund_sale_id" integer NOT NULL,
	"amount_cents" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_allocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"sale_id" integer NOT NULL,
	"sale_line_id" integer,
	"ticket_id" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"legacy_payment" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sale_lines" ADD COLUMN "net_cents" integer;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD COLUMN "tax_cents" integer;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "checkout_key" text;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "checkout_hash" text;--> statement-breakpoint
ALTER TABLE "refund_allocations" ADD CONSTRAINT "refund_allocations_original_line_id_sale_lines_id_fk" FOREIGN KEY ("original_line_id") REFERENCES "public"."sale_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_allocations" ADD CONSTRAINT "refund_allocations_refund_sale_id_sales_id_fk" FOREIGN KEY ("refund_sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_allocations" ADD CONSTRAINT "ticket_allocations_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_allocations" ADD CONSTRAINT "ticket_allocations_sale_line_id_sale_lines_id_fk" FOREIGN KEY ("sale_line_id") REFERENCES "public"."sale_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_allocations" ADD CONSTRAINT "ticket_allocations_ticket_id_repair_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."repair_tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "refund_original_line_idx" ON "refund_allocations" USING btree ("original_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_checkout_key_idx" ON "sales" USING btree ("store_id","checkout_key");
--> statement-breakpoint
-- Preserve legacy repair bookkeeping as allocations, including original row data for investigation.
INSERT INTO ticket_allocations (sale_id, ticket_id, amount_cents, created_at, legacy_payment)
SELECT p.sale_id, p.ticket_id, p.amount_cents, p.created_at, to_jsonb(p)
FROM payments p WHERE p.sale_id IS NOT NULL AND p.ticket_id IS NOT NULL;
--> statement-breakpoint
DELETE FROM payments WHERE sale_id IS NOT NULL AND ticket_id IS NOT NULL;
