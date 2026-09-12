import { ConfigurationError, WebhookVerificationError } from "../core/errors.js";
import type { OpenPayEvent, PaymentStatus, ProviderName, WebhookHeaders } from "../core/types.js";
import type { Persistence } from "../db/store.js";
import type { ProviderConnector } from "../connectors/types.js";

export interface WebhookContext {
  connectors: Record<ProviderName, ProviderConnector>;
  persistence?: Persistence;
}

function pick(ctx: WebhookContext, provider: ProviderName): ProviderConnector {
  const c = ctx.connectors[provider];
  if (!c) throw new ConfigurationError(`Provider '${provider}' is not configured`);
  return c;
}

/** Verify signature, normalize to OpenPayEvent, persist. Throws WebhookVerificationError on bad signature. */
export async function handleWebhook(
  ctx: WebhookContext,
  provider: ProviderName,
  rawBody: string | Buffer,
  headers: WebhookHeaders,
): Promise<OpenPayEvent | null> {
  const { event } = await handleWebhookDetailed(ctx, provider, rawBody, headers);
  return event;
}

export interface WebhookResult {
  event: OpenPayEvent | null;
  /** True when this exact event was already recorded (retried delivery). */
  duplicate: boolean;
  /** True when a matching payment row's status was updated by this event. */
  projected: boolean;
}

/**
 * Project a normalized event onto its payment row (status-only, idempotent).
 * Only terminal payment-lifecycle events project:
 * - payment.succeeded -> successful
 * - payment.failed    -> failed
 * payment.pending is intentionally NOT projected: it carries no new information
 * for genuinely pending payments, and must never regress a successful/failed
 * row (e.g. Paystack refund.pending normalizes to payment.pending but describes
 * the refund, not the payment). transfer/refund/unknown events never project.
 */
function projectedStatus(event: OpenPayEvent): PaymentStatus | null {
  if (event.type === "payment.succeeded") return "successful";
  if (event.type === "payment.failed") return "failed";
  return null;
}

/** Same as handleWebhook, but also reports duplicate deliveries. */
export async function handleWebhookDetailed(
  ctx: WebhookContext,
  provider: ProviderName,
  rawBody: string | Buffer,
  headers: WebhookHeaders,
): Promise<WebhookResult> {
  const connector = pick(ctx, provider);
  const text = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  if (!connector.verifyWebhookSignature(rawBody, headers)) {
    throw new WebhookVerificationError(provider);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    return { event: null, duplicate: false, projected: false };
  }
  const event = connector.normalizeWebhook(payload);
  if (!event) return { event: null, duplicate: false, projected: false };
  if (ctx.persistence) {
    const inserted = await ctx.persistence.saveWebhookEvent(event, payload);
    if (!inserted) return { event, duplicate: true, projected: false };
    const status = projectedStatus(event);
    if (status !== null && event.reference !== undefined) {
      // Unknown references are safe: no row matches, nothing changes.
      const updated = await ctx.persistence.updatePaymentStatus(event.provider, event.reference, status);
      return { event, duplicate: false, projected: updated };
    }
    return { event, duplicate: false, projected: false };
  }
  return { event, duplicate: false, projected: false };
}
