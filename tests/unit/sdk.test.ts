import { createHmac } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { describe, expect, it } from "vitest";
import { OpenPay } from "../../src/index.js";
import type { HttpClient } from "../../src/connectors/types.js";

function mockJson(data: unknown): HttpClient {
  return async () => new Response(JSON.stringify(data), { status: 200 });
}

describe("OpenPay SDK", () => {
  it("exposes the V1 developer experience: payments.create across providers", async () => {
    const openpay = new OpenPay({
      defaultProvider: "paystack",
      paystack: {
        secretKey: "sk_test_ps",
        http: mockJson({ status: true, data: { authorization_url: "https://pay", access_code: "a", reference: "sdk_1" } }),
      } as never,
      flutterwave: {
        secretKey: "FLWSECK_TEST",
        http: mockJson({ data: { link: "https://fw", flw_ref: "FLW1" } }),
      } as never,
      bachs: {
        secretKey: "sk_sandbox_x",
        http: mockJson({ checkout_id: "chk_1", checkout_url: "https://bachs/c" }),
      } as never,
    });

    const payment = await openpay.payments.create({
      amount: "5000.00",
      currency: "NGN",
      customer: { email: "customer@example.com" },
      reference: "sdk_1",
    });
    expect(payment.status).toBe("pending");
    expect(payment.checkoutUrl).toBeTruthy();

    const bachsPayment = await openpay.payments.create({
      amount: "5000.00",
      currency: "NGN",
      customer: { email: "customer@example.com" },
      provider: "bachs",
      reference: "sdk_bachs_1",
    });
    expect(bachsPayment.provider).toBe("bachs");
  });

  it("throws CapabilityError for Bachs refunds", async () => {
    const openpay = new OpenPay({
      defaultProvider: "bachs",
      bachs: { secretKey: "sk_sandbox_x", http: mockJson({}) } as never,
    });
    await expect(openpay.refunds.create({ paymentReference: "chk_1", currency: "NGN" })).rejects.toMatchObject({
      code: "capability_error",
    });
  });

  it("supports the { provider, secretKey } shorthand; explicit blocks win", async () => {    const openpay = new OpenPay({
      provider: "paystack",
      secretKey: "sk_test_short",
      paystack: {
        http: mockJson({ status: true, data: { authorization_url: "https://pay", access_code: "a", reference: "short_1" } }),
      } as never,
    });
    expect(openpay.configuredProviders()).toEqual(["paystack"]);
    const payment = await openpay.payments.create({
      amount: "5000.00",
      currency: "NGN",
      customer: { email: "customer@example.com" },
      reference: "short_1",
    });
    expect(payment.provider).toBe("paystack");
    expect(payment.checkoutUrl).toBe("https://pay");
  });

  it("accepts Node IncomingHttpHeaders directly (string[] values use first entry)", async () => {
    const openpay = new OpenPay({ provider: "paystack", secretKey: "sk_test_headers" });
    const raw = JSON.stringify({ event: "charge.success", data: { reference: "hdr_1", id: 1 } });
    const sig = createHmac("sha512", "sk_test_headers").update(raw).digest("hex");
    // IncomingHttpHeaders assignment is compile-checked by tsc: no cast needed.
    const headers: IncomingHttpHeaders = { "x-paystack-signature": [sig], "content-type": "application/json" };
    const evt = await openpay.webhooks.normalize("paystack", raw, headers);
    expect(evt?.type).toBe("payment.succeeded");
    expect(evt?.reference).toBe("hdr_1");
  });
});
