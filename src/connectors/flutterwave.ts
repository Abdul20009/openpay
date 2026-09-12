import { ConfigurationError, ValidationError } from "../core/errors.js";
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

const DEFAULT_BASE = "https://api.flutterwave.com/v3";

export function mapFlutterwaveStatus(s: string): PaymentStatus {
  switch (s.toLowerCase()) {
    case "successful":
    case "success":
    case "completed":
      return "successful";
    case "failed":
    case "cancelled":
      return "failed";
    case "pending":
    case "processing":
    case "new":
      return "pending";
    default:
      return "unknown";
  }
}

export class FlutterwaveConnector implements ProviderConnector {
  readonly name = "flutterwave" as const;
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

  constructor(cfg: ConnectorConfig & { webhookSecretHash?: string }) {
    if (!cfg.secretKey) throw new ConfigurationError("Flutterwave secret key is required");
    this.secretKey = cfg.secretKey;
    this.baseUrl = (cfg.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
    this.timeoutMs = cfg.timeoutMs ?? 15_000;
    this.http = cfg.http;
    this.webhookSecret = cfg.webhookSecretHash ?? cfg.secretKey;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.secretKey}` };
  }

  async createPayment(input: CreatePaymentInput & { reference: string }): Promise<Payment> {
    // Provider evidence (sandbox 400: "Redirect URL is required"): Flutterwave
    // mandates redirect_url on POST /v3/payments. Fail fast with a clear SDK
    // error instead of an opaque provider rejection.
    if (!input.redirectUrl) {
      throw new ValidationError("Flutterwave requires redirectUrl for payments.create()");
    }
    const amount = normalizeAmount(input.amount);
    const data = await providerJson<{ data: { link: string; flw_ref?: string } }>(
      `${this.baseUrl}/payments`,
      {
        method: "POST",
        headers: this.headers(),
        body: {
          tx_ref: input.reference,
          amount,
          currency: input.currency,
          customer: { email: input.customer.email, name: input.customer.name, phonenumber: input.customer.phone },
          redirect_url: input.redirectUrl,
          meta: input.metadata,
        },
        timeoutMs: this.timeoutMs,
        provider: "flutterwave",
        reference: input.reference,
        http: this.http,
      },
    );
    return {
      id: newId(),
      provider: "flutterwave",
      reference: input.reference,
      providerRef: data.data.flw_ref ?? input.reference,
      amount,
      currency: input.currency,
      status: "pending",
      checkoutUrl: data.data.link,
      customerEmail: input.customer.email,
      raw: data,
    };
  }

  async verifyPayment(input: VerifyPaymentInput): Promise<Payment> {
    // Prefer verify-by-reference so callers can use the merchant tx_ref.
    const data = await providerJson<{
      data: {
        id: number;
        tx_ref: string;
        flw_ref: string;
        amount: number;
        currency: string;
        status: string;
        customer?: { email?: string };
      };
    }>(`${this.baseUrl}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(input.reference)}`, {
      headers: this.headers(),
      timeoutMs: this.timeoutMs,
      provider: "flutterwave",
      reference: input.reference,
      http: this.http,
    });
    const d = data.data;
    return {
      id: newId(),
      provider: "flutterwave",
      reference: d.tx_ref,
      providerRef: String(d.id),
      amount: Number(d.amount).toFixed(2),
      currency: d.currency,
      status: mapFlutterwaveStatus(d.status),
      customerEmail: d.customer?.email,
      raw: data,
    };
  }

  async createRefund(input: CreateRefundInput): Promise<Refund> {
    // Flutterwave refunds address the numeric transaction id.
    // verifyPayment() stores it in providerRef; callers may also pass it directly.
    const data = await providerJson<{ data: { id: number; status: string } }>(
      `${this.baseUrl}/transactions/${encodeURIComponent(input.paymentReference)}/refund`,
      {
        method: "POST",
        headers: this.headers(),
        body: {
          amount: input.amount ? normalizeAmount(input.amount) : undefined,
          comments: input.reason,
        },
        timeoutMs: this.timeoutMs,
        provider: "flutterwave",
        reference: input.paymentReference,
        http: this.http,
      },
    );
    const s = String(data.data.status).toLowerCase();
    return {
      id: newId(),
      provider: "flutterwave",
      paymentReference: input.paymentReference,
      providerRef: String(data.data.id),
      amount: normalizeAmount(input.amount ?? "0.00"),
      currency: input.currency ?? "NGN",
      status: s.startsWith("completed") ? "successful" : s === "failed" ? "failed" : "pending",
      raw: data,
    };
  }

  async createTransfer(input: CreateTransferInput & { reference: string }): Promise<Transfer> {
    const data = await providerJson<{ data: { id: number; reference: string; status: string } }>(
      `${this.baseUrl}/transfers`,
      {
        method: "POST",
        headers: this.headers(),
        body: {
          account_bank: input.bankCode,
          account_number: input.accountNumber,
          amount: normalizeAmount(input.amount),
          currency: input.currency,
          narration: input.narration,
          reference: input.reference,
          meta: input.metadata,
        },
        timeoutMs: this.timeoutMs,
        provider: "flutterwave",
        reference: input.reference,
        http: this.http,
      },
    );
    return {
      id: newId(),
      provider: "flutterwave",
      reference: input.reference,
      providerRef: String(data.data.id),
      amount: normalizeAmount(input.amount),
      currency: input.currency,
      status: mapFlutterwaveStatus(data.data.status),
      raw: data,
    };
  }

  async verifyTransfer(reference: string): Promise<Transfer> {
    const data = await providerJson<{
      data: { id: number; reference: string; amount: number; currency: string; status: string };
    }>(`${this.baseUrl}/transfers/${encodeURIComponent(reference)}`, {
      headers: this.headers(),
      timeoutMs: this.timeoutMs,
      provider: "flutterwave",
      reference,
      http: this.http,
    });
    return {
      id: newId(),
      provider: "flutterwave",
      reference: data.data.reference,
      providerRef: String(data.data.id),
      amount: Number(data.data.amount).toFixed(2),
      currency: data.data.currency,
      status: mapFlutterwaveStatus(data.data.status),
      raw: data,
    };
  }

  verifyWebhookSignature(_rawBody: string | Buffer, headers: WebhookHeaders): boolean {
    // Flutterwave sends `verif-hash` == your webhook secret hash (dashboard setting).
    const h = firstHeader(headers, "verif-hash", "Verif-Hash");
    if (!h) return false;
    return h === this.webhookSecret;
  }

  normalizeWebhook(payload: unknown): OpenPayEvent | null {
    if (typeof payload !== "object" || payload === null) return null;
    const p = payload as {
      event?: string;
      data?: { id?: number; tx_ref?: string; reference?: string; status?: string };
      // Real sandbox shape (observed live): flat, no `event`/`data` wrapper.
      // Keys are camelCase here: txRef, flwRef, plus "event.type" (dotted key).
      txRef?: string;
      tx_ref?: string;
      flwRef?: string;
      id?: number;
      status?: string;
    };
    if (p.event) return this.normalizeDocumentedShape(p, payload);
    // Flat sandbox charge shape: top-level txRef identifies the payment.
    const txRef = p.txRef ?? p.tx_ref;
    if (txRef) {
      const ok = (p.status ?? "").toLowerCase() === "successful";
      return {
        type: ok ? "payment.succeeded" : "payment.failed",
        provider: "flutterwave",
        providerEventId: p.flwRef ?? (p.id !== undefined ? String(p.id) : undefined),
        reference: txRef,
        raw: payload,
      };
    }
    return null;
  }

  /** Documented `{event, data}` envelope shape. Unchanged behavior. */
  private normalizeDocumentedShape(
    p: { event?: string; data?: { id?: number; tx_ref?: string; reference?: string; status?: string } },
    payload: unknown,
  ): OpenPayEvent | null {
    if (p.event === "charge.completed") {
      const ok = (p.data?.status ?? "").toLowerCase() === "successful";
      return {
        type: ok ? "payment.succeeded" : "payment.failed",
        provider: "flutterwave",
        providerEventId: p.data?.id ? String(p.data.id) : undefined,
        reference: p.data?.tx_ref ?? p.data?.reference,
        raw: payload,
      };
    }
    if (p.event === "transfer.completed") {
      const ok = ["successful", "success"].includes((p.data?.status ?? "").toLowerCase());
      return {
        type: ok ? "transfer.succeeded" : "transfer.failed",
        provider: "flutterwave",
        providerEventId: p.data?.id ? String(p.data.id) : undefined,
        reference: p.data?.reference ?? p.data?.tx_ref,
        raw: payload,
      };
    }
    return { type: "unknown", provider: "flutterwave", raw: payload };
  }
}
