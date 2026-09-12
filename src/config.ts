import { BachsConnector } from "./connectors/bachs.js";
import { FlutterwaveConnector } from "./connectors/flutterwave.js";
import { PaystackConnector } from "./connectors/paystack.js";
import type { HttpClient, ProviderConnector } from "./connectors/types.js";
import { ConfigurationError } from "./core/errors.js";
import type { ProviderName } from "./core/types.js";
import { getDb } from "./db/client.js";
import { DrizzlePersistence, MemoryPersistence, type Persistence } from "./db/store.js";

export interface ProviderConf {
  secretKey?: string;
  baseUrl?: string;
  webhookSecret?: string;
  webhookSecretHash?: string;
  http?: HttpClient;
  timeoutMs?: number;
}

export interface OpenPayConfig {
  defaultProvider?: ProviderName;
  paystack?: ProviderConf;
  flutterwave?: ProviderConf;
  bachs?: ProviderConf;
  /**
   * Shorthand for single-provider setups. Equivalent to setting
   * `defaultProvider` plus `{ secretKey }` on that provider's block;
   * an explicit per-provider block always wins.
   *
   *   new OpenPay({ provider: "paystack", secretKey: process.env.PAYSTACK_SECRET_KEY })
   */
  provider?: ProviderName;
  secretKey?: string;
  /** Pass DATABASE_URL to enable Postgres persistence; omit for stateless/memory. */
  databaseUrl?: string;
  persistence?: Persistence;
  http?: HttpClient;
  timeoutMs?: number;
}

export interface ResolvedContext {
  connectors: Record<ProviderName, ProviderConnector>;
  defaultProvider: ProviderName;
  persistence?: Persistence;
}

/** Env lookup that treats empty strings as unset (common in half-filled .env files). */
function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

export function resolveContext(cfg: OpenPayConfig = {}): ResolvedContext {
  const defaultProvider = cfg.provider ?? cfg.defaultProvider ?? "paystack";
  const connectors = {} as Record<ProviderName, ProviderConnector>;

  // Shorthand secret applies to the resolved default provider only, and loses
  // to an explicit per-provider secretKey.
  const shorthandKeyFor = (name: ProviderName): string | undefined =>
    name === defaultProvider ? cfg.secretKey : undefined;

  const paystackKey = cfg.paystack?.secretKey || shorthandKeyFor("paystack") || env("PAYSTACK_SECRET_KEY");
  const flwKey = cfg.flutterwave?.secretKey || shorthandKeyFor("flutterwave") || env("FLUTTERWAVE_SECRET_KEY");
  const bachsKey = cfg.bachs?.secretKey || shorthandKeyFor("bachs") || env("BACHS_SECRET_KEY");

  if (paystackKey) {
    connectors.paystack = new PaystackConnector({
      secretKey: paystackKey,
      baseUrl: cfg.paystack?.baseUrl,
      webhookSecret: cfg.paystack?.webhookSecret || env("PAYSTACK_WEBHOOK_SECRET"),
      http: cfg.paystack?.http ?? cfg.http,
      timeoutMs: cfg.paystack?.timeoutMs ?? cfg.timeoutMs,
    });
  }
  if (flwKey) {
    connectors.flutterwave = new FlutterwaveConnector({
      secretKey: flwKey,
      baseUrl: cfg.flutterwave?.baseUrl,
      webhookSecretHash:
        cfg.flutterwave?.webhookSecretHash || env("FLUTTERWAVE_WEBHOOK_SECRET_HASH"),
      http: cfg.flutterwave?.http ?? cfg.http,
      timeoutMs: cfg.flutterwave?.timeoutMs ?? cfg.timeoutMs,
    });
  }
  if (bachsKey) {
    connectors.bachs = new BachsConnector({
      secretKey: bachsKey,
      baseUrl: cfg.bachs?.baseUrl,
      webhookSecret: cfg.bachs?.webhookSecret || env("BACHS_WEBHOOK_SECRET"),
      http: cfg.bachs?.http ?? cfg.http,
      timeoutMs: cfg.bachs?.timeoutMs ?? cfg.timeoutMs,
    });
  }

  if (!connectors[defaultProvider]) {
    const available = (Object.keys(connectors) as ProviderName[]).join(", ") || "none";
    throw new ConfigurationError(
      `Default provider '${defaultProvider}' is not configured (available: ${available}). ` +
        `Set ${defaultProvider.toUpperCase()}_SECRET_KEY or pass explicit keys.`,
    );
  }
  // Fill missing connectors lazily? No — fail fast only for the default.
  // Accessing an unconfigured provider later throws ConfigurationError.

  let persistence = cfg.persistence;
  const dbUrl = cfg.databaseUrl ?? process.env.DATABASE_URL;
  if (!persistence && dbUrl) {
    try {
      persistence = new DrizzlePersistence(getDb(dbUrl));
    } catch {
      persistence = new MemoryPersistence();
    }
  }

  // Proxy missing connectors so errors stay typed at call time.
  const handler: ProxyHandler<Record<string, ProviderConnector>> = {
    get(target, prop: string) {
      const v = (target as Record<string, ProviderConnector>)[prop];
      if (v) return v;
      if (prop === "then") return undefined;
      throw new ConfigurationError(
        `Provider '${prop}' is not configured. Set its secret key first.`,
      );
    },
  };
  const proxied = new Proxy(connectors as Record<string, ProviderConnector>, handler) as unknown as Record<
    ProviderName,
    ProviderConnector
  >;

  return { connectors: proxied, defaultProvider, persistence };
}
