/**
 * Every non-2xx answer from a webhook route carries our correlation id in its body
 * (docs/specs/04-event-model.md F50, "Errors"), so a customer who reads a failed delivery in the
 * provider's own log can quote one value to support.
 *
 * It is applied once, around all `/webhooks/*` routes, instead of at every `return c.text(...)`:
 * a new early return cannot forget it. A plain-text refusal becomes `{ error, correlation_id }`;
 * a JSON object refusal gains `correlation_id` (never replacing a field it already has). Nothing
 * else about the response changes: status and every header (`Retry-After` included) are kept, and
 * a 2xx or 3xx is passed through untouched. The id is ours, minted in `correlation`, never a value
 * the sender supplied (`x-request-id` is kept apart, see `platform/correlation.ts`).
 *
 * Bodies here are constants and field names, never a received signature, secret or payload
 * (F50 Security); this wrapper only adds the id and cannot widen that.
 */
import type { MiddlewareHandler } from 'hono';
import { currentCorrelationId } from './correlation';

/** Error bodies are tiny; anything larger is not ours to rewrite. */
const MAX_REWRITE_BYTES = 8 * 1024;

export const ingressErrorBodies: MiddlewareHandler = async (c, next) => {
  await next();
  const res = c.res;
  const id = currentCorrelationId();
  if (res.status < 400 || id === null) return;

  let text: string;
  try {
    text = await res.clone().text();
  } catch {
    return;
  }
  if (text.length > MAX_REWRITE_BYTES) return;

  const isJson = /^application\/json/i.test(res.headers.get('content-type') ?? '');
  let body: Record<string, unknown>;
  if (isJson) {
    try {
      const parsed: unknown = JSON.parse(text);
      body =
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? { ...(parsed as Record<string, unknown>) }
          : { error: 'Request failed' };
    } catch {
      body = { error: 'Request failed' };
    }
  } else {
    body = { error: text || 'Request failed' };
  }
  if (!('correlation_id' in body)) body.correlation_id = id;

  const headers = new Headers(res.headers);
  headers.set('content-type', 'application/json; charset=UTF-8');
  headers.delete('content-length');
  c.res = new Response(JSON.stringify(body), { status: res.status, headers });
};
