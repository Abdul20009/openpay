# Capability matrix (V1 — verify against live docs before relying on this)

OpenPay never pretends providers are identical. Unsupported ops throw `CapabilityError`.

| Operation | Paystack | Flutterwave | Bachs |
|---|---|---|---|
| `payments.create` | ✅ `POST /transaction/initialize` → `authorization_url` | ✅ `POST /v3/payments` → `link` | ✅ `POST /v1/checkout-sessions` → `checkout_url` |
| `payments.verify` | ✅ `GET /transaction/verify/:reference` | ✅ `GET /transactions/verify_by_reference?tx_ref=` | ✅ `GET /v1/checkout-sessions/:id` (`payment_status`) |
| `refunds.create` | ✅ `POST /refund` | ✅ `POST /v3/transactions/:id/refund` | ❌ no API in V1 docs → `CapabilityError` |
| `transfers.create` | ✅ recipient + `POST /transfer` | ✅ `POST /v3/transfers` | ❌ no API in V1 docs → `CapabilityError` |
| `transfers.verify` | ✅ `GET /transfer/verify/:reference` | ✅ `GET /v3/transfers/:id` | ❌ → `CapabilityError` |
| webhooks | ✅ HMAC-SHA512 (`x-paystack-signature`) | ✅ `verif-hash` compare | ✅ provisional HMAC-SHA256 — confirm header with Bachs dashboard |

Status mapping: every provider maps to `pending | successful | failed | unknown`.
Timeouts / ambiguous responses → `unknown` (`UnknownResultError`), never auto-`failed`.
