import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { correlation } from '../../src/platform/correlation';
import { ingressErrorBodies } from '../../src/platform/ingress-errors';

/** F50 "Errors": every non-2xx webhook answer carries our correlation id in its body. */
function app() {
  const a = new Hono();
  a.use('*', correlation);
  a.use('/webhooks/*', ingressErrorBodies);
  a.post('/webhooks/text', (c) => c.text('Unauthorized', 401));
  a.post('/webhooks/json', (c) => c.json({ error: 'Invalid event', fields: [{ field: 'x' }] }, 400));
  a.post('/webhooks/limited', (c) => c.text('Too many requests', 429, { 'retry-after': '17' }));
  a.post('/webhooks/ok', (c) => c.json({ accepted: true }, 202));
  a.post('/webhooks/dup', (c) => c.json({ accepted: true, duplicate: true }, 200));
  a.post('/webhooks/array', (c) => c.json([1, 2], 400));
  a.post('/webhooks/own', (c) => c.json({ error: 'x', correlation_id: 'route-set' }, 400));
  a.post('/webhooks/big', (c) => c.text('x'.repeat(20_000), 500));
  a.post('/other', (c) => c.text('Nope', 400));
  return a;
}

const post = (a: Hono, path: string, headers: Record<string, string> = {}) =>
  a.request(path, { method: 'POST', headers });

describe('ingressErrorBodies', () => {
  it('wraps a plain-text refusal with the id that is also echoed in x-request-id', async () => {
    const res = await post(app(), '/webhooks/text');
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    const body = await res.json<{ error: string; correlation_id: string }>();
    expect(body.error).toBe('Unauthorized');
    expect(body.correlation_id).toBe(res.headers.get('x-request-id'));
    expect(body.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('adds the id to a JSON error and keeps its other fields', async () => {
    const res = await post(app(), '/webhooks/json');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Invalid event',
      fields: [{ field: 'x' }],
      correlation_id: res.headers.get('x-request-id'),
    });
  });

  it('keeps Retry-After and the status of a 429', async () => {
    const res = await post(app(), '/webhooks/limited');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('17');
    expect((await res.json<{ correlation_id: string }>()).correlation_id).toBeTruthy();
  });

  it('never uses a sender-supplied x-request-id as the id', async () => {
    const res = await post(app(), '/webhooks/text', { 'x-request-id': 'attacker-chosen-1234' });
    const body = await res.json<{ correlation_id: string }>();
    expect(body.correlation_id).not.toBe('attacker-chosen-1234');
  });

  it('leaves 2xx answers (a 202 accept and a 200 duplicate) exactly as they were', async () => {
    const ok = await post(app(), '/webhooks/ok');
    expect(await ok.json()).toEqual({ accepted: true });
    const dup = await post(app(), '/webhooks/dup');
    expect(dup.status).toBe(200);
    expect(await dup.json()).toEqual({ accepted: true, duplicate: true });
  });

  it('does not overwrite a correlation_id a route already set, and copes with non-object JSON', async () => {
    const own = await post(app(), '/webhooks/own');
    expect((await own.json<{ correlation_id: string }>()).correlation_id).toBe('route-set');
    const arr = await post(app(), '/webhooks/array');
    expect(Object.keys(await arr.json<object>()).sort()).toEqual(['correlation_id', 'error']);
  });

  it('only touches /webhooks/*, and leaves a body too large to be ours alone', async () => {
    const other = await post(app(), '/other');
    expect(await other.text()).toBe('Nope');
    const big = await post(app(), '/webhooks/big');
    expect(big.status).toBe(500);
    expect((await big.text()).length).toBe(20_000);
  });
});
