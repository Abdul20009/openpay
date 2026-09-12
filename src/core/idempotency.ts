import { randomUUID } from "node:crypto";

/** Build a deterministic idempotency key from operation + provider + reference. */
export function defaultIdempotencyKey(operation: string, provider: string, reference: string): string {
  return `${operation}:${provider}:${reference}`;
}

export function newReference(prefix = "op"): string {
  return `${prefix}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export function newId(): string {
  return randomUUID();
}
