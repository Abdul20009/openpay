OpenPay NG — V1
A small, open-source unified SDK for Nigerian payment providers
1. The Idea
OpenPay NG V1 is not a replacement for Paystack, Flutterwave, or Bachs. It is a developer-friendly abstraction
layer that gives developers one consistent interface for common payment operations while OpenPay handles
provider-specific differences underneath.
2. V1 Goal
Keep it small. The first release should prove that developers can integrate multiple Nigerian payment providers
without learning a completely different API for each one.
3. Initial Providers
Provider V1 role
Paystack Payment, verification, refunds, transfers
Flutterwave Payment, verification, refunds, transfers
Bachs Payment-related integration where the provider API supports the operation
Provider capabilities must be verified against each provider's current API documentation before implementation.
OpenPay should never pretend that providers support identical features.
4. V1 Features
• Create payment
• Retrieve / verify payment
• Refund payment
• Create transfer
• Retrieve transfer
• Normalize provider webhooks into OpenPay events
5. Example Developer Experience
const payment = await openpay.payments.create({
amount: 5000,
currency: "NGN",
customer: { email: "customer@example.com" }
});
The application uses OpenPay's common interface instead of writing provider-specific payment logic everywhere.
6. Simple Architecture
Application — Developer's app
OpenPay SDK — Common developer interface
OpenPay Core — Validation, common models, provider selection and error handling
Provider Connectors — Paystack / Flutterwave / Bachs-specific API implementations
Provider APIs — Actual payment providers
7. Important Reliability Rules
• Idempotency: repeated requests must not accidentally create duplicate charges.
• Payment states: distinguish pending, successful, failed, and unknown outcomes.
• Unknown is not failed: if a provider times out, verify the transaction before retrying.
• Webhooks: validate and normalize provider events.
• No raw card storage in V1: use provider-hosted/tokenized payment flows where possible.
8. V1 Technology Direction
Area V1 direction
Core TypeScript + Node.js
Database PostgreSQL
Cache / coordination Redis only where genuinely needed
Deployment Docker-friendly
SDK Start with TypeScript as the first SDK; add other languages after real
demand
Architecture Provider adapter / connector pattern
The technology direction is deliberately simple. TypeScript + Node.js is the V1 core, PostgreSQL is the primary
database, and Redis should only be introduced when a real V1 requirement justifies it. The architecture should
remain easy for contributors to understand and maintain.
9. What V1 Will NOT Include
• AI-powered routing
• Complex automatic failover
• Card vaulting / raw card storage
• A hosted SaaS dashboard
• Dozens of payment providers
• Kubernetes or microservice-heavy infrastructure
• Multiple SDK languages on day one
10. Success Criteria
V1 is successful if real developers can install it, connect at least two providers, create and verify a payment,
receive a normalized webhook, and understand the project from its documentation without needing to understand
the internal implementation of every provider.
11. The Bigger Vision
If V1 gets genuine adoption, OpenPay can grow into a broader African payment orchestration platform. Routing,
provider health, additional African payment providers, more SDKs, hosted services and advanced observability
should be driven by real user demand rather than built upfront.
Principle: Build the smallest useful version first. Let developers tell us what OpenPay should become.