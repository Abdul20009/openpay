import "dotenv/config";
import { OpenPay } from "../src/index.js";

/**
 * Minimal end-to-end example (sandbox keys required for live calls).
 * Run: npm run example
 */
async function main(): Promise<void> {
  const openpay = new OpenPay({
    defaultProvider: (process.env.OPENPAY_DEFAULT_PROVIDER as "paystack" | "flutterwave" | "bachs") ?? "paystack",
    // Dummy keys so the offline demo resolves without env. Real sandbox keys required for live calls.
    paystack: process.env.PAYSTACK_SECRET_KEY ? { secretKey: process.env.PAYSTACK_SECRET_KEY } : { secretKey: "sk_test_demo" },
  });

  console.log("Configured providers:", openpay.configuredProviders());

  // Create a payment with the common interface — no provider-specific code here.
  // Uncomment to hit a real sandbox:
  // const payment = await openpay.payments.create({
  //   amount: "5000.00",
  //   currency: "NGN",
  //   customer: { email: "customer@example.com" },
  // });
  // console.log("Payment:", payment.reference, payment.status, payment.checkoutUrl);
  // const verified = await openpay.payments.verify({ reference: payment.reference });
  // console.log("Verified:", verified.status);

  console.log("Example OK (no network call made — set sandbox keys and uncomment to go live).");
}

void main();
