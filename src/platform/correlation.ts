/**
 * Request correlation (docs/specs/01-platform-runtime.md F11, docs/specs/13-observability.md F193).
 *
 * The correlation id is minted here, at ingress and before any parsing, so a request that
 * fails signature verification is still traceable. It is always OUR id (a v4 UUID, opaque,
 * no timestamp or tenant prefix). A caller-supplied `x-request-id` is accepted only as an
 * `external_request_id` that is logged next to ours, never instead of it (F193: a provider
 * could otherwise choose a value that collides with a real one). `cf-ray` is captured
 * alongside and never substitutes either.
 *
 * Propagation inside one invocation uses AsyncLocalStorage (available under the
 * `nodejs_compat` flag set in wrangler.jsonc), so `log()` can attach the id without every
 * call site threading it through. Beyond the request it travels three ways (ADR 0024, F193): stamped on
 * the `deliveries`, `notification_outbox` and `delivery_attempts` rows (`correlation_id`), carried in
 * the queue message (`DeliveryMessage.correlationId`), and re-bound around each queue message in the
 * consumers with `withMessageCorrelation`, which has no request to inherit from.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { MiddlewareHandler } from 'hono';

export interface CorrelationContext {
  readonly correlationId: string;
  /** Caller-supplied `x-request-id`, only when it passed {@link sanitiseExternalId}. */
  readonly externalRequestId?: string;
  /** `cf-ray`, only when it passed {@link sanitiseExternalId}. */
  readonly cfRay?: string;
}

export const REQUEST_ID_HEADER = 'x-request-id';

/** Printable, URL- and log-safe, and short enough that it cannot bloat a log line. */
const EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,63}$/;

/** Returns the value when it is a sane opaque handle (4-64 chars, restricted set), else null. */
export function sanitiseExternalId(value: string | null | undefined): string | null {
  return typeof value === 'string' && EXTERNAL_ID.test(value) ? value : null;
}

/**
 * An id read back from a queue message or a query string: our own opaque id or a sane handle, 4-64
 * characters from a restricted set. Anything else is dropped, never repaired.
 */
export function sanitiseCorrelationId(value: unknown): string | null {
  return typeof value === 'string' ? sanitiseExternalId(value) : null;
}

export function mintCorrelationId(): string {
  return crypto.randomUUID();
}

export function contextFromHeaders(headers: Headers): CorrelationContext {
  const external = sanitiseExternalId(headers.get(REQUEST_ID_HEADER));
  const ray = sanitiseExternalId(headers.get('cf-ray'));
  return {
    correlationId: mintCorrelationId(),
    ...(external ? { externalRequestId: external } : {}),
    ...(ray ? { cfRay: ray } : {}),
  };
}

const storage = new AsyncLocalStorage<CorrelationContext>();

export function runWithCorrelation<T>(ctx: CorrelationContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentCorrelation(): CorrelationContext | undefined {
  return storage.getStore();
}

/** The current invocation's correlation id, or null outside a request or a bound queue message. */
export function currentCorrelationId(): string | null {
  return storage.getStore()?.correlationId ?? null;
}

/** `{ correlationId }` for a queue message, or nothing outside a request. Spread it into the message. */
export function correlationField(): { readonly correlationId?: string } {
  const id = currentCorrelationId();
  return id ? { correlationId: id } : {};
}

/**
 * Runs `fn` with the correlation id of a queue message bound (consumers run outside any request). A
 * message without a usable id (written before this existed) runs unbound, exactly as before.
 */
export function withMessageCorrelation<T>(correlationId: string | null | undefined, fn: () => T): T {
  const id = sanitiseCorrelationId(correlationId);
  return id ? storage.run({ correlationId: id }, fn) : fn();
}

/** Log keys for the current invocation (F11 key set); empty outside a request. */
export function correlationFields(): Record<string, string> {
  const ctx = storage.getStore();
  if (!ctx) return {};
  return {
    correlation_id: ctx.correlationId,
    ...(ctx.externalRequestId ? { external_request_id: ctx.externalRequestId } : {}),
    ...(ctx.cfRay ? { cf_ray: ctx.cfRay } : {}),
  };
}

/**
 * Mints the context, runs the rest of the request inside it, and echoes our id as
 * `x-request-id` on every response, including errors produced by other middleware.
 */
export const correlation: MiddlewareHandler = async (c, next) => {
  const ctx = contextFromHeaders(c.req.raw.headers);
  await runWithCorrelation(ctx, next);
  c.header(REQUEST_ID_HEADER, ctx.correlationId);
};
