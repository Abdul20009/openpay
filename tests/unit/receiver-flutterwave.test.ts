import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryPersistence } from "../../src/db/store.js";
import { OpenPay } from "../../src/index.js";
import { createWebhookServer } from "../../src/server.js";

// Offline only: the hash value here is a test fixture, never a real secret.
const HASH = "fw_test_hash";

let server: Server;
let base = "";
let mem: MemoryPersistence;

async function post(path: string, raw: string, hash?: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(hash !== undefined ? { "verif-hash": hash } : {}),
    },
    body: raw,
  });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  mem = new MemoryPersistence();
  const openpay = new OpenPay({
    defaultProvider: "flutterwave",
    flutterwave: { secretKey: "FLWSECK_TEST", webhookSecretHash: HASH },
    persistence: mem,
  });
  server = createWebhookServer(openpay);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe("flutterwave webhook receiver", () => {
  it("accepts a valid verif-hash and normalizes charge.completed", async () => {
    const raw = JSON.stringify({ event: "charge.completed", data: { id: 21, tx_ref: "fw_recv_1", status: "successful" } });
    const { status, body } = await post("/webhooks/flutterwave", raw, HASH);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, type: "payment.succeeded", reference: "fw_recv_1" });
    expect(mem.webhookRows).toHaveLength(1);
  });

  it("rejects a wrong verif-hash with 401 and persists nothing", async () => {
    const before = mem.webhookRows.length;
    const raw = JSON.stringify({ event: "charge.completed", data: { id: 22, tx_ref: "fw_bad", status: "successful" } });
    const { status, body } = await post("/webhooks/flutterwave", raw, "wrong");
    expect(status).toBe(401);
    expect(body).toMatchObject({ ok: false, error: "invalid_signature" });
    expect(mem.webhookRows).toHaveLength(before);
  });

  it("rejects a missing verif-hash with 401", async () => {
    const raw = JSON.stringify({ event: "charge.completed", data: { id: 23, tx_ref: "fw_nosig", status: "successful" } });
    const { status } = await post("/webhooks/flutterwave", raw);
    expect(status).toBe(401);
  });

  it("rejects a malformed payload with 400 and ignores Paystack headers", async () => {
    // A Paystack signature header must NOT authenticate the Flutterwave route.
    const raw = "{not-json";
    const res = await fetch(`${base}/webhooks/flutterwave`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-paystack-signature": "anything" },
      body: raw,
    });
    expect(res.status).toBe(401);
    const malformed = await post("/webhooks/flutterwave", raw, HASH);
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({ ok: false, error: "malformed_payload" });
  });

  it("accepts the real flat sandbox shape through HTTP (regression: was 400)", async () => {
    // Sanitized live capture (customer/card/entity removed).
    const raw = JSON.stringify({
      id: 10484949,
      txRef: "fw_flat_1",
      flwRef: "FLW-MOCK-flat",
      status: "successful",
      currency: "NGN",
      amount: 100,
      "event.type": "CARD_TRANSACTION",
    });
    const { status, body } = await post("/webhooks/flutterwave", raw, HASH);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, type: "payment.succeeded", reference: "fw_flat_1" });
  });

  it("collapses duplicate deliveries into one persisted row", async () => {    const before = mem.webhookRows.length;
    const raw = JSON.stringify({ event: "charge.completed", data: { id: 24, tx_ref: "fw_dupe", status: "successful" } });
    const first = await post("/webhooks/flutterwave", raw, HASH);
    const second = await post("/webhooks/flutterwave", raw, HASH);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ ok: true, deduped: true });
    expect(mem.webhookRows).toHaveLength(before + 1);
  });
});
