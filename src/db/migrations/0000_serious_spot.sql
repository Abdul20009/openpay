CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"operation" text NOT NULL,
	"provider" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"reference" text NOT NULL,
	"provider_ref" text NOT NULL,
	"amount" text NOT NULL,
	"currency" text NOT NULL,
	"status" text NOT NULL,
	"customer_email" text,
	"checkout_url" text,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"payment_reference" text NOT NULL,
	"provider_ref" text NOT NULL,
	"amount" text NOT NULL,
	"currency" text NOT NULL,
	"status" text NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"reference" text NOT NULL,
	"provider_ref" text NOT NULL,
	"amount" text NOT NULL,
	"currency" text NOT NULL,
	"status" text NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfers_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"event_id" text,
	"type" text NOT NULL,
	"reference" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
