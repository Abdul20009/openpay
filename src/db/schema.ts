import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Minimal V1 persistence. Only what reliability rules need:
 * payments / transfers / refunds ledger rows + idempotency keys + webhook events.
 * No business logic in SQL — constraints only.
 */

export const payments = pgTable("payments", {
  id: uuid("id").primaryKey(),
  provider: text("provider").notNull(),
  reference: text("reference").notNull().unique(),
  providerRef: text("provider_ref").notNull(),
  amount: text("amount").notNull(),
  currency: text("currency").notNull(),
  status: text("status").notNull(),
  customerEmail: text("customer_email"),
  checkoutUrl: text("checkout_url"),
  raw: jsonb("raw"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const transfers = pgTable("transfers", {
  id: uuid("id").primaryKey(),
  provider: text("provider").notNull(),
  reference: text("reference").notNull().unique(),
  providerRef: text("provider_ref").notNull(),
  amount: text("amount").notNull(),
  currency: text("currency").notNull(),
  status: text("status").notNull(),
  raw: jsonb("raw"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const refunds = pgTable("refunds", {
  id: uuid("id").primaryKey(),
  provider: text("provider").notNull(),
  paymentReference: text("payment_reference").notNull(),
  providerRef: text("provider_ref").notNull(),
  amount: text("amount").notNull(),
  currency: text("currency").notNull(),
  status: text("status").notNull(),
  raw: jsonb("raw"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").primaryKey(),
  operation: text("operation").notNull(),
  provider: text("provider").notNull(),
  response: jsonb("response").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey(),
    provider: text("provider").notNull(),
    eventId: text("event_id"),
    type: text("type").notNull(),
    reference: text("reference"),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Retried deliveries of the same provider event collapse into one row.
    // eventId is always populated at insert time (real id or content hash).
    uniqueIndex("webhook_events_provider_type_event_uidx").on(t.provider, t.type, t.eventId),
  ],
);
