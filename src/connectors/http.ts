import { ProviderError, UnknownResultError } from "../core/errors.js";
import type { WebhookHeaders } from "../core/types.js";
import type { HttpClient } from "./types.js";

/**
 * First value wins for repeated headers. String inputs behave exactly as
 * before; this only additionally accepts Node/Express-style string arrays.
 */
export function firstHeader(headers: WebhookHeaders, ...names: string[]): string | undefined {
  for (const name of names) {
    const v = headers[name];
    if (Array.isArray(v)) return v[0];
    if (v !== undefined) return v;
  }
  return undefined;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  provider: string;
  reference?: string;
  http?: HttpClient;
}

/** JSON request with timeout. Timeouts/network errors -> UnknownResultError (never auto-fail). */
export async function providerJson<T>(url: string, opts: RequestOptions): Promise<T> {
  const http: HttpClient =
    opts.http ?? ((u, init) => fetch(u, init as RequestInit) as Promise<Response>);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await http(url, {
      method: opts.method ?? "GET",
      headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal,
    } as RequestInit);
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      json = { _rawText: text };
    }
    if (!res.ok) {
      const message =
        typeof json === "object" && json !== null && "message" in json
          ? String((json as { message: unknown }).message)
          : `HTTP ${res.status}`;
      throw new ProviderError(message, {
        provider: opts.provider,
        status: res.status,
        retryable: res.status >= 500 || res.status === 429,
        raw: json,
      });
    }
    return json as T;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    const aborted =
      err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message));
    throw new UnknownResultError(opts.provider, opts.reference ?? url, err);
  } finally {
    clearTimeout(timer);
  }
}
