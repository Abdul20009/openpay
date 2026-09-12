/**
 * Thin local webhook receiver for OpenPay NG (V1).
 *
 * This is intentionally dependency-free (Node built-in `http` only).
 * All verification / normalization / persistence logic lives in the SDK —
 * this server only transports the RAW body + headers into:
 *   openpay.webhooks.normalizeDetailed(provider, rawBody, headers)
 *
 * Raw body preservation is critical: Paystack's HMAC-SHA512 signature is
 * computed over the exact request bytes, so no JSON parsing happens first.
 * (Flutterwave compares the `verif-hash` header instead, but the transport
 * stays identical.)
 */
import 'dotenv/config';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebhookVerificationError } from './core/errors.js';
import type { ProviderName } from './core/types.js';
import { OpenPay } from './sdk.js';

const MAX_BODY_BYTES = 1_000_000; // 1 MB — Paystack events are a few KB

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error('body_too_large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** First value wins; Node lowercases header names. */
function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Shared raw-body -> normalizeDetailed -> status mapping used by every
 * provider route. Behavior is identical for all providers; only the
 * provider name and signature header differ per route.
 */
async function handleProviderWebhook(
  openpay: OpenPay,
  provider: ProviderName,
  raw: Buffer,
  headers: Record<string, string | undefined>,
  res: ServerResponse,
): Promise<void> {
  try {
    const { event, duplicate } = await openpay.webhooks.normalizeDetailed(provider, raw, headers);
    if (!event) {
      sendJson(res, 400, { ok: false, error: 'malformed_payload' });
      return;
    }
    if (duplicate) {
      sendJson(res, 200, { ok: true, deduped: true, type: event.type, reference: event.reference });
      return;
    }
    if (event.type === 'unknown') {
      // Valid signature, unrecognized event: acknowledge so the provider doesn't retry forever.
      sendJson(res, 200, { ok: true, ignored: true, reference: event.reference });
      return;
    }
    sendJson(res, 200, { ok: true, type: event.type, reference: event.reference });
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      sendJson(res, 401, { ok: false, error: 'invalid_signature' });
      return;
    }
    throw err; // -> 500 via outer catch
  }
}

const PROVIDER_ROUTES: Record<string, ProviderName> = {
  '/webhooks/paystack': 'paystack',
  '/webhooks/flutterwave': 'flutterwave',
};

/** Signature headers per provider (values extracted from the raw request). */
function signatureHeaders(provider: ProviderName, req: IncomingMessage): Record<string, string | undefined> {
  if (provider === 'flutterwave') return { 'verif-hash': header(req, 'verif-hash') };
  return { 'x-paystack-signature': header(req, 'x-paystack-signature') };
}

export function createWebhookServer(openpay: OpenPay): Server {
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      // Genuine processing failure (e.g. DB down) -> 500 so the provider retries.
      console.error(`webhook error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'processing_failed' });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    console.log(`${req.method} ${url.pathname}`);

    if (req.method === 'GET' && url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }
    const provider = PROVIDER_ROUTES[url.pathname];
    if (!provider) {
      sendJson(res, 404, { ok: false, error: 'not_found' });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }

    let raw: Buffer;
    try {
      raw = await readRawBody(req);
    } catch {
      sendJson(res, 413, { ok: false, error: 'body_too_large' });
      return;
    }

    await handleProviderWebhook(openpay, provider, raw, signatureHeaders(provider, req), res);
  }

  return server;
}

// Runnable CLI: `npm run receiver`. Import-safe (tests import the factory only).
const argv1 = process.argv[1];
if (argv1 && import.meta.url === pathToFileURL(argv1).href) {
  const port = Number(process.env.PORT ?? 3000);
  const defaultProvider = (process.env.OPENPAY_DEFAULT_PROVIDER as ProviderName | undefined) ?? 'paystack';
  // Keys + DATABASE_URL resolve from env inside OpenPay; missing keys throw ConfigurationError.
  const openpay = new OpenPay({ defaultProvider });
  if (!process.env.DATABASE_URL) {
    console.warn('WARNING: DATABASE_URL not set — webhooks will verify/normalize but NOT persist.');
  }
  createWebhookServer(openpay).listen(port, () => {
    console.log(`OpenPay webhook receiver listening on http://localhost:${port}`);
    console.log('Paths: POST /webhooks/paystack, POST /webhooks/flutterwave');
  });
}
