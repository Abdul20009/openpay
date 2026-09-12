import { ConfigurationError, ValidationError } from "../core/errors.js";
import { defaultIdempotencyKey, newReference } from "../core/idempotency.js";
import type {
  CreatePaymentInput,
  CreateRefundInput,
  CreateTransferInput,
  Payment,
  ProviderName,
  Refund,
  Transfer,
  VerifyPaymentInput,
} from "../core/types.js";
import {
  CreatePaymentSchema,
  CreateRefundSchema,
  CreateTransferSchema,
  normalizeAmount,
  VerifyPaymentSchema,
} from "../core/validation.js";
import type { Persistence } from "../db/store.js";
import type { ProviderConnector } from "./types.js";

export interface ServiceContext {
  connectors: Record<ProviderName, ProviderConnector>;
  defaultProvider: ProviderName;
  persistence?: Persistence;
}

function pickConnector(ctx: ServiceContext, provider?: ProviderName): ProviderConnector {
  const name = provider ?? ctx.defaultProvider;
  const c = ctx.connectors[name];
  if (!c) throw new ConfigurationError(`Provider '${name}' is not configured`);
  return c;
}

export async function createPayment(ctx: ServiceContext, input: CreatePaymentInput): Promise<Payment> {
  const parsed = CreatePaymentSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.message, parsed.error.flatten());
  const provider = parsed.data.provider ?? ctx.defaultProvider;
  const reference = parsed.data.reference ?? newReference("pay");
  const key = parsed.data.idempotencyKey ?? defaultIdempotencyKey("payments.create", provider, reference);

  if (ctx.persistence) {
    const cached = await ctx.persistence.findIdempotency<Payment>(key);
    if (cached) return cached;
  }
  const connector = pickConnector(ctx, provider);
  const payment = await connector.createPayment({
    amount: normalizeAmount(parsed.data.amount),
    currency: parsed.data.currency,
    customer: parsed.data.customer,
    provider,
    reference,
    idempotencyKey: key,
    redirectUrl: parsed.data.redirectUrl,
    metadata: parsed.data.metadata,
  });
  if (ctx.persistence) {
    await ctx.persistence.savePayment(payment);
    await ctx.persistence.saveIdempotency(key, "payments.create", provider, payment);
  }
  return payment;
}

export async function verifyPayment(ctx: ServiceContext, input: VerifyPaymentInput): Promise<Payment> {
  const parsed = VerifyPaymentSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.message);
  const connector = pickConnector(ctx, parsed.data.provider);
  const payment = await connector.verifyPayment({ reference: parsed.data.reference, provider: connector.name });
  if (ctx.persistence) await ctx.persistence.savePayment(payment);
  return payment;
}

export async function createTransfer(ctx: ServiceContext, input: CreateTransferInput): Promise<Transfer> {
  const parsed = CreateTransferSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.message, parsed.error.flatten());
  const provider = parsed.data.provider ?? ctx.defaultProvider;
  const reference = parsed.data.reference ?? newReference("trf");
  const key = parsed.data.idempotencyKey ?? defaultIdempotencyKey("transfers.create", provider, reference);
  if (ctx.persistence) {
    const cached = await ctx.persistence.findIdempotency<Transfer>(key);
    if (cached) return cached;
  }
  const connector = pickConnector(ctx, provider);
  const transfer = await connector.createTransfer({
    amount: normalizeAmount(parsed.data.amount),
    currency: parsed.data.currency,
    accountNumber: parsed.data.accountNumber,
    bankCode: parsed.data.bankCode,
    accountName: parsed.data.accountName,
    narration: parsed.data.narration,
    provider,
    reference,
    idempotencyKey: key,
    metadata: parsed.data.metadata,
  });
  if (ctx.persistence) {
    await ctx.persistence.saveTransfer(transfer);
    await ctx.persistence.saveIdempotency(key, "transfers.create", provider, transfer);
  }
  return transfer;
}

export async function createRefund(ctx: ServiceContext, input: CreateRefundInput): Promise<Refund> {
  const parsed = CreateRefundSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.message, parsed.error.flatten());
  const provider = parsed.data.provider ?? ctx.defaultProvider;
  const key =
    parsed.data.idempotencyKey ??
    defaultIdempotencyKey("refunds.create", provider, `${parsed.data.paymentReference}:${parsed.data.amount ?? "full"}`);
  if (ctx.persistence) {
    const cached = await ctx.persistence.findIdempotency<Refund>(key);
    if (cached) return cached;
  }
  const connector = pickConnector(ctx, provider);
  const refund = await connector.createRefund({
    paymentReference: parsed.data.paymentReference,
    amount: parsed.data.amount ? normalizeAmount(parsed.data.amount) : undefined,
    currency: parsed.data.currency,
    reason: parsed.data.reason,
    provider,
    idempotencyKey: key,
  });
  if (ctx.persistence) {
    await ctx.persistence.saveRefund(refund);
    await ctx.persistence.saveIdempotency(key, "refunds.create", provider, refund);
  }
  return refund;
}
