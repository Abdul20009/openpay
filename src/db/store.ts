import { createHash } from "node:crypto";
import { newId } from "../core/idempotency.js";
import type { OpenPayEvent, Payment, PaymentStatus, ProviderName, Refund, Transfer } from "../core/types.js";
import { idempotencyKeys, payments, refunds, transfers, webhookEvents } from "./schema.js";
import type { Db } from "./client.js";

/**
 * Resolve a non-null dedupe id for a webhook event.
 * Real provider event id when available, otherwise a stable content hash
 * (identical retried deliveries produce identical hashes).
 */
export function resolveWebhookEventId(event: OpenPayEvent, raw: unknown): string {
  if (event.providerEventId) return event.providerEventId;
  return createHash("sha256")
    .update(typeof raw === "string" ? raw : JSON.stringify(raw))
    .digest("hex");
}

/**
 * Persistence port. Services depend on this interface, not on Drizzle directly.
 * Production: DrizzlePersistence. Tests / stateless mode: MemoryPersistence.
 */
export interface Persistence {
  findIdempotency<T>(key: string): Promise<T | null>;
  saveIdempotency(key: string, operation: string, provider: string, response: unknown): Promise<void>;
  savePayment(payment: Payment): Promise<void>;
  saveTransfer(transfer: Transfer): Promise<void>;
  saveRefund(refund: Refund): Promise<void>;
  /**
   * Persist a webhook event. Returns true when newly inserted, false when
   * this exact event was already recorded (duplicate delivery).
   * Existing callers may ignore the return value.
   */
  saveWebhookEvent(event: OpenPayEvent, raw: unknown): Promise<boolean>;
  /**
   * Set a payment's status, matching provider + (reference OR providerRef).
   * Returns true when a row was updated, false when no payment matched.
   * Status-only write: never touches amount/currency/refs. Idempotent.
   */
  updatePaymentStatus(provider: ProviderName, reference: string, status: PaymentStatus): Promise<boolean>;
}

export class MemoryPersistence implements Persistence {
  private idem = new Map<string, unknown>();
  private seenWebhooks = new Set<string>();
  readonly paymentRows: Payment[] = [];
  readonly transferRows: Transfer[] = [];
  readonly refundRows: Refund[] = [];
  readonly webhookRows: { event: OpenPayEvent; raw: unknown }[] = [];

  async findIdempotency<T>(key: string): Promise<T | null> {
    return (this.idem.get(key) as T | undefined) ?? null;
  }

  async saveIdempotency(key: string, _op: string, _provider: string, response: unknown): Promise<void> {
    // First write wins — repeated requests must not create duplicates.
    if (!this.idem.has(key)) this.idem.set(key, response);
  }

  async savePayment(payment: Payment): Promise<void> {
    const i = this.paymentRows.findIndex((p) => p.reference === payment.reference);
    if (i >= 0) this.paymentRows[i] = payment;
    else this.paymentRows.push(payment);
  }

  async saveTransfer(transfer: Transfer): Promise<void> {
    this.transferRows.push(transfer);
  }

  async saveRefund(refund: Refund): Promise<void> {
    this.refundRows.push(refund);
  }

  async saveWebhookEvent(event: OpenPayEvent, raw: unknown): Promise<boolean> {
    const key = `${event.provider}\n${event.type}\n${resolveWebhookEventId(event, raw)}`;
    if (this.seenWebhooks.has(key)) return false;
    this.seenWebhooks.add(key);
    this.webhookRows.push({ event, raw });
    return true;
  }

  async updatePaymentStatus(
    provider: ProviderName,
    reference: string,
    status: PaymentStatus,
  ): Promise<boolean> {
    const row = this.paymentRows.find(
      (p) => p.provider === provider && (p.reference === reference || p.providerRef === reference),
    );
    if (!row) return false;
    row.status = status;
    return true;
  }
}

export class DrizzlePersistence implements Persistence {
  constructor(private db: Db) {}

  async findIdempotency<T>(key: string): Promise<T | null> {
    const { eq } = await import("drizzle-orm");
    const rows = await this.db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, key))
      .limit(1);
    const row = rows[0] as unknown as { response: T } | undefined;
    return row ? row.response : null;
  }

  async saveIdempotency(key: string, operation: string, provider: string, response: unknown): Promise<void> {
    await this.db
      .insert(idempotencyKeys)
      .values({ key, operation, provider, response: response as object })
      .onConflictDoNothing({ target: idempotencyKeys.key });
  }

  async savePayment(payment: Payment): Promise<void> {
    await this.db
      .insert(payments)
      .values({
        id: payment.id,
        provider: payment.provider,
        reference: payment.reference,
        providerRef: payment.providerRef,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        customerEmail: payment.customerEmail,
        checkoutUrl: payment.checkoutUrl,
        raw: payment.raw as object,
      })
      .onConflictDoUpdate({
        target: payments.reference,
        set: {
          providerRef: payment.providerRef,
          status: payment.status,
          checkoutUrl: payment.checkoutUrl,
          raw: payment.raw as object,
          updatedAt: new Date(),
        },
      });
  }

  async saveTransfer(transfer: Transfer): Promise<void> {
    await this.db.insert(transfers).values({
      id: transfer.id,
      provider: transfer.provider,
      reference: transfer.reference,
      providerRef: transfer.providerRef,
      amount: transfer.amount,
      currency: transfer.currency,
      status: transfer.status,
      raw: transfer.raw as object,
    });
  }

  async saveRefund(refund: Refund): Promise<void> {
    await this.db.insert(refunds).values({
      id: refund.id,
      provider: refund.provider,
      paymentReference: refund.paymentReference,
      providerRef: refund.providerRef,
      amount: refund.amount,
      currency: refund.currency,
      status: refund.status,
      raw: refund.raw as object,
    });
  }

  async updatePaymentStatus(
    provider: ProviderName,
    reference: string,
    status: PaymentStatus,
  ): Promise<boolean> {
    const { and, eq, or } = await import("drizzle-orm");
    const rows = await this.db
      .update(payments)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(payments.provider, provider),
          or(eq(payments.reference, reference), eq(payments.providerRef, reference)),
        ),
      )
      .returning({ id: payments.id });
    return rows.length > 0;
  }

  async saveWebhookEvent(event: OpenPayEvent, raw: unknown): Promise<boolean> {
    // The unique index is the concurrency arbiter: simultaneous duplicate
    // deliveries collapse into one row, and RETURNING tells us if we won.
    const rows = await this.db
      .insert(webhookEvents)
      .values({
        id: newId(),
        provider: event.provider,
        eventId: resolveWebhookEventId(event, raw),
        type: event.type,
        reference: event.reference,
        payload: raw as object,
      })
      .onConflictDoNothing({
        target: [webhookEvents.provider, webhookEvents.type, webhookEvents.eventId],
      })
      .returning({ id: webhookEvents.id });
    return rows.length > 0;
  }
}
