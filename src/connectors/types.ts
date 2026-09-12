import type {
  CreatePaymentInput,
  CreateRefundInput,
  CreateTransferInput,
  OpenPayEvent,
  Payment,
  ProviderCapabilities,
  ProviderName,
  Refund,
  Transfer,
  VerifyPaymentInput,
  WebhookHeaders,
} from "../core/types.js";

/** Minimal fetch-compatible HTTP client (injectable for tests). */
export type HttpClient = (url: string, init: RequestInit) => Promise<Response>;

export interface ConnectorConfig {
  secretKey: string;
  /** Override base URL (tests, sandbox vs live). */
  baseUrl?: string;
  timeoutMs?: number;
  http?: HttpClient;
}

export interface CreatePaymentResult {
  payment: Payment;
}

export interface ProviderConnector {
  readonly name: ProviderName;
  readonly capabilities: ProviderCapabilities;

  createPayment(input: CreatePaymentInput & { reference: string }): Promise<Payment>;
  verifyPayment(input: VerifyPaymentInput): Promise<Payment>;

  /** Throw CapabilityError when unsupported. */
  createRefund(input: CreateRefundInput): Promise<Refund>;
  createTransfer(input: CreateTransferInput & { reference: string }): Promise<Transfer>;
  verifyTransfer(reference: string): Promise<Transfer>;

  verifyWebhookSignature(rawBody: string | Buffer, headers: WebhookHeaders): boolean;
  normalizeWebhook(payload: unknown): OpenPayEvent | null;
}
