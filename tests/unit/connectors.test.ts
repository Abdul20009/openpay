import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BachsConnector } from "../../src/connectors/bachs.js";
import { FlutterwaveConnector } from "../../src/connectors/flutterwave.js";
import { PaystackConnector } from "../../src/connectors/paystack.js";
import type { HttpClient } from "../../src/connectors/types.js";
import { CapabilityError, UnknownResultError, ValidationError } from "../../src/core/errors.js";
import { normalizeAmount, toMinorUnits } from "../../src/core/validation.js";
import { createPayment } from "../../src/connectors/service.js";
import { MemoryPersistence } from "../../src/db/store.js";

function mockJson(data: unknown, status = 200): HttpClient {
  return async () => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

describe("money helpers (Bachs-style decimal strings)", () => {
  it("normalizes amounts to 2 decimals", () => {
    expect(normalizeAmount("5000")).toBe("5000.00");
    expect(normalizeAmount("5000.5")).toBe("5000.50");
    expect(normalizeAmount("5000.00")).toBe("5000.00");
  });

  it("converts to Paystack kobo with integer math", () => {
    expect(toMinorUnits("5000.00")).toBe(500000);
    expect(toMinorUnits("99.99")).toBe(9999);
  });
});

describe("paystack connector", () => {
  it("creates a payment (pending + checkout url)", async () => {
    const c = new PaystackConnector({
      secretKey: "sk_test_x",
      http: mockJson({ status: true, data: { authorization_url: "https://pay", access_code: "a", reference: "ref_1" } }),
    });
    const p = await c.createPayment({
      amount: "5000.00",
      currency: "NGN",
      customer: { email: "a@b.com" },
      reference: "ref_1",
    });
    expect(p.status).toBe("pending");
    expect(p.checkoutUrl).toBe("https://pay");
    expect(p.providerRef).toBe("ref_1");
  });

  it("verifies success/failed/unknown distinctly", async () => {
    const verify = (status: string) =>
      new PaystackConnector({
        secretKey: "sk_test_x",
        http: mockJson({ data: { reference: "r", amount: 500000, currency: "NGN", status } }),
      }).verifyPayment({ reference: "r" });
    expect((await verify("success")).status).toBe("successful");
    expect((await verify("failed")).status).toBe("failed");
    expect((await verify("abandoned")).status).toBe("failed");
    expect((await verify("ongoing")).status).toBe("pending");
    expect((await verify("weird-status")).status).toBe("unknown");
  });

  it("verifies webhook HMAC-SHA512 and normalizes charge.success", async () => {
    const c = new PaystackConnector({ secretKey: "wh_sec" });
    const raw = JSON.stringify({ event: "charge.success", data: { reference: "ref_1", id: 1 } });
    const sig = createHmac("sha512", "wh_sec").update(raw).digest("hex");
    expect(c.verifyWebhookSignature(raw, { "x-paystack-signature": sig })).toBe(true);
    expect(c.verifyWebhookSignature(raw, { "x-paystack-signature": "bad" })).toBe(false);
    const evt = c.normalizeWebhook(JSON.parse(raw));
    expect(evt?.type).toBe("payment.succeeded");
    expect(evt?.reference).toBe("ref_1");
  });

  it("maps timeouts to unknown (never auto-fail)", async () => {
    const hanging: HttpClient = async (_u, init) => {
      await new Promise((_res, rej) => {
        const sig = init?.signal as AbortSignal | undefined;
        sig?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
      throw new Error("unreachable");
    };
    const c = new PaystackConnector({ secretKey: "sk_test_x", http: hanging, timeoutMs: 20 });
    await expect(c.createPayment({ amount: "1.00", currency: "NGN", customer: { email: "a@b.com" }, reference: "r" })).rejects.toBeInstanceOf(
      UnknownResultError,
    );
  });
});

describe("flutterwave connector", () => {
  it("creates + verifies via tx_ref", async () => {
    const fw = new FlutterwaveConnector({
      secretKey: "FLWSECK_TEST",
      http: mockJson({ data: { link: "https://fw/pay", flw_ref: "FLW1" } }),
    });
    const p = await fw.createPayment({ amount: "5000.00", currency: "NGN", customer: { email: "a@b.com" }, reference: "tx1", redirectUrl: "https://example.com/callback" });
    expect(p.checkoutUrl).toBe("https://fw/pay");
    expect(p.status).toBe("pending");

    const fw2 = new FlutterwaveConnector({
      secretKey: "FLWSECK_TEST",
      http: mockJson({ data: { id: 7, tx_ref: "tx1", flw_ref: "FLW1", amount: 5000, currency: "NGN", status: "successful" } }),
    });
    expect((await fw2.verifyPayment({ reference: "tx1" })).status).toBe("successful");
  });

  it("requires redirectUrl for create (live sandbox rejects without it)", async () => {
    let called = false;
    const fw = new FlutterwaveConnector({
      secretKey: "FLWSECK_TEST",
      http: (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as never,
    });
    await expect(
      fw.createPayment({ amount: "5000.00", currency: "NGN", customer: { email: "a@b.com" }, reference: "tx_noredirect" }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(called).toBe(false);
  });

  it("normalizes charge.completed webhooks", () => {
    const fw = new FlutterwaveConnector({ secretKey: "s" });
    expect(fw.verifyWebhookSignature("{}", { "verif-hash": "s" })).toBe(true);
    const evt = fw.normalizeWebhook({ event: "charge.completed", data: { id: 1, tx_ref: "tx1", status: "successful" } });
    expect(evt?.type).toBe("payment.succeeded");
  });

  it("normalizes the real flat sandbox shape (no event/data envelope)", () => {
    // Sanitized capture from a live sandbox delivery: customer/card/entity
    // fields removed; only mapping-relevant fields kept.
    const fw = new FlutterwaveConnector({ secretKey: "s" });
    const evt = fw.normalizeWebhook({
      id: 10484949,
      txRef: "fwm3_mtxc7dza",
      flwRef: "FLW-MOCK-4192c7a16c1a52c133400dc1ee330217",
      status: "successful",
      currency: "NGN",
      amount: 100,
      "event.type": "CARD_TRANSACTION",
    });
    expect(evt?.type).toBe("payment.succeeded");
    expect(evt?.provider).toBe("flutterwave");
    expect(evt?.reference).toBe("fwm3_mtxc7dza");
    expect(evt?.providerEventId).toBe("FLW-MOCK-4192c7a16c1a52c133400dc1ee330217");
  });

  it("maps non-successful flat sandbox payloads to payment.failed", () => {
    const fw = new FlutterwaveConnector({ secretKey: "s" });
    const evt = fw.normalizeWebhook({ id: 9, txRef: "txf", status: "failed", currency: "NGN" });
    expect(evt?.type).toBe("payment.failed");
    expect(evt?.reference).toBe("txf");
    expect(evt?.providerEventId).toBe("9");
  });
});

describe("bachs connector", () => {
  it("creates a checkout session (pending)", async () => {
    const b = new BachsConnector({
      secretKey: "sk_sandbox_x",
      http: mockJson({ checkout_id: "chk_1", checkout_url: "https://bachs/c/chk_1" }),
    });
    const p = await b.createPayment({ amount: "5000.00", currency: "NGN", customer: { email: "a@b.com" }, reference: "ord_1" });
    expect(p.providerRef).toBe("chk_1");
    expect(p.checkoutUrl).toBe("https://bachs/c/chk_1");
    expect(p.status).toBe("pending");
  });

  it("throws CapabilityError for refunds/transfers", async () => {
    const b = new BachsConnector({ secretKey: "sk_sandbox_x", http: mockJson({}) });
    await expect(b.createRefund({ paymentReference: "x", currency: "NGN" })).rejects.toBeInstanceOf(CapabilityError);
    await expect(b.createTransfer({ amount: "1.00", currency: "NGN", accountNumber: "1", bankCode: "044", reference: "r" })).rejects.toBeInstanceOf(
      CapabilityError,
    );
  });

  it("normalizes collection.succeeded", () => {
    const b = new BachsConnector({ secretKey: "sk_sandbox_x" });
    const evt = b.normalizeWebhook({ type: "collection.succeeded", data: { checkout_id: "chk_1" } });
    expect(evt?.type).toBe("payment.succeeded");
    expect(evt?.reference).toBe("chk_1");
  });
});

describe("service idempotency (no duplicate charges)", () => {
  it("second create with same key returns cached payment without HTTP", async () => {
    let calls = 0;
    const http: HttpClient = async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ status: true, data: { authorization_url: "https://pay", access_code: "a", reference: "idem_1" } }),
        { status: 200 },
      );
    };
    const ctx = {
      connectors: { paystack: new PaystackConnector({ secretKey: "sk", http }) } as never,
      defaultProvider: "paystack" as const,
      persistence: new MemoryPersistence(),
    };
    const input = { amount: "10.00", currency: "NGN", customer: { email: "a@b.com" }, reference: "idem_1" };
    const first = await createPayment(ctx, input);
    const second = await createPayment(ctx, input);
    expect(calls).toBe(1);
    expect(second.reference).toBe(first.reference);
  });

  it("rejects bad money with ValidationError", async () => {
    const ctx = {
      connectors: { paystack: new PaystackConnector({ secretKey: "sk", http: mockJson({}) }) } as never,
      defaultProvider: "paystack" as const,
    };
    await expect(createPayment(ctx, { amount: "-5", currency: "NGN", customer: { email: "a@b.com" } })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
