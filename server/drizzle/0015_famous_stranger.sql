ALTER TABLE "payments" ADD COLUMN "legacy" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- payments created by the legacy import carry no user: they are history, not drawer cash
UPDATE "payments" SET "legacy" = true WHERE "ticket_id" IS NOT NULL AND "user_id" IS NULL AND "is_deposit" = true;
