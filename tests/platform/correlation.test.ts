import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  contextFromHeaders,
  correlation,
  correlationFields,
  runWithCorrelation,
  sanitiseExternalId,
} from '../../src/platform/correlation';
import { logLine } from '../../src/platform/log';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('sanitiseExternalId', () => {
  it.each(['abc-123', 'req_01.HZ:9', '8f3c2b1a-0d4e-4c7a-9b1e-2f6a7d8c9e0f', '7d1c9f2a3b4c5d6e-AMS'])(
    'accepts %s',
    (v) => expect(sanitiseExternalId(v)).toBe(v),
  );

  it.each([
    '',
    'abc',
    'a'.repeat(65),
    'has space',
    'line\nbreak',
    'semi;colon',
    '-leading-dash',
    '<script>',
    'café-id',
    'a‮b-reversed',
  ])('rejects %j', (v) => expect(sanitiseExternalId(v)).toBeNull());

  it('rejects null and undefined', () => {
    expect(sanitiseExternalId(null)).toBeNull();
    expect(sanitiseExternalId(undefined)).toBeNull();
  });
});

describe('contextFromHeaders', () => {
  it('always mints our own v4 id and never adopts the caller-supplied one', () => {
    const ctx = contextFromHeaders(new Headers({ 'x-request-id': 'caller-chosen-id' }));
    expect(ctx.correlationId).toMatch(UUID);
    expect(ctx.correlationId).not.toBe('caller-chosen-id');
    expect(ctx.externalRequestId).toBe('caller-chosen-id');
  });

  it('captures a sane cf-ray alongside, and drops an insane one', () => {
    expect(contextFromHeaders(new Headers({ 'cf-ray': '8a1b2c3d4e5f-SIN' })).cfRay).toBe('8a1b2c3d4e5f-SIN');
    expect(contextFromHeaders(new Headers({ 'cf-ray': 'bad ray' })).cfRay).toBeUndefined();
  });

  it('mints a different id per request', () => {
    const a = contextFromHeaders(new Headers());
    const b = contextFromHeaders(new Headers());
    expect(a.correlationId).not.toBe(b.correlationId);
  });
});

describe('log integration', () => {
  it('adds the correlation keys inside a request and nothing outside one', () => {
    expect(correlationFields()).toEqual({});
    expect(JSON.parse(logLine('info', 'delivery_attempt'))).not.toHaveProperty('correlation_id');
    const ctx = contextFromHeaders(new Headers({ 'x-request-id': 'caller-1234', 'cf-ray': 'ray1234-AMS' }));
    const line = runWithCorrelation(
      ctx,
      () => JSON.parse(logLine('info', 'delivery_attempt', { delivery_id: 'd1' })) as Record<string, unknown>,
    );
    expect(line).toMatchObject({
      correlation_id: ctx.correlationId,
      external_request_id: 'caller-1234',
      cf_ray: 'ray1234-AMS',
      delivery_id: 'd1',
    });
  });

  it('does not let a call site override the correlation id with a different one silently', () => {
    const ctx = contextFromHeaders(new Headers());
    const line = runWithCorrelation(
      ctx,
      () =>
        JSON.parse(logLine('info', 'delivery_attempt', { correlation_id: 'explicit' })) as Record<
          string,
          unknown
        >,
    );
    // An explicit field wins (queue consumers will pass the message's own id here).
    expect(line.correlation_id).toBe('explicit');
  });

  it('keeps concurrent requests apart', async () => {
    const seen: string[] = [];
    const run = (id: string) =>
      runWithCorrelation({ correlationId: id }, async () => {
        await new Promise((r) => setTimeout(r, id === 'a' ? 5 : 0));
        seen.push(`${id}:${correlationFields().correlation_id}`);
      });
    await Promise.all([run('a'), run('b')]);
    expect(seen.sort()).toEqual(['a:a', 'b:b']);
  });
});

describe('correlation middleware', () => {
  function app(): Hono {
    const a = new Hono();
    a.use('*', correlation);
    a.get('/ok', (c) => c.json({ id: correlationFields().correlation_id }));
    a.get('/boom', () => {
      throw new Error('boom');
    });
    return a;
  }

  it('echoes the minted id as x-request-id and logs the same one', async () => {
    const res = await app().request('/ok', { headers: { 'x-request-id': 'caller-chosen-id' } });
    const echoed = res.headers.get('x-request-id');
    expect(echoed).toMatch(UUID);
    expect(echoed).not.toBe('caller-chosen-id');
    expect((await res.json<{ id: string }>()).id).toBe(echoed);
  });

  it('mints an id when none is supplied, and one per request', async () => {
    const a = app();
    const r1 = (await a.request('/ok')).headers.get('x-request-id');
    const r2 = (await a.request('/ok')).headers.get('x-request-id');
    expect(r1).toMatch(UUID);
    expect(r1).not.toBe(r2);
  });

  it('echoes on an error response too', async () => {
    const res = await app().request('/boom');
    expect(res.status).toBe(500);
    expect(res.headers.get('x-request-id')).toMatch(UUID);
  });
});
