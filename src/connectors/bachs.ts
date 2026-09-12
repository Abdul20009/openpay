import { createHmac, timingSafeEqual } from "node:crypto";
import { CapabilityError, ConfigurationError } from "../core/errors.js";
import { newId } from "../core/idempotency.js";
import type {
  CreatePaymentInput,
  CreateRefundInput,
  CreateTransferInput,
  OpenPayEvent,
  Payment,
  PaymentStatus,
  ProviderCapabilities,
  Refund,
  Transfer,
  VerifyPaymentInput,
  WebhookHeaders,
} from "../core/types.js";
import { normalizeAmount } from "../core/validation.js";
import { firstHeader, providerJson } from "./http.js";
import type { ConnectorConfig, ProviderConnector } from "./types.js";

const SANDBOX_BASE = "https://sandbox-api.bachs.io";
const LIVE_BASE = "https://api.bachs.io";

export function mapBachsPaymentStatus(s: string): PaymentStatus {
  switch (s.toLowerCase()) {
    case "succeeded":
    case "paid":
    case "completed":
    case "success":
      return "successful";
    case "failed":
    case "cancelled":
    case "canceled":
    case "expired":
      return "failed";
    case "pending":
    case "processing":
    case "requires_action":
    case "requiresaction":
    case "created":
      return "pending";
    default:
      return "unknown";
  }
}

/**
 * Bachs is checkout-session based, not charge based.
 * createPayment -> POST /v1/checkout-sessions (pricing + customer + reference)
 * verifyPayment -> GET /v1/checkout-sessions/:id (payment_status + charge)
 * Refunds/transfers have no V1 equivalent -> CapabilityError.
 */
export class BachsConnector implements ProviderConnector {
  readonly name = "bachs" as const;
  readonly capabilities: ProviderCapabilities = {
    paymentsCreate: true,
    paymentsVerify: true,
    refunds: false,
    transfers: false,
    webhooks: true,
  };
  private secretKey: string;
  private baseUrl: string;
  private timeoutMs: number;
  private http: ConnectorConfig["http"];
  private webhookSecret?: string;

  constructor(cfg: ConnectorConfig & { webhookSecret?: string }) {
    if (!cfg.secretKey) throw new ConfigurationError("Bachs secret key is required");
    this.secretKey = cfg.secretKey;
    this.baseUrl = (cfg.baseUrl ?? (cfg.secretKey.startsWith("sk_live_") ? LIVE_BASE : SANDBOX_BASE)).replace(/\/$/, "");
    this.timeoutMs = cfg.timeoutMs ?? 15_000;
    this.http = cfg.http;
    this.webhookSecret = cfg.webhookSecret;
  }

  private headers(idempotencyKey?: string): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${this.secretKey}` };
    // Bachs supports Idempotency-Key on POSTs — forward ours when available.
    if (idempotencyKey) h["Idempotency-Key"] = idempotencyKey;
    return h;
  }

  async createPayment(input: CreatePaymentInput & { reference: string }): Promise<Payment> {
    const amount = normalizeAmount(input.amount);
    const data = await providerJson<{
      checkout_id?: string;
      checkoutId?: string;
      id?: string;
      checkout_url?: string;
      checkoutUrl?: string;
      url?: string;
    }>(`${this.baseUrl}/v1/checkout-sessions`, {
      method: "POST",
      headers: this.headers(input.idempotencyKey),
      body: {
        pricing: { currency: input.currency, amount },
        customer: { email: input.customer.email, name: input.customer.name },
        reference: input.reference,
        success_url: input.redirectUrl,
        cancel_url: input.redirectUrl,
        metadata: input.metadata,
      },
      timeoutMs: this.timeoutMs,
      provider: "bachs",
      reference: input.reference,
      http: this.http,
    });
    const checkoutId = data.checkout_id ?? data.checkoutId ?? data.id ?? input.reference;
    const checkoutUrl = data.checkout_url ?? data.checkoutUrl ?? data.url;
    return {
      id: newId(),
      provider: "bachs",
      reference: input.reference,
      providerRef: checkoutId,
      amount,
      currency: input.currency,
      status: "pending",
      checkoutUrl,
      customerEmail: input.customer.email,
      raw: data,
    };
  }

  async verifyPayment(input: VerifyPaymentInput): Promise<Payment> {
    const data = await providerJson<{
      checkout_id?: string;
      payment_status?: string;
      status?: string;
      amount?: string | number;
      currency?: string;
      customer?: { email?: string };
      charge?: { status?: string };
    }>(`${this.baseUrl}/v1/checkout-sessions/${encodeURIComponent(input.reference)}`, {
      headers: this.headers(),
      timeoutMs: this.timeoutMs,
      provider: "bachs",
      reference: input.reference,
      http: this.http,
    });
    const rawStatus =
      data.payment_status ?? data.charge?.status ?? data.status ?? "unknown";
    return {
      id: newId(),
      provider: "bachs",
      reference: (data.checkout_id as string) ?? input.reference,
      providerRef: (data.checkout_id as string) ?? input.reference,
      amount:
        typeof data.amount === "number"
          ? data.amount.toFixed(2)
          : typeof data.amount === "string"
            ? normalizeAmount(data.amount)
            : "0.00",
      currency: data.currency ?? "NGN",
      status: mapBachsPaymentStatus(rawStatus),
      customerEmail: data.customer?.email,
      raw: data,
    };
  }

  async createRefund(_input: CreateRefundInput): Promise<Refund> {
    throw new CapabilityError("bachs", "refunds", "no refund API in Bachs V1 docs; use dashboard or provider API directly");
  }

  async createTransfer(_input: CreateTransferInput & { reference: string }): Promise<Transfer> {
    throw new CapabilityError("bachs", "transfers", "no transfer/payout API in Bachs V1 docs");
  }

  async verifyTransfer(_reference: string): Promise<Transfer> {
    throw new CapabilityError("bachs", "transfers", "no transfer/payout API in Bachs V1 docs");
  }

  verifyWebhookSignature(rawBody: string | Buffer, headers: WebhookHeaders): boolean {
    // Provisional: HMAC-SHA256 over raw body. Confirm header name against Bachs dashboard.
    if (!this.webhookSecret) return false;
    const sig = firstHeader(headers, "x-bachs-signature", "bachs-signature", "x-webhook-signature");
    if (!sig) return false;
    const digest = createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex");
    const a = Buffer.from(digest);
    const b = Buffer.from(sig.replace(/^sha256=/, ""));
    return a.length === b.length && timingSafeEqual(a, b);
  }

  normalizeWebhook(payload: unknown): OpenPayEvent | null {
    if (typeof payload !== "object" || payload === null) return null;
    const p = payload as {
      type?: string;
      event?: string;
      data?: { checkout_id?: string; reference?: string; id?: string };
    };
    const name = (p.type ?? p.event ?? "").toLowerCase();
    if (!name) return null;
    if (name === "collection.succeeded" || name === "checkout.succeeded" || name === "payment.succeeded") {
      return {
        type: "payment.succeeded",
        provider: "bachs",
        providerEventId: p.data?.id,
        reference: p.data?.checkout_id ?? p.data?.reference,
        raw: payload,
      };
    }
    if (name === "collection.failed" || name === "payment.failed" || name === "checkout.expired") {
      return {
        type: "payment.failed",
        provider: "bachs",
        providerEventId: p.data?.id,
        reference: p.data?.checkout_id ?? p.data?.reference,
        raw: payload,
      };
    }
    return { type: "unknown", provider: "bachs", raw: payload };
  }
}
