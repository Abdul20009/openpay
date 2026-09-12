/** Typed errors so apps can branch without parsing strings. */

export type OpenPayErrorCode =
  | "validation_error"
  | "configuration_error"
  | "provider_error"
  | "capability_error"
  | "unknown_result"
  | "webhook_verification_error"
  | "idempotency_conflict";

export interface OpenPayErrorOptions {
  provider?: string;
  /** HTTP status from provider (if any). */
  status?: number;
  /** Safe to retry with same idempotency key? */
  retryable?: boolean;
  raw?: unknown;
}

export class OpenPayError extends Error {
  readonly code: OpenPayErrorCode;
  readonly provider?: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly raw?: unknown;

  constructor(message: string, code: OpenPayErrorCode, opts: OpenPayErrorOptions = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.provider = opts.provider;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    this.raw = opts.raw;
  }
}

export class ValidationError extends OpenPayError {
  constructor(message: string, raw?: unknown) {
    super(message, "validation_error", { retryable: false, raw });
  }
}

export class ConfigurationError extends OpenPayError {
  constructor(message: string) {
    super(message, "configuration_error", { retryable: false });
  }
}

export class ProviderError extends OpenPayError {
  constructor(message: string, opts: OpenPayErrorOptions = {}) {
    super(message, "provider_error", opts);
  }
}

/** Provider does not support this operation (e.g. Bachs refunds in V1). */
export class CapabilityError extends OpenPayError {
  constructor(provider: string, operation: string, detail?: string) {
    super(
      `${provider} does not support ${operation} in OpenPay V1${detail ? `: ${detail}` : ""}`,
      "capability_error",
      { provider, retryable: false },
    );
  }
}

/**
 * Provider timed out or returned an ambiguous result.
 * Outcome is UNKNOWN — verify before retrying, never treat as failed.
 */
export class UnknownResultError extends OpenPayError {
  constructor(provider: string, reference: string, raw?: unknown) {
    super(
      `Unknown outcome for ${reference} on ${provider}: verify before retrying`,
      "unknown_result",
      { provider, retryable: true, raw },
    );
  }
}

export class WebhookVerificationError extends OpenPayError {
  constructor(provider: string) {
    super(`Webhook signature verification failed for ${provider}`, "webhook_verification_error", {
      provider,
      retryable: false,
    });
  }
}
