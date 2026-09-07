CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"store_id" integer,
	"user_id" integer,
	"action" text NOT NULL,
	"entity" text,
	"entity_id" integer,
	"detail" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_movements" (
	"id" serial PRIMARY KEY NOT NULL,
	"drawer_session_id" integer NOT NULL,
	"kind" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"reason" text,
	"user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_devices" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"model_id" integer,
	"label" text NOT NULL,
	"imei" text,
	"detail" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"note" text,
	"vip" boolean DEFAULT false NOT NULL,
	"store_credit_cents" integer DEFAULT 0 NOT NULL,
	"merged_into" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_models" (
	"id" serial PRIMARY KEY NOT NULL,
	"brand" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'phone' NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drawer_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"store_id" integer NOT NULL,
	"opening_float_cents" integer NOT NULL,
	"opened_by" integer,
	"opened_at" timestamp DEFAULT now() NOT NULL,
	"counted_cents" integer,
	"expected_cents" integer,
	"closed_by" integer,
	"closed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"store_id" integer NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"sku" text,
	"model_id" integer,
	"imei" text,
	"storage" text,
	"condition_grade" text,
	"carrier" text,
	"from_trade_in" boolean DEFAULT false NOT NULL,
	"qty" integer DEFAULT 1 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"price_cents" integer DEFAULT 0 NOT NULL,
	"taxable" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'in_stock' NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"sold_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" serial PRIMARY KEY NOT NULL,
	"item_id" integer NOT NULL,
	"delta_qty" integer NOT NULL,
	"kind" text NOT NULL,
	"reason" text,
	"ref_id" integer,
	"user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"sale_id" integer,
	"ticket_id" integer,
	"method" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"tendered_cents" integer,
	"change_cents" integer,
	"dejavoo_ref" text,
	"is_deposit" boolean DEFAULT false NOT NULL,
	"user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchases" (
	"id" serial PRIMARY KEY NOT NULL,
	"store_id" integer NOT NULL,
	"supplier" text NOT NULL,
	"note" text,
	"total_cost_cents" integer DEFAULT 0 NOT NULL,
	"received_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repair_tickets" (
	"id" serial PRIMARY KEY NOT NULL,
	"store_id" integer NOT NULL,
	"number" text NOT NULL,
	"customer_id" integer NOT NULL,
	"status" text DEFAULT 'intake' NOT NULL,
	"call_flag" boolean DEFAULT false NOT NULL,
	"technician_id" integer,
	"promised_at" timestamp,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"warranty_of_ticket_id" integer,
	"intake_by" integer,
	"notes_for_tech" text,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repair_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sale_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"sale_id" integer NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"qty" integer DEFAULT 1 NOT NULL,
	"unit_cents" integer NOT NULL,
	"discount_cents" integer DEFAULT 0 NOT NULL,
	"taxable" boolean DEFAULT true NOT NULL,
	"inventory_item_id" integer,
	"ticket_line_id" integer
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" serial PRIMARY KEY NOT NULL,
	"store_id" integer NOT NULL,
	"terminal_id" integer,
	"user_id" integer,
	"customer_id" integer,
	"ticket_number" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"parked_note" text,
	"subtotal_cents" integer DEFAULT 0 NOT NULL,
	"discount_cents" integer DEFAULT 0 NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"refund_of_sale_id" integer,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_catalog" (
	"id" serial PRIMARY KEY NOT NULL,
	"model_id" integer NOT NULL,
	"repair_type_id" integer NOT NULL,
	"price_cents" integer NOT NULL,
	"part_cost_cents" integer DEFAULT 0 NOT NULL,
	"labor_cents" integer DEFAULT 0 NOT NULL,
	"warranty_days" integer DEFAULT 90 NOT NULL,
	"turnaround_minutes" integer DEFAULT 120 NOT NULL,
	"part_item_id" integer,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_credit_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"delta_cents" integer NOT NULL,
	"reason" text NOT NULL,
	"sale_id" integer,
	"user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"phone" text,
	"tax_rate_bp" integer DEFAULT 600 NOT NULL,
	"receipt_header" text,
	"receipt_footer" text,
	"timezone" text DEFAULT 'America/Chicago' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "terminals" (
	"id" serial PRIMARY KEY NOT NULL,
	"store_id" integer NOT NULL,
	"name" text NOT NULL,
	"device_token" text NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "terminals_device_token_unique" UNIQUE("device_token")
);
--> statement-breakpoint
CREATE TABLE "ticket_devices" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_id" integer NOT NULL,
	"model_id" integer,
	"label" text NOT NULL,
	"imei" text,
	"powers_on" boolean DEFAULT true NOT NULL,
	"unlock_method" text,
	"unlock_value" text,
	"condition_notes" text
);
--> statement-breakpoint
CREATE TABLE "ticket_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_id" integer NOT NULL,
	"ticket_device_id" integer,
	"service_catalog_id" integer,
	"description" text NOT NULL,
	"price_cents" integer NOT NULL,
	"warranty_days" integer DEFAULT 90 NOT NULL,
	"part_consumed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_status_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_id" integer NOT NULL,
	"status" text NOT NULL,
	"user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"clock_in" timestamp NOT NULL,
	"clock_out" timestamp,
	"edited_by" integer,
	"edit_note" text,
	"flagged" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tradein_pricebook" (
	"id" serial PRIMARY KEY NOT NULL,
	"model_id" integer NOT NULL,
	"storage" text NOT NULL,
	"base_value_cents" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"store_id" integer NOT NULL,
	"name" text NOT NULL,
	"initials" text NOT NULL,
	"pin_hash" text NOT NULL,
	"role" text DEFAULT 'employee' NOT NULL,
	"is_technician" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_drawer_session_id_drawer_sessions_id_fk" FOREIGN KEY ("drawer_session_id") REFERENCES "public"."drawer_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_devices" ADD CONSTRAINT "customer_devices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_devices" ADD CONSTRAINT "customer_devices_model_id_device_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."device_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawer_sessions" ADD CONSTRAINT "drawer_sessions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawer_sessions" ADD CONSTRAINT "drawer_sessions_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawer_sessions" ADD CONSTRAINT "drawer_sessions_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_model_id_device_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."device_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_item_id_inventory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repair_tickets" ADD CONSTRAINT "repair_tickets_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repair_tickets" ADD CONSTRAINT "repair_tickets_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repair_tickets" ADD CONSTRAINT "repair_tickets_technician_id_users_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repair_tickets" ADD CONSTRAINT "repair_tickets_intake_by_users_id_fk" FOREIGN KEY ("intake_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_inventory_item_id_inventory_items_id_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_terminal_id_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_catalog" ADD CONSTRAINT "service_catalog_model_id_device_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."device_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_catalog" ADD CONSTRAINT "service_catalog_repair_type_id_repair_types_id_fk" FOREIGN KEY ("repair_type_id") REFERENCES "public"."repair_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_credit_ledger" ADD CONSTRAINT "store_credit_ledger_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_credit_ledger" ADD CONSTRAINT "store_credit_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminals" ADD CONSTRAINT "terminals_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_devices" ADD CONSTRAINT "ticket_devices_ticket_id_repair_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."repair_tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_devices" ADD CONSTRAINT "ticket_devices_model_id_device_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."device_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_lines" ADD CONSTRAINT "ticket_lines_ticket_id_repair_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."repair_tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_lines" ADD CONSTRAINT "ticket_lines_ticket_device_id_ticket_devices_id_fk" FOREIGN KEY ("ticket_device_id") REFERENCES "public"."ticket_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_lines" ADD CONSTRAINT "ticket_lines_service_catalog_id_service_catalog_id_fk" FOREIGN KEY ("service_catalog_id") REFERENCES "public"."service_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_status_history" ADD CONSTRAINT "ticket_status_history_ticket_id_repair_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."repair_tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_status_history" ADD CONSTRAINT "ticket_status_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_edited_by_users_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tradein_pricebook" ADD CONSTRAINT "tradein_pricebook_model_id_device_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."device_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_store_action_idx" ON "audit_log" USING btree ("store_id","action","created_at");--> statement-breakpoint
CREATE INDEX "customers_phone_idx" ON "customers" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "customers_name_idx" ON "customers" USING btree ("name");--> statement-breakpoint
CREATE INDEX "inventory_store_kind_idx" ON "inventory_items" USING btree ("store_id","kind","status");--> statement-breakpoint
CREATE INDEX "inventory_imei_idx" ON "inventory_items" USING btree ("imei");--> statement-breakpoint
CREATE INDEX "tickets_store_status_idx" ON "repair_tickets" USING btree ("store_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_number_idx" ON "repair_tickets" USING btree ("number");--> statement-breakpoint
CREATE INDEX "sales_store_status_idx" ON "sales" USING btree ("store_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_ticket_number_idx" ON "sales" USING btree ("ticket_number");--> statement-breakpoint
CREATE UNIQUE INDEX "service_catalog_model_repair_idx" ON "service_catalog" USING btree ("model_id","repair_type_id");--> statement-breakpoint
CREATE INDEX "time_entries_user_idx" ON "time_entries" USING btree ("user_id","clock_in");--> statement-breakpoint
CREATE UNIQUE INDEX "tradein_pricebook_model_storage_idx" ON "tradein_pricebook" USING btree ("model_id","storage");