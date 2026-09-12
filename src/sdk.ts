/**
 * OpenPay NG — public SDK entry.
 *
 * ```ts
 * const openpay = new OpenPay({ provider: "paystack", secretKey: "sk_test_..." });
 * const payment = await openpay.payments.create({
 *   amount: "5000.00",
 *   currency: "NGN",
 *   customer: { email: "customer@example.com" },
 * });
 * ```
 */
import { createPayment, createRefund, createTransfer, verifyPayment } from "./connectors/service.js";
import { resolveContext, type OpenPayConfig } from "./config.js";
import { CapabilityError } from "./core/errors.js";
import type {
  CreatePaymentInput,
  CreateRefundInput,
  CreateTransferInput,
  OpenPayEvent,
  Payment,
  ProviderName,
  Refund,
  Transfer,
  VerifyPaymentInput,
  WebhookHeaders,
} from "./core/types.js";
import { handleWebhook, handleWebhookDetailed, type WebhookResult } from "./webhooks/service.js";

export class OpenPay {
  private ctx: ReturnType<typeof resolveContext>;

  constructor(config: OpenPayConfig = {}) {
    this.ctx = resolveContext(config);
  }

  readonly payments = {
    create: (input: CreatePaymentInput): Promise<Payment> => createPayment(this.ctx, input),
    verify: (input: VerifyPaymentInput): Promise<Payment> => verifyPayment(this.ctx, input),
    retrieve: (input: VerifyPaymentInput): Promise<Payment> => verifyPayment(this.ctx, input),
  };

  readonly transfers = {
    create: (input: CreateTransferInput): Promise<Transfer> => createTransfer(this.ctx, input),
    verify: (reference: string, provider?: ProviderName): Promise<Transfer> => {
      const name = provider ?? this.ctx.defaultProvider;
      const c = this.ctx.connectors[name];
      if (!c.capabilities.transfers) throw new CapabilityError(name, "transfers");
      return c.verifyTransfer(reference);
    },
  };

  readonly refunds = {
    create: (input: CreateRefundInput): Promise<Refund> => createRefund(this.ctx, input),
  };

  readonly webhooks = {
    /** Verify + normalize a raw webhook body. Persists the event when persistence is enabled. */
    normalize: (
      provider: ProviderName,
      rawBody: string | Buffer,
      headers: WebhookHeaders,
    ): Promise<OpenPayEvent | null> => handleWebhook(this.ctx, provider, rawBody, headers),
    /** Same as normalize, but also reports retried (duplicate) deliveries. */
    normalizeDetailed: (
      provider: ProviderName,
      rawBody: string | Buffer,
      headers: WebhookHeaders,
    ): Promise<WebhookResult> => handleWebhookDetailed(this.ctx, provider, rawBody, headers),
  };

  /** Which providers are configured in this instance. */
  configuredProviders(): ProviderName[] {
    return (Object.keys(this.ctx.connectors) as ProviderName[]).filter((k) => {
      try {
        void this.ctx.connectors[k];
        return true;
      } catch {
        return false;
      }
    });
  }
}

export default OpenPay;
