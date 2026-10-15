import { createHmac } from 'node:crypto';
import { vi } from 'vitest';
import type { Bindings, DeliveryMessage } from '../../src/env';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

/**
 * Shared harness for the generic-source tests: the real Worker over the real migrations and a
 * fake D1. Only Better Auth's session lookup is replaced (`x-test-user` names the user).
 */
export const ORIGIN = 'https://noti.test';
export const SLACK = 'https://hooks.slack.com/services/T000/B000/SourceFixtureToken';
export const LARK = 'https://open.larksuite.com/open-apis/bot/v2/hook/source-fixture';
export const TEAMS =
  'https://prod-12.westus.logic.azure.com/workflows/abc123/triggers/manual/paths/invoke?sig=SourceFixtureSig';

export interface Harness {
  db: FakeD1;
  env: Bindings;
  fetchMock: ReturnType<typeof vi.fn>;
  waitUntil: ReturnType<typeof vi.fn>;
}

export function mockAuth() {
  return {
    createAuth: () => ({
      api: {
        getSession: ({ headers }: { headers: Headers }) => {
          const id = headers.get('x-test-user');
          return Promise.resolve(
            id
              ? {
                  user: { id, email: `${id}@example.test`, emailVerified: true, name: id },
                  session: { activeOrganizationId: headers.get('x-test-active-org') },
                }
              : null,
          );
        },
      },
      handler: () => new Response(null, { status: 404 }),
    }),
  };
}

export function setup(): Harness {
  const db = createFakeD1();
  seedOrganization(db.raw, 'org-a');
  seedOrganization(db.raw, 'org-b');
  for (const id of ['alice', 'bob', 'mallory']) {
    db.raw
      .prepare('INSERT INTO "user"(id,name,email,email_verified,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(id, id, `${id}@example.test`, 1, 1, 1);
  }
  const member = (userId: string, org: string, role: string) =>
    db.raw
      .prepare('INSERT INTO "member"(id,user_id,organization_id,role,created_at) VALUES(?,?,?,?,?)')
      .run(`${userId}-${org}`, userId, org, role, 1);
  member('alice', 'org-a', 'admin');
  member('bob', 'org-a', 'member');
  member('mallory', 'org-b', 'admin');
  const env = {
    DB: db.d1,
    APP_ORIGIN: ORIGIN,
    BETTER_AUTH_SECRET: 'test-better-auth-secret-0123456789ab',
    KEK_V1: '11'.repeat(32),
    KEK_V2: '',
    KMS_ACTIVE_VERSION: '1',
    ENVIRONMENT_NAME: 'staging',
    KEK_CHECK_V1: '4464ea2121d3a99ebd188370f1ef6cd0',
    FINGERPRINT_KEY: '44'.repeat(32),
    ENCRYPTION_KEY: '',
    GITHUB_APP_ID: '1',
    GITHUB_WEBHOOK_SECRET: 'x',
    DELIVERY_QUEUE: { send: (_m: DeliveryMessage) => Promise.resolve() },
  } as unknown as Bindings;
  const fetchMock = vi.fn(() => Promise.resolve(new Response('ok')));
  vi.stubGlobal('fetch', fetchMock);
  return { db, env, fetchMock, waitUntil: vi.fn() };
}

type Worker = { fetch: (req: Request, env: Bindings, ctx: ExecutionContext) => Promise<Response> | Response };

export function caller(worker: Worker, h: () => Harness) {
  return async function call(
    method: string,
    path: string,
    options: { as?: string; body?: unknown; origin?: string | null; org?: string; contentType?: string } = {},
  ): Promise<Response> {
    const headers = new Headers({ 'content-type': options.contentType ?? 'application/json' });
    if (options.as) headers.set('x-test-user', options.as);
    if (options.org) headers.set('x-test-active-org', options.org);
    if (options.origin !== null) headers.set('origin', options.origin ?? ORIGIN);
    return worker.fetch(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers,
        body: options.body === undefined ? null : JSON.stringify(options.body),
      }),
      h().env,
      { waitUntil: h().waitUntil, passThroughOnException: () => undefined } as unknown as ExecutionContext,
    );
  };
}

export interface CreatedSource {
  id: string;
  endpointId: string;
  endpointUrl: string;
  secret: string;
}

/** Secret `whsec_<base64>` to the raw HMAC key. */
export function keyOf(secret: string): Uint8Array {
  return Uint8Array.from(atob(secret.slice('whsec_'.length)), (c) => c.charCodeAt(0));
}

/** An independent signer (node:crypto), so the tests do not verify the code with itself. */
export function signHeaders(
  secret: string,
  body: string | Buffer,
  options: { id?: string; ts?: number } = {},
): Record<string, string> {
  const id = options.id ?? `msg_${Math.random().toString(36).slice(2)}`;
  const ts = String(options.ts ?? Math.floor(Date.now() / 1000));
  const mac = createHmac('sha256', keyOf(secret)).update(`${id}.${ts}.`).update(body).digest('base64');
  return { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${mac}` };
}

export const EVENT = {
  type: 'deploy.failed',
  title: 'Deploy failed on production',
  summary: 'Exit code 1',
  url: 'https://ci.example.com/runs/42',
  severity: 'error',
  actor: 'deploy-bot',
  fields: { env: 'prod' },
};
