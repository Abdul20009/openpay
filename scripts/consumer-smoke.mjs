// Consumer smoke test: proves the PACKED openpay-ng tarball is consumable.
// 1. builds, 2. packs to a temp dir, 3. installs into a temp consumer project,
// 4. exercises the public API with mocked HTTP, 5. type-checks a TS consumer.
// No network calls to providers. Temp dirs are cleaned up on success.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const NPM = "npm";
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: "pipe", encoding: "utf8", ...opts });
const runNpm = (args, opts = {}) =>
  run(NPM, args, { shell: process.platform === "win32", ...opts });

console.log("[1/5] building...");
runNpm(["run", "build"], { cwd: ROOT });

const packDir = mkdtempSync(join(tmpdir(), "openpay-pack-"));
console.log("[2/5] packing...");
const packOut = runNpm(["pack", "--pack-destination", packDir, "--silent"], { cwd: ROOT }).trim();
const tarball = join(packDir, packOut.split("\n").pop());
console.log("tarball:", tarball);

const consumerDir = mkdtempSync(join(tmpdir(), "openpay-consumer-"));
console.log("[3/5] installing into temp consumer:", consumerDir);
writeFileSync(join(consumerDir, "package.json"), JSON.stringify({ name: "smoke", type: "module" }));
runNpm(["install", "--no-audit", "--no-fund", "--silent", tarball], { cwd: consumerDir });

console.log("[4/5] runtime check (mocked provider HTTP)...");
writeFileSync(
  join(consumerDir, "smoke.mjs"),
  `const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push(String(url));
  const text = init?.body ? String(init.body) : "";
  if (String(url).includes("/transaction/initialize")) {
    return Response.json({ status: true, data: { authorization_url: "https://pay/checkout", access_code: "a", reference: JSON.parse(text).reference } });
  }
  if (String(url).includes("/transaction/verify/")) {
    return Response.json({ data: { reference: "smoke1", amount: 500000, currency: "NGN", status: "success", customer: { email: "c@example.com" } } });
  }
  if (String(url).includes("api.flutterwave.com/v3/payments")) {
    return Response.json({ status: "success", message: "Hosted Link", data: { link: "https://fw/checkout" } });
  }
  throw new Error("unexpected call " + url);
};
const { OpenPay, ValidationError, normalizeAmount } = await import("openpay-ng");
const assert = (c, m) => { if (!c) throw new Error("ASSERT: " + m); };
const openpay = new OpenPay({ provider: "paystack", secretKey: "sk_test_smoke" });
assert(openpay.configuredProviders().join() === "paystack", "configuredProviders");
const p = await openpay.payments.create({ amount: "5000.00", currency: "NGN", customer: { email: "c@example.com" }, reference: "smoke1" });
assert(p.status === "pending" && p.checkoutUrl === "https://pay/checkout", "create shape");
const v = await openpay.payments.verify({ reference: "smoke1" });
assert(v.status === "successful" && v.amount === "5000.00", "verify shape");
const raw = JSON.stringify({ event: "charge.success", data: { reference: "smoke1", id: 5 } });
const sig = (await import("node:crypto")).createHmac("sha512", "sk_test_smoke").update(raw).digest("hex");
const evt = await openpay.webhooks.normalize("paystack", raw, { "x-paystack-signature": sig });
assert(evt?.type === "payment.succeeded", "webhook normalize");
let threw = null;
try { await openpay.payments.create({ amount: "-1", currency: "NGN", customer: { email: "c@example.com" } }); }
catch (e) { threw = e; }
assert(threw instanceof ValidationError, "ValidationError exported & thrown");
assert(normalizeAmount("5") === "5.00", "normalizeAmount");
assert(calls.filter((u) => u.includes("/transaction/initialize")).length === 1, "single init call");
const openpayFw = new OpenPay({ provider: "flutterwave", secretKey: "FLWSECK_TEST" });
const fwp = await openpayFw.payments.create({ amount: "5000.00", currency: "NGN", customer: { email: "c@example.com" }, reference: "smoke_fw1", redirectUrl: "https://example.com/callback" });
assert(fwp.provider === "flutterwave" && fwp.status === "pending" && fwp.checkoutUrl === "https://fw/checkout", "flutterwave create shape");
console.log("RUNTIME OK");
`,
);
run(process.execPath, ["smoke.mjs"], { cwd: consumerDir, stdio: "inherit" });

console.log("[5/5] TypeScript consumer check...");
writeFileSync(
  join(consumerDir, "consumer-check.ts"),
  `import { OpenPay, type Payment, type OpenPayEvent, type OpenPayConfig, ValidationError } from "openpay-ng";
const config: OpenPayConfig = { provider: "paystack", secretKey: "x" };
const openpay = new OpenPay(config);
const status: Payment["status"] = "pending";
const _e: OpenPayEvent["type"] = "payment.succeeded";
async function go(): Promise<string> {
  const p = await openpay.payments.create({ amount: "1.00", currency: "NGN", customer: { email: "a@b.co" } });
  const v = await openpay.payments.verify({ reference: p.reference });
  if (!(v instanceof Object)) throw new ValidationError("unreachable");
  return v.checkoutUrl ?? status;
}
void go();
`,
);
const tsc = join(ROOT, "node_modules", "typescript", "bin", "tsc");
execFileSync(process.execPath, [tsc, "--strict", "--skipLibCheck", "--target", "es2022", "--module", "nodenext", "--moduleResolution", "nodenext", "--noEmit", "consumer-check.ts"], {
  cwd: consumerDir,
  stdio: "pipe",
  encoding: "utf8",
});
console.log("TYPES OK");

rmSync(packDir, { recursive: true, force: true });
rmSync(consumerDir, { recursive: true, force: true });
console.log("CONSUMER SMOKE TEST PASSED");
