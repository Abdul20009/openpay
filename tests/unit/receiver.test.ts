import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryPersistence } from "../../src/db/store.js";
import { OpenPay } from "../../src/index.js";
import { createWebhookServer } from "../../src/server.js";
import type { Server } from "node:http";

const SECRET = "wh_test_secret";

let server: Server;
let base = "";
let mem: MemoryPersistence;

function sign(raw: string): string {
  return createHmac("sha512", SECRET).update(raw).digest("hex");
}

async function post(path: string, raw: string, sig?: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sig !== undefined ? { "x-paystack-signature": sig } : {}),
    },
    body: raw,
  });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  mem = new MemoryPersistence();
  const openpay = new OpenPay({
    defaultProvider: "paystack",
    paystack: { secretKey: SECRET },
    persistence: mem,
  });
  server = createWebhookServer(openpay);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
});

describe("webhook receiver", () => {
  it("accepts a valid signature and normalizes the event", async () => {
    const raw = JSON.stringify({ event: "charge.success", data: { reference: "recv_1", id: 111 } });
    const { status, body } = await post("/webhooks/paystack", raw, sign(raw));
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, type: "payment.succeeded", reference: "recv_1" });
    expect(mem.webhookRows).toHaveLength(1);
  });

  it("rejects an invalid signature with 401 and persists nothing", async () => {
    const before = mem.webhookRows.length;
    const raw = JSON.stringify({ event: "charge.success", data: { reference: "recv_bad", id: 112 } });
    const { status, body } = await post("/webhooks/paystack", raw, "deadbeef");
    expect(status).toBe(401);
    expect(body).toMatchObject({ ok: false, error: "invalid_signature" });
    expect(mem.webhookRows).toHaveLength(before);
  });

  it("rejects a missing signature with 401", async () => {
    const raw = JSON.stringify({ event: "charge.success", data: { reference: "recv_nosig", id: 113 } });
    const { status } = await post("/webhooks/paystack", raw);
    expect(status).toBe(401);
  });

  it("rejects a malformed payload with 400", async () => {
    const raw = "{not-json";
    const { status, body } = await post("/webhooks/paystack", raw, sign(raw));
    expect(status).toBe(400);
    expect(body).toMatchObject({ ok: false, error: "malformed_payload" });
  });

  it("collapses duplicate deliveries into one persisted row", async () => {
    const before = mem.webhookRows.length;
    const raw = JSON.stringify({ event: "charge.success", data: { reference: "recv_dupe", id: 999 } });
    const first = await post("/webhooks/paystack", raw, sign(raw));
    const second = await post("/webhooks/paystack", raw, sign(raw));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ ok: true, deduped: true });
    expect(mem.webhookRows).toHaveLength(before + 1);
  });

  it("acknowledges unknown event types without failing", async () => {
    const raw = JSON.stringify({ event: "something.new", data: { reference: "recv_unk" } });
    const { status, body } = await post("/webhooks/paystack", raw, sign(raw));
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, ignored: true });
  });

  it("returns 404 for unknown paths and answers health checks", async () => {
    const missing = await fetch(`${base}/nope`);
    expect(missing.status).toBe(404);
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
  });
});
