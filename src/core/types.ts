/**
 * OpenPay NG — common domain models (V1).
 *
 * Money convention (Bachs-style, per project decision):
 * - `amount` is ALWAYS a decimal string at the currency's precision, e.g. "5000.00"
 * - `currency` is an ISO-4217 code, e.g. "NGN"
 * Never use floats or minor-unit integers in the public interface.
 * Minor-unit conversion (e.g. Paystack kobo) happens INSIDE connectors only.
 */

export type ProviderName = "paystack" | "flutterwave" | "bachs";

/**
 * Webhook request headers. Node/Express `req.headers` (`IncomingHttpHeaders`)
 * can be passed directly: values may be `string | string[] | undefined` and
 * the first value wins for repeated headers — same rule as the local receiver.
 */
export type WebhookHeaderValue = string | string[] | undefined;
export type WebhookHeaders = Record<string, WebhookHeaderValue>;

/**
 * Normalized payment lifecycle.
 * - pending: created / awaiting customer action / processor pending
 * - successful: money moved and confirmed (verify or webhook)
 * - failed: definitively failed / cancelled / expired
 * - unknown: timed out, ambiguous, or unmapped — MUST be verified before retry
 */
export type PaymentStatus = "pending" | "successful" | "failed" | "unknown";

export type TransferStatus = PaymentStatus;
export type RefundStatus = PaymentStatus;

export interface Customer {
  email: string;
  name?: string;
  phone?: string;
}

export interface CreatePaymentInput {
  /** Decimal string, e.g. "5000.00" */
  amount: string;
  currency: string;
  customer: Customer;
  /** Which provider connector to use. Defaults via config. */
  provider?: ProviderName;
  /** Merchant's unique reference. Generated if omitted. */
  reference?: string;
  /** Idempotency key. Defaults to `payments:{provider}:{reference}`. */
  idempotencyKey?: string;
  redirectUrl?: string;
  metadata?: Record<string, string>;
}

export interface Payment {
  /** Our record id (uuid). */
  id: string;
  provider: ProviderName;
  /** Merchant reference (what you passed / what we generated). */
  reference: string;
  /** Provider-side id: Paystack reference, Flutterwave tx_ref/id, Bachs checkout_id. */
  providerRef: string;
  amount: string;
  currency: string;
  status: PaymentStatus;
  /** Hosted checkout / authorization URL for the customer (if any). */
  checkoutUrl?: string;
  customerEmail?: string;
  /** Raw provider response for debugging. Never expose card data. */
  raw?: unknown;
}

export interface VerifyPaymentInput {
  provider?: ProviderName;
  /** Merchant reference OR provider ref — connectors try both. */
  reference: string;
}

export interface CreateTransferInput {
  amount: string;
  currency: string;
  accountNumber: string;
  bankCode: string;
  accountName?: string;
  narration?: string;
  provider?: ProviderName;
  reference?: string;
  idempotencyKey?: string;
  metadata?: Record<string, string>;
}

export interface Transfer {
  id: string;
  provider: ProviderName;
  reference: string;
  providerRef: string;
  amount: string;
  currency: string;
  status: TransferStatus;
  raw?: unknown;
}

export interface CreateRefundInput {
  /** Merchant payment reference to refund. */
  paymentReference: string;
  amount?: string;
  currency?: string;
  reason?: string;
  provider?: ProviderName;
  idempotencyKey?: string;
}

export interface Refund {
  id: string;
  provider: ProviderName;
  paymentReference: string;
  providerRef: string;
  amount: string;
  currency: string;
  status: RefundStatus;
  raw?: unknown;
}

export type OpenPayEventType =
  | "payment.succeeded"
  | "payment.failed"
  | "payment.pending"
  | "transfer.succeeded"
  | "transfer.failed"
  | "refund.processed"
  | "refund.failed"
  | "unknown";

export interface OpenPayEvent {
  type: OpenPayEventType;
  provider: ProviderName;
  /** Provider event id if available (for dedupe). */
  providerEventId?: string;
  /** Merchant reference if extractable. */
  reference?: string;
  raw: unknown;
}

/** Capability flags — OpenPay never pretends providers are identical. */
export interface ProviderCapabilities {
  paymentsCreate: boolean;
  paymentsVerify: boolean;
  refunds: boolean;
  transfers: boolean;
  webhooks: boolean;
}
