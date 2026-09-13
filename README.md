# OpenPay NG

One consistent TypeScript interface for Nigerian payment providers. OpenPay is
a developer-friendly abstraction layer — not a replacement for Paystack,
Flutterwave, or Bachs. You write provider-agnostic payment code; OpenPay
handles provider-specific differences underneath.

> Sandbox-proven with Paystack and Flutterwave (create → checkout → verify →
> real webhook). Not production-hardened — see Current limitations.

## 1. Installation

Requires Node.js 20+.

```bash
npm install openpay-ng
```

PostgreSQL is optional but recommended: without `DATABASE_URL` the SDK runs
stateless (no idempotency cache, no webhook/event persistence).

## 2. Quick start

```ts
import { OpenPay } from "openpay-ng";

const openpay = new OpenPay({
  provider: "paystack",
  secretKey: process.env.PAYSTACK_SECRET_KEY!,
});

const payment = await openpay.payments.create({
  amount: "5000.00", // decimal string, never a float — see Idempotency/Money note
  currency: "NGN",
  customer: { email: "customer@example.com" },
});

console.log(payment.checkoutUrl); // send the customer here to pay
```

## 3. Configuration

Single-provider shorthand:

```ts
new OpenPay({ provider: "paystack", secretKey: "..." });
```

Multi-provider / explicit form (an explicit per-provider block always wins):

```ts
new OpenPay({
  defaultProvider: "paystack",
  paystack: { secretKey: "..." },
  flutterwave: { secretKey: "...", webhookSecretHash: "..." },
});
```

Keys resolve explicit-config → environment, so `PAYSTACK_SECRET_KEY`,
`FLUTTERWAVE_SECRET_KEY`, and `BACHS_SECRET_KEY` work with no config at all.
`openpay.configuredProviders()` lists what's actually wired up. Unconfigured
providers throw `ConfigurationError` only when used.

## 4. Creating a payment

```ts
const payment = await openpay.payments.create({
  amount: "5000.00",
  currency: "NGN",
  customer: { email: "customer@example.com", name: "Ada", phone: "0803..." },
  provider: "flutterwave", // optional: overrides the default provider
  reference: "order_123", // optional: your unique reference (generated if omitted)
  idempotencyKey: "…", // optional: defaults to operation+provider+reference
  redirectUrl: "https://yourapp.com/pay/callback", // REQUIRED by Flutterwave
  metadata: { plan: "pro" }, // optional string map
});
// payment: { id, provider, reference, providerRef, amount, currency,
//            status: "pending", checkoutUrl?, customerEmail?, raw? }
```

## 5. Verifying a payment

```ts
const verified = await openpay.payments.verify({ reference: payment.reference });
// or: openpay.payments.verify({ reference, provider: "flutterwave" });
// verified.status: "pending" | "successful" | "failed" | "unknown"
```

`unknown` is **not** `failed`: it means the outcome couldn't be determined
(e.g. provider timeout). Verify again before retrying — never treat it as a
failure. `payments.retrieve()` is an alias of `verify()`.

Note the two verify shapes in V1: `payments.verify({ reference, provider? })`
takes an input object, while `transfers.verify(reference, provider?)` takes
positional arguments. Both default to the configured default provider.

## 6. Webhooks

Point the provider dashboard at your receiver (`POST /webhooks/paystack`,
`POST /webhooks/flutterwave`), then feed the **raw** body plus headers into
the SDK — raw bytes matter because signature checks run over them:

```ts
// Express-style example (use a raw-body parser, not express.json()).
// Node/Express req.headers can be passed directly, including repeated headers.
app.post("/webhooks/paystack", async (req, res) => {
  const event = await openpay.webhooks.normalize("paystack", req.body, req.headers);
  // event: { type: "payment.succeeded" | …, provider, reference?, … } | null
  res.status(200).json({ ok: true });
});
```

`normalizeDetailed()` additionally reports `{ event, duplicate, projected }`
for retried deliveries. A dependency-free reference receiver ships with the
repo (`npm run receiver`, local dev only — not part of the published API).

Persistence-dependent webhook behavior requires `DATABASE_URL`. Without it
(stateless mode) webhooks still verify and normalize, but events are not
stored, retries are not deduplicated (`duplicate` is always false), and
payment rows are not projected. The same applies to idempotency below.

## 7. Idempotency

Repeated `payments.create()` calls with the same reference/idempotency key
return the cached result without a second provider charge. This requires
`DATABASE_URL` (first write wins); in stateless mode every call reaches the
provider. Webhook retries collapse via a unique `(provider, type, event)`
record — same requirement: without persistence there is no stored record to
deduplicate against.

Money is always a decimal string (`"5000.00"`, ISO-4217 currency). The
`normalizeAmount()` helper is exported for convenience.

## 8. Supported providers

| Provider | Create/verify | Webhooks | Notes |
|---|---|---|---|
| Paystack | ✅ sandbox-proven | ✅ sandbox-proven (HMAC-SHA512) | Full V1 surface incl. refunds/transfers (code; transfers/refunds not live-tested) |
| Flutterwave | ✅ sandbox-proven | ✅ sandbox-proven (`verif-hash`) | `redirectUrl` required on create; refunds need the numeric transaction id; refunds/transfers not live-tested |
| Bachs | checkout-session based | provisional | Implemented, **not live-tested**; refunds/transfers throw `CapabilityError` |

## 9. Normalized payment statuses

Every provider maps to `pending | successful | failed | unknown`. Timeouts and
unrecognized provider states map to `unknown`. Webhook events project onto
payment rows: `payment.succeeded → successful`, `payment.failed → failed`;
`payment.pending` and non-payment events never regress a stored status.
Projection requires persistence (see Webhooks above).

### References: `reference` vs `providerRef`

Every payment carries two identifiers. `reference` is yours (the merchant
reference you passed, or a generated one). `providerRef` is the provider's
own identifier for the same payment, and it differs per provider:

- Paystack: `providerRef` echoes your reference.
- Flutterwave: `providerRef` is the provider's `flw_ref` at creation (falls back to your `tx_ref`), then the numeric
  transaction id after verification.
- Bachs: `providerRef` is the `checkout_id`.

You need `providerRef` when correlating OpenPay records with provider
dashboard entries, and for provider-specific operations — e.g. Flutterwave
refunds address the numeric transaction id, so pass the `providerRef` you
received from `verify()` as `paymentReference`.

### Data stored in Postgres

Payment, transfer, refund, idempotency, and webhook rows persist the raw
provider responses (`jsonb`), which may include provider-returned customer
and payment metadata (e.g. customer email, card brand/last digits — never
full card numbers, which OpenPay never touches). This audit trail is what
powers idempotency, dedupe, and status projection. Storage only happens when
persistence is configured (`DATABASE_URL`); stateless mode stores nothing.
Apply your own retention and access policies to the database.

## 10. Environment variables

```env
DATABASE_URL=postgres://openpay:openpay@localhost:5432/openpay
PAYSTACK_SECRET_KEY=your_test_secret_key
FLUTTERWAVE_SECRET_KEY=your_test_secret_key
BACHS_SECRET_KEY=your_test_secret_key
PAYSTACK_WEBHOOK_SECRET=your_webhook_secret
FLUTTERWAVE_WEBHOOK_SECRET_HASH=your_webhook_secret
BACHS_WEBHOOK_SECRET=your_webhook_secret
OPENPAY_DEFAULT_PROVIDER=paystack
PORT=3000
```

## 11. Sandbox/testing

```bash
npm test            # mocked unit suite, no network
npm run build       # emits dist/
npm pack --dry-run  # inspect publish contents (never publishes)
npm run smoke:consumer  # builds, packs, installs into a temp project,
                        # exercises the public API + types with mocked HTTP
```

Live sandbox checks need real test keys and (for webhooks) a public tunnel,
e.g. `ngrok http 3000`, with the dashboard URL pointed at
`https://<tunnel-host>/webhooks/<provider>`. Never commit real keys.

## 12. Current limitations

- Sandbox-proven only (Paystack + Flutterwave payments/webhooks). **Not
  production readiness.**
- Bachs implemented but not live-tested; no refund/transfer support there.
- Flutterwave refunds/transfers implemented but not live-tested.
- Webhook events do not auto-create payment rows for unknown references.
- No routing/failover, card vaulting, dashboard, or multi-language SDKs (V1 scope).

## 13. Errors

All errors extend `OpenPayError` (with machine-readable `code`):

- `ValidationError` — bad input (e.g. non-decimal amount, Flutterwave create without `redirectUrl`)
- `ConfigurationError` — missing/unconfigured provider or keys
- `ProviderError` — the provider rejected the call (`status`, `retryable`, `raw` attached)
- `CapabilityError` — provider doesn't support the operation in V1
- `UnknownResultError` — ambiguous outcome; verify before retrying (`retryable: true`)
- `WebhookVerificationError` — signature/hash check failed
