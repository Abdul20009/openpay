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
import { normalizeAmount, toMinorUnits } from "../core/validation.js";
import { firstHeader, providerJson } from "./http.js";
import type { ConnectorConfig, ProviderConnector } from "./types.js";

const DEFAULT_BASE = "https://api.paystack.co";

export function mapPaystackPaymentStatus(s: string): PaymentStatus {
  switch (s.toLowerCase()) {
    case "success":
      return "successful";
    case "failed":
    case "abandoned":
      return "failed";
    case "reversed":
      return "successful"; // money moved; reversal/refund tracked separately
    case "pending":
    case "ongoing":
    case "processing":
    case "queued":
      return "pending";
    default:
      return "unknown";
  }
}

interface PaystackInitData {
  authorization_url: string;
  access_code: string;
  reference: string;
}

export class PaystackConnector implements ProviderConnector {
  readonly name = "paystack" as const;
  readonly capabilities: ProviderCapabilities = {
    paymentsCreate: true,
    paymentsVerify: true,
    refunds: true,
    transfers: true,
    webhooks: true,
  };
  private secretKey: string;
  private baseUrl: string;
  private timeoutMs: number;
  private http: ConnectorConfig["http"];
  private webhookSecret: string;

  constructor(cfg: ConnectorConfig & { webhookSecret?: string }) {
    if (!cfg.secretKey) throw new ConfigurationError("Paystack secret key is required");
    this.secretKey = cfg.secretKey;
    this.baseUrl = (cfg.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
    this.timeoutMs = cfg.timeoutMs ?? 15_000;
    this.http = cfg.http;
    this.webhookSecret = cfg.webhookSecret ?? cfg.secretKey;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.secretKey}` };
  }

  async createPayment(input: CreatePaymentInput & { reference: string }): Promise<Payment> {
    const amount = normalizeAmount(input.amount);
    const data = await providerJson<{ status: boolean; data: PaystackInitData }>(
      `${this.baseUrl}/transaction/initialize`,
      {
        method: "POST",
        headers: this.headers(),
        body: {
          email: input.customer.email,
          amount: toMinorUnits(amount),
          reference: input.reference,
          currency: input.currency,
          callback_url: input.redirectUrl,
          metadata: input.metadata,
        },
        timeoutMs: this.timeoutMs,
        provider: "paystack",
        reference: input.reference,
        http: this.http,
      },
    );
    return {
      id: newId(),
      provider: "paystack",
      reference: input.reference,
      providerRef: data.data.reference,
      amount,
      currency: input.currency,
      status: "pending",
      checkoutUrl: data.data.authorization_url,
      customerEmail: input.customer.email,
      raw: data,
    };
  }

  async verifyPayment(input: VerifyPaymentInput): Promise<Payment> {
    const data = await providerJson<{
      data: {
        reference: string;
        amount: number;
        currency: string;
        status: string;
        customer?: { email?: string };
      };
    }>(`${this.baseUrl}/transaction/verify/${encodeURIComponent(input.reference)}`, {
      headers: this.headers(),
      timeoutMs: this.timeoutMs,
      provider: "paystack",
      reference: input.reference,
      http: this.http,
    });
    const d = data.data;
    return {
      id: newId(),
      provider: "paystack",
      reference: d.reference,
      providerRef: d.reference,
      amount: (d.amount / 100).toFixed(2),
      currency: d.currency,
      status: mapPaystackPaymentStatus(d.status),
      customerEmail: d.customer?.email,
      raw: data,
    };
  }

  async createRefund(input: CreateRefundInput): Promise<Refund> {
    const data = await providerJson<{ data: { id: number; status: string; transaction?: { reference?: string } } }>(
      `${this.baseUrl}/refund`,
      {
        method: "POST",
        headers: this.headers(),
        body: {
          transaction: input.paymentReference,
          amount: input.amount ? toMinorUnits(normalizeAmount(input.amount)) : undefined,
        },
        timeoutMs: this.timeoutMs,
        provider: "paystack",
        reference: input.paymentReference,
        http: this.http,
      },
    );
    const s = String(data.data.status).toLowerCase();
    const status: PaymentStatus =
      s === "processed" ? "successful" : s === "failed" ? "failed" : s === "pending" || s === "processing" ? "pending" : "unknown";
    return {
      id: newId(),
      provider: "paystack",
      paymentReference: input.paymentReference,
      providerRef: String(data.data.id),
      amount: normalizeAmount(input.amount ?? "0.00"),
      currency: input.currency ?? "NGN",
      status,
      raw: data,
    };
  }

  async createTransfer(input: CreateTransferInput & { reference: string }): Promise<Transfer> {
    // Step 1: create recipient, Step 2: initiate transfer
    const recipient = await providerJson<{ data: { recipient_code: string } }>(
      `${this.baseUrl}/transferrecipient`,
      {
        method: "POST",
        headers: this.headers(),
        body: {
          type: "nuban",
          name: input.accountName ?? input.accountNumber,
          account_number: input.accountNumber,
          bank_code: input.bankCode,
          currency: input.currency,
        },
        timeoutMs: this.timeoutMs,
        provider: "paystack",
        reference: input.reference,
        http: this.http,
      },
    );
    const transfer = await providerJson<{ data: { reference: string; status: string } }>(
      `${this.baseUrl}/transfer`,
      {
        method: "POST",
        headers: this.headers(),
        body: {
          source: "balance",
          amount: toMinorUnits(normalizeAmount(input.amount)),
          recipient: recipient.data.recipient_code,
          reference: input.reference,
          reason: input.narration,
        },
        timeoutMs: this.timeoutMs,
        provider: "paystack",
        reference: input.reference,
        http: this.http,
      },
    );
    const s = transfer.data.status.toLowerCase();
    return {
      id: newId(),
      provider: "paystack",
      reference: input.reference,
      providerRef: transfer.data.reference,
      amount: normalizeAmount(input.amount),
      currency: input.currency,
      status: s === "success" ? "successful" : s === "failed" ? "failed" : "pending",
      raw: { recipient, transfer },
    };
  }

  async verifyTransfer(reference: string): Promise<Transfer> {
    const data = await providerJson<{
      data: { reference: string; amount: number; currency: string; status: string };
    }>(`${this.baseUrl}/transfer/verify/${encodeURIComponent(reference)}`, {
      headers: this.headers(),
      timeoutMs: this.timeoutMs,
      provider: "paystack",
      reference,
      http: this.http,
    });
    const s = data.data.status.toLowerCase();
    return {
      id: newId(),
      provider: "paystack",
      reference: data.data.reference,
      providerRef: data.data.reference,
      amount: (data.data.amount / 100).toFixed(2),
      currency: data.data.currency,
      status: s === "success" ? "successful" : s === "failed" ? "failed" : s === "pending" ? "pending" : "unknown",
      raw: data,
    };
  }

  verifyWebhookSignature(rawBody: string | Buffer, headers: WebhookHeaders): boolean {
    const sig = firstHeader(headers, "x-paystack-signature", "X-Paystack-Signature");
    if (!sig) return false;
    const digest = createHmac("sha512", this.webhookSecret).update(rawBody).digest("hex");
    const a = Buffer.from(digest);
    const b = Buffer.from(sig);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  normalizeWebhook(payload: unknown): OpenPayEvent | null {
    if (typeof payload !== "object" || payload === null) return null;
    const p = payload as {
      event?: string;
      data?: {
        reference?: string;
        id?: number;
        refund_reference?: string;
        transaction_reference?: string;
      };
    };
    if (!p.event) return null;
    const map: Record<string, OpenPayEvent["type"]> = {
      "charge.success": "payment.succeeded",
      "charge.failed": "payment.failed",
      "transfer.success": "transfer.succeeded",
      "transfer.failed": "transfer.failed",
      "transfer.reversed": "transfer.failed",
      "refund.processed": "refund.processed",
      "refund.failed": "refund.failed",
      "refund.pending": "payment.pending",
      "refund.processing": "payment.pending",
    };
    const type = map[p.event] ?? "unknown";
    // Stable dedupe id: numeric object id where present, otherwise the
    // provider's own references (refund retries share refund_reference).
    const eventId =
      p.data?.id !== undefined
        ? String(p.data.id)
        : (p.data?.refund_reference ?? p.data?.transaction_reference ?? p.data?.reference);
    return {
      type,
      provider: "paystack",
      providerEventId: eventId,
      reference: p.data?.reference ?? p.data?.transaction_reference,
      raw: payload,
    };
  }

  // Narrowing helper so TS keeps `capabilities` honest if extended later.
  assertSupports(op: "refunds" | "transfers"): void {
    if (!this.capabilities[op]) throw new CapabilityError("paystack", op);
  }
}
