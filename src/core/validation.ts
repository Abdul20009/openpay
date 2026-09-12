import { z } from "zod";

/** Decimal-string money, e.g. "5000.00". Up to 2 decimals, no floats. */
export const AmountSchema = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "amount must be a decimal string like \"5000.00\"")
  .refine((v) => Number(v) > 0, "amount must be greater than zero");

export const CurrencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, "currency must be a 3-letter ISO-4217 code like NGN")
  .default("NGN");

export const CustomerSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(200).optional(),
  phone: z.string().min(3).max(30).optional(),
});

export const ProviderSchema = z.enum(["paystack", "flutterwave", "bachs"]);

export const CreatePaymentSchema = z.object({
  amount: AmountSchema,
  currency: CurrencySchema,
  customer: CustomerSchema,
  provider: ProviderSchema.optional(),
  reference: z.string().min(3).max(128).optional(),
  idempotencyKey: z.string().min(8).max(256).optional(),
  redirectUrl: z.string().url().optional(),
  metadata: z.record(z.string()).optional(),
});

export const VerifyPaymentSchema = z.object({
  reference: z.string().min(1).max(256),
  provider: ProviderSchema.optional(),
});

export const CreateTransferSchema = z.object({
  amount: AmountSchema,
  currency: CurrencySchema,
  accountNumber: z.string().min(5).max(20),
  bankCode: z.string().min(2).max(12),
  accountName: z.string().min(1).max(200).optional(),
  narration: z.string().max(200).optional(),
  provider: ProviderSchema.optional(),
  reference: z.string().min(3).max(128).optional(),
  idempotencyKey: z.string().min(8).max(256).optional(),
  metadata: z.record(z.string()).optional(),
});

export const CreateRefundSchema = z.object({
  paymentReference: z.string().min(1).max(256),
  amount: AmountSchema.optional(),
  currency: CurrencySchema,
  reason: z.string().max(300).optional(),
  provider: ProviderSchema.optional(),
  idempotencyKey: z.string().min(8).max(256).optional(),
});

export function normalizeAmount(value: string): string {
  // Always store/compare with 2 decimals: "5000" -> "5000.00"
  const n = Number(value);
  return n.toFixed(2);
}

/** Convert "5000.00" NGN -> 500000 kobo (Paystack minor units). Integer math only. */
export function toMinorUnits(amount: string): number {
  const [whole = "0", frac = ""] = amount.split(".");
  const fracPadded = (frac + "00").slice(0, 2);
  return Number(whole) * 100 + Number(fracPadded);
}
