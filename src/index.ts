// Public API surface (V1). Intentionally small: the OpenPay class, config and
// domain types, catchable errors, and amount helpers. Connector classes,
// context resolution, and persistence implementations are internal — import
// them from their modules directly if you really need them.
export { OpenPay, default } from "./sdk.js";
export type { OpenPayConfig, ProviderConf } from "./config.js";
export * from "./core/types.js";
export * from "./core/errors.js";
export { normalizeAmount, toMinorUnits } from "./core/validation.js";
export type { WebhookResult } from "./webhooks/service.js";
