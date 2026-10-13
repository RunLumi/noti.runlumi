import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { requireSameOrigin } from '../../src/security/csrf';

const ORIGIN = 'https://noti.test';

function app() {
  const a = new Hono<{ Bindings: { APP_ORIGIN: string } }>();
  a.use('/api/*', requireSameOrigin);
  a.all('/api/anything', (c) => c.json({ ok: true }));
  a.all('/api/auth/sign-in', (c) => c.json({ ok: true }));
  a.all('/webhooks/github', (c) => c.json({ ok: true }));
  return a;
}

const call = (method: string, path: string, origin?: string) =>
  app().request(path, { method, headers: origin ? { origin } : {} }, { APP_ORIGIN: ORIGIN });

describe('central same-origin check', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('refuses %s without our Origin', async (method) => {
    expect((await call(method, '/api/anything')).status).toBe(403);
    expect((await call(method, '/api/anything', 'https://evil.test')).status).toBe(403);
    expect((await call(method, '/api/anything', 'null')).status).toBe(403);
    expect((await call(method, '/api/anything', ORIGIN)).status).toBe(200);
  });

  it('never blocks reads, Better Auth (own policy) or provider webhooks', async () => {
    expect((await call('GET', '/api/anything')).status).toBe(200);
    expect((await call('POST', '/api/auth/sign-in')).status).toBe(200);
    expect((await call('POST', '/webhooks/github')).status).toBe(200);
  });
});
