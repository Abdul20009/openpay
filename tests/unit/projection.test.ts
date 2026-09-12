import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FlutterwaveConnector } from "../../src/connectors/flutterwave.js";
import { PaystackConnector } from "../../src/connectors/paystack.js";
import type { Payment } from "../../src/core/types.js";
import { MemoryPersistence } from "../../src/db/store.js";
import { handleWebhookDetailed, type WebhookContext } from "../../src/webhooks/service.js";

const SECRET = "proj_test_secret";

function ctx(mem: MemoryPersistence): WebhookContext {
  return {
    connectors: {
      paystack: new PaystackConnector({ secretKey: SECRET }),
    } as never,
    defaultProvider: "paystack" as never,
    persistence: mem,
  } as unknown as WebhookContext;
}

function signed(raw: string): Record<string, string> {
  return { "x-paystack-signature": createHmac("sha512", SECRET).update(raw).digest("hex") };
}

function pendingPayment(reference: string, providerRef = reference): Payment {
  return {
    id: `id-${reference}`,
    provider: "paystack",
    reference,
    providerRef,
    amount: "100.00",
    currency: "NGN",
    status: "pending",
    customerEmail: "smoke-test@example.com",
  };
}

describe("webhook-to-payment status projection", () => {
  it("payment.succeeded updates the payment row to successful", async () => {
    const mem = new MemoryPersistence();
    await mem.savePayment(pendingPayment("proj_ok"));
    const raw = JSON.stringify({ event: "charge.success", data: { reference: "proj_ok", id: 501 } });
    const res = await handleWebhookDetailed(ctx(mem), "paystack", raw, signed(raw));
    expect(res.event?.type).toBe("payment.succeeded");
    expect(res.duplicate).toBe(false);
    expect(res.projected).toBe(true);
    expect(mem.paymentRows.find((p) => p.reference === "proj_ok")?.status).toBe("successful");
  });

  it("failed events update the payment row to failed", async () => {
    const mem = new MemoryPersistence();
    await mem.savePayment(pendingPayment("proj_fail"));
    const raw = JSON.stringify({ event: "charge.failed", data: { reference: "proj_fail", id: 502 } });
    const res = await handleWebhookDetailed(ctx(mem), "paystack", raw, signed(raw));
    expect(res.event?.type).toBe("payment.failed");
    expect(res.projected).toBe(true);
    expect(mem.paymentRows.find((p) => p.reference === "proj_fail")?.status).toBe("failed");
  });

  it("matches on providerRef when it differs from reference (Bachs-style)", async () => {
    const mem = new MemoryPersistence();
    await mem.savePayment(pendingPayment("merchant_ref_1", "provider_ref_1"));
    const raw = JSON.stringify({ event: "charge.success", data: { reference: "provider_ref_1", id: 503 } });
    const res = await handleWebhookDetailed(ctx(mem), "paystack", raw, signed(raw));
    expect(res.projected).toBe(true);
    expect(mem.paymentRows.find((p) => p.reference === "merchant_ref_1")?.status).toBe("successful");
  });

  it("a webhook for an unknown reference is safe: event kept, nothing projected, no throw", async () => {
    const mem = new MemoryPersistence();
    const raw = JSON.stringify({ event: "charge.success", data: { reference: "ghost_ref", id: 504 } });
    const res = await handleWebhookDetailed(ctx(mem), "paystack", raw, signed(raw));
    expect(res.event?.type).toBe("payment.succeeded");
    expect(res.projected).toBe(false);
    expect(mem.paymentRows).toHaveLength(0);
    expect(mem.webhookRows).toHaveLength(1); // auditable event record preserved
  });

  it("payment.pending never regresses a successful row", async () => {
    const mem = new MemoryPersistence();
    await mem.savePayment({ ...pendingPayment("proj_noregress"), status: "successful" });
    // Paystack refund.pending normalizes to payment.pending for the same transaction.
    const raw = JSON.stringify({
      event: "refund.pending",
      data: { transaction_reference: "proj_noregress", refund_reference: "rf_1" },
    });
    const res = await handleWebhookDetailed(ctx(mem), "paystack", raw, signed(raw));
    expect(res.event?.type).toBe("payment.pending");
    expect(res.projected).toBe(false);
    expect(mem.paymentRows.find((p) => p.reference === "proj_noregress")?.status).toBe("successful");
  });

  it("duplicate webhook causes no duplicate side effects", async () => {
    const mem = new MemoryPersistence();
    await mem.savePayment(pendingPayment("proj_dupe"));
    const raw = JSON.stringify({ event: "charge.success", data: { reference: "proj_dupe", id: 505 } });
    const first = await handleWebhookDetailed(ctx(mem), "paystack", raw, signed(raw));
    const second = await handleWebhookDetailed(ctx(mem), "paystack", raw, signed(raw));
    expect(first.duplicate).toBe(false);
    expect(first.projected).toBe(true);
    expect(second.duplicate).toBe(true);
    expect(second.projected).toBe(false);
    expect(mem.webhookRows).toHaveLength(1);
    expect(mem.paymentRows.filter((p) => p.reference === "proj_dupe")).toHaveLength(1);
    expect(mem.paymentRows.find((p) => p.reference === "proj_dupe")?.status).toBe("successful");
  });

  it("non-payment events never touch payment rows", async () => {
    const mem = new MemoryPersistence();
    await mem.savePayment(pendingPayment("proj_transfer_ref"));
    const raw = JSON.stringify({ event: "transfer.success", data: { reference: "proj_transfer_ref", id: 506 } });
    const res = await handleWebhookDetailed(ctx(mem), "paystack", raw, signed(raw));
    expect(res.event?.type).toBe("transfer.succeeded");
    expect(res.projected).toBe(false);
    expect(mem.paymentRows.find((p) => p.reference === "proj_transfer_ref")?.status).toBe("pending");
  });
});

const FW_HASH = "proj_fw_hash";

function fwCtx(mem: MemoryPersistence): WebhookContext {
  return {
    connectors: {
      flutterwave: new FlutterwaveConnector({ secretKey: "FLWSECK_TEST", webhookSecretHash: FW_HASH }),
    } as never,
    defaultProvider: "flutterwave" as never,
    persistence: mem,
  } as unknown as WebhookContext;
}

describe("flutterwave tx_ref projection", () => {
  it("charge.completed projects onto the payment via tx_ref", async () => {
    const mem = new MemoryPersistence();
    await mem.savePayment({ ...pendingPayment("fw_tx_1"), provider: "flutterwave" });
    const raw = JSON.stringify({ event: "charge.completed", data: { id: 701, tx_ref: "fw_tx_1", status: "successful" } });
    const res = await handleWebhookDetailed(fwCtx(mem), "flutterwave", raw, { "verif-hash": FW_HASH });
    expect(res.event?.type).toBe("payment.succeeded");
    expect(res.event?.provider).toBe("flutterwave");
    expect(res.projected).toBe(true);
    expect(mem.paymentRows.find((p) => p.reference === "fw_tx_1")?.status).toBe("successful");
  });

  it("failed charge.completed projects to failed", async () => {
    const mem = new MemoryPersistence();
    await mem.savePayment({ ...pendingPayment("fw_tx_2"), provider: "flutterwave" });
    const raw = JSON.stringify({ event: "charge.completed", data: { id: 702, tx_ref: "fw_tx_2", status: "failed" } });
    const res = await handleWebhookDetailed(fwCtx(mem), "flutterwave", raw, { "verif-hash": FW_HASH });
    expect(res.event?.type).toBe("payment.failed");
    expect(res.projected).toBe(true);
    expect(mem.paymentRows.find((p) => p.reference === "fw_tx_2")?.status).toBe("failed");
  });

  it("unknown tx_ref is safe and duplicate delivery collapses", async () => {
    const mem = new MemoryPersistence();
    const raw = JSON.stringify({ event: "charge.completed", data: { id: 703, tx_ref: "fw_ghost", status: "successful" } });
    const first = await handleWebhookDetailed(fwCtx(mem), "flutterwave", raw, { "verif-hash": FW_HASH });
    const second = await handleWebhookDetailed(fwCtx(mem), "flutterwave", raw, { "verif-hash": FW_HASH });
    expect(first.projected).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(mem.paymentRows).toHaveLength(0);
    expect(mem.webhookRows).toHaveLength(1);
  });
});
