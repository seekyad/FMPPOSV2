-- Repair status model rework:
--   intake -> open, ready -> completed (= ready for pickup), completed -> picked_up
UPDATE "repair_tickets" SET "status" = 'picked_up' WHERE "status" = 'completed';--> statement-breakpoint
UPDATE "repair_tickets" SET "status" = 'completed' WHERE "status" = 'ready';--> statement-breakpoint
UPDATE "repair_tickets" SET "status" = 'open' WHERE "status" = 'intake';--> statement-breakpoint
UPDATE "ticket_status_history" SET "status" = 'picked_up' WHERE "status" = 'completed';--> statement-breakpoint
UPDATE "ticket_status_history" SET "status" = 'completed' WHERE "status" = 'ready';--> statement-breakpoint
UPDATE "ticket_status_history" SET "status" = 'open' WHERE "status" = 'intake';
