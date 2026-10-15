import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  needsStoredDestinationRecheck,
  RECHECK_STORED_DESTINATION_ON,
  STORED_DESTINATION_REFUSED,
  STORED_DESTINATION_UNREADABLE,
} from '../../src/api/integrations';
import { keyringFromEnv } from '../../src/crypto/keyring-env';
import type { Bindings, DeliveryMessage } from '../../src/env';
import { blob, sealCredentials } from '../../src/pipeline/credentials';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

/**
 * F96 (ADR 0054): a PATCH that brings no new credentials still re-runs the destination URL policy against the
 * SAVED URL when the change leaves the integration sending, and refuses the change when that URL no longer
 * passes (a host removed from the allowlist since it was saved). The harness follows integrations.test.ts.
 */
vi.mock('../../src/auth/better-auth', () => ({
  createAuth: () => ({
    api: {
      getSession: ({ headers }: { headers: Headers }) => {
        const id = headers.get('x-test-user');
        return Promise.resolve(
          id
            ? {
                user: { id, email: `${id}@example.test`, emailVerified: true, name: id },
                session: { activeOrganizationId: null },
              }
            : null,
        );
      },
    },
    handler: () => new Response(null, { status: 404 }),
  }),
}));

const { default: worker } = await import('../../src/index');

const ORIGIN = 'https://noti.test';
const SLACK = 'https://hooks.slack.com/services/T000/B000/SecretTokenPath';
const SLACK_NEW = 'https://hooks.slack.com/services/T000/B000/RotatedTokenPath';
const LARK = 'https://open.larksuite.com/open-apis/bot/v2/hook/LarkTokenPath';
/** A URL the policy refuses: its host is not (or, in the story this models, no longer) on the allowlist. */
const REMOVED_HOST = 'https://hooks.retired-slack.example/services/T000/B000/RemovedTokenPath';

let db: FakeD1;
let env: Bindings;

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-user': 'alice', origin: ORIGIN },
      body: body === undefined ? null : JSON.stringify(body),
    }),
    env,
    { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
  );
}

async function createIntegration(body: Record<string, unknown> = {}): Promise<string> {
  const res = await call('POST', '/api/integrations', {
    name: 'Alerts',
    repo: 'acme/web',
    eventTypes: ['issues.opened'],
    destination: 'slack',
    webhookUrl: SLACK,
    ...body,
  });
  expect(res.status).toBe(201);
  return (await res.json<{ integration: { id: string } }>()).integration.id;
}

/**
 * Re-seal a different URL into the row, exactly as a write would (fresh key material, AAD bound to the row):
 * the row now holds a URL that today's policy refuses. This stands in for a host that was allowed when the URL
 * was saved and has since been removed from the provider registry.
 */
async function storeUrl(id: string, url: string): Promise<void> {
  const sealed = await sealCredentials(
    { organizationId: 'org-a', connectionId: id },
    { webhookUrl: url, signingSecret: null },
    keyringFromEnv(env),
  );
  db.raw
    .prepare(
      `UPDATE integrations SET key_salt=?, dek_wrapped=?, kek_version=?, webhook_envelope=?
       WHERE id=? AND organization_id='org-a'`,
    )
    .run(
      new Uint8Array(blob(sealed.keySalt) ?? new ArrayBuffer(0)),
      new Uint8Array(blob(sealed.dekWrapped) ?? new ArrayBuffer(0)),
      sealed.kekVersion,
      new Uint8Array(blob(sealed.webhookEnvelope) ?? new ArrayBuffer(0)),
      id,
    );
}

function eventTypes(id: string): string[] {
  const row = db.raw.prepare('SELECT event_types FROM integrations WHERE id=?').get(id) as {
    event_types: string;
  };
  return JSON.parse(row.event_types) as string[];
}

function auditActions(): string[] {
  return (
    db.raw.prepare("SELECT action FROM audit_events WHERE organization_id='org-a' ORDER BY rowid").all() as {
      action: string;
    }[]
  ).map((r) => r.action);
}

let warn: { mock: { calls: unknown[][] } };
const logged = (): string => warn.mock.calls.map((c) => String(c[0])).join('\n');

beforeEach(() => {
  db = createFakeD1();
  seedOrganization(db.raw, 'org-a');
  db.raw
    .prepare('INSERT INTO "user"(id,name,email,email_verified,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run('alice', 'alice', 'alice@example.test', 1, 1, 1);
  db.raw
    .prepare('INSERT INTO "member"(id,user_id,organization_id,role,created_at) VALUES(?,?,?,?,?)')
    .run('alice-org-a', 'alice', 'org-a', 'admin', 1);
  db.raw
    .prepare(
      `INSERT INTO github_installations(id,organization_id,installation_id,app_id,account_login,account_type,repository_selection)
       VALUES('gi-1','org-a','1001','1','acme','Organization','all')`,
    )
    .run();
  env = {
    DB: db.d1,
    APP_ORIGIN: ORIGIN,
    BETTER_AUTH_SECRET: 'test-better-auth-secret-0123456789ab',
    AUTH_EMAIL: { send: () => Promise.resolve({ messageId: 'test' }) },
    AUTH_FROM_EMAIL: 'noreply@noti.test',
    KEK_V1: '11'.repeat(32),
    KEK_V2: '',
    KMS_ACTIVE_VERSION: '1',
    ENVIRONMENT_NAME: 'staging',
    KEK_CHECK_V1: '4464ea2121d3a99ebd188370f1ef6cd0',
    ENCRYPTION_KEY: '',
    GITHUB_APP_ID: '1',
    GITHUB_WEBHOOK_SECRET: 'x',
    DELIVERY_QUEUE: { send: (_m: DeliveryMessage) => Promise.resolve() },
  } as unknown as Bindings;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response('ok'))),
  );
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('which update fields re-check the saved destination', () => {
  it('every field except the name decides whether, what or when the integration sends', () => {
    expect(RECHECK_STORED_DESTINATION_ON).toEqual({
      name: false,
      repo: true,
      eventTypes: true,
      sourceEventTypes: true,
      enabled: true,
      filters: true,
      noise: true,
    });
  });

  it('only when the integration is still sending afterwards, has no new credentials and is not quarantined', () => {
    const on = { enabled: 1, credentials_quarantined_at: null };
    const paused = { enabled: 0, credentials_quarantined_at: null };
    expect(needsStoredDestinationRecheck(on, { eventTypes: ['issues.opened'] })).toBe(true);
    expect(needsStoredDestinationRecheck(on, { noise: null })).toBe(true);
    expect(needsStoredDestinationRecheck(on, { name: 'Renamed' })).toBe(false);
    expect(needsStoredDestinationRecheck(on, { enabled: false })).toBe(false);
    expect(needsStoredDestinationRecheck(on, { enabled: false, eventTypes: ['issues.opened'] })).toBe(false);
    expect(needsStoredDestinationRecheck(paused, { eventTypes: ['issues.opened'] })).toBe(false);
    expect(needsStoredDestinationRecheck(paused, { enabled: true })).toBe(true);
    expect(
      needsStoredDestinationRecheck(on, {
        eventTypes: ['issues.opened'],
        credentials: { webhookUrl: SLACK_NEW, signingSecret: null },
      }),
    ).toBe(false);
    expect(
      needsStoredDestinationRecheck(
        { enabled: 1, credentials_quarantined_at: '2026-10-15 00:00:00' },
        { enabled: true },
      ),
    ).toBe(false);
  });
});

describe('PATCH re-runs the URL policy against the saved destination (F96)', () => {
  it('refuses a change to a destination whose saved URL the policy now refuses, and changes nothing', async () => {
    const id = await createIntegration();
    await storeUrl(id, REMOVED_HOST);
    const res = await call('PATCH', `/api/integrations/${id}`, { eventTypes: ['issues.closed'] });
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({
      fields: [{ field: 'webhookUrl', message: STORED_DESTINATION_REFUSED }],
    });
    // Neither the URL nor its host is echoed, and nothing was written.
    expect(text).not.toContain('RemovedTokenPath');
    expect(text).not.toContain('retired-slack');
    expect(eventTypes(id)).toEqual(['issues.opened']);
    expect(auditActions()).toEqual(['integration.create']);
    // The log names the rule only.
    expect(logged()).toContain('destination_recheck_refused');
    expect(logged()).toContain('"rule":"host"');
    expect(logged()).not.toContain('RemovedTokenPath');
    expect(logged()).not.toContain('retired-slack');
  });

  it('every sending field is refused; renaming and pausing stay possible; re-enabling is refused', async () => {
    const id = await createIntegration();
    await storeUrl(id, REMOVED_HOST);
    const path = `/api/integrations/${id}`;
    for (const body of [
      { repo: 'acme/other' },
      { eventTypes: ['issues.closed'] },
      { filters: {} },
      { noise: null },
      { enabled: true },
    ]) {
      const res = await call('PATCH', path, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(await res.json(), JSON.stringify(body)).toMatchObject({
        fields: [{ field: 'webhookUrl', message: STORED_DESTINATION_REFUSED }],
      });
    }

    expect((await call('PATCH', path, { name: 'Renamed' })).status).toBe(200);
    // Pausing must always work, above all for a destination the policy now refuses.
    expect((await call('PATCH', path, { enabled: false })).status).toBe(200);
    // While paused nothing is sent, so editing what it would send is allowed...
    expect((await call('PATCH', path, { eventTypes: ['issues.closed'] })).status).toBe(200);
    // ...and turning it back on is the decision to send, so it is checked.
    const again = await call('PATCH', path, { enabled: true });
    expect(again.status).toBe(422);
    expect(
      (db.raw.prepare('SELECT enabled FROM integrations WHERE id=?').get(id) as { enabled: number }).enabled,
    ).toBe(0);
  });

  it('entering a new webhook URL fixes it: the new one is validated in full, then edits pass again', async () => {
    const id = await createIntegration();
    await storeUrl(id, REMOVED_HOST);
    const path = `/api/integrations/${id}`;
    expect((await call('PATCH', path, { webhookUrl: SLACK_NEW, eventTypes: ['issues.closed'] })).status).toBe(
      200,
    );
    expect((await call('PATCH', path, { eventTypes: ['issues.opened', 'issues.closed'] })).status).toBe(200);
    expect(eventTypes(id)).toEqual(['issues.opened', 'issues.closed']);
  });

  it('a saved URL that still passes changes nothing about an ordinary edit', async () => {
    const id = await createIntegration();
    const res = await call('PATCH', `/api/integrations/${id}`, { eventTypes: ['issues.closed'] });
    expect(res.status).toBe(200);
    expect(eventTypes(id)).toEqual(['issues.closed']);
    expect(logged()).not.toContain('destination_recheck');
  });

  it('a saved URL that cannot be opened refuses the change with its own message and logs the code only', async () => {
    const id = await createIntegration();
    const row = db.raw.prepare('SELECT webhook_envelope FROM integrations WHERE id=?').get(id) as {
      webhook_envelope: Uint8Array;
    };
    const damaged = Uint8Array.from(row.webhook_envelope);
    damaged[damaged.length - 1] = (damaged[damaged.length - 1] ?? 0) ^ 0xff;
    db.raw.prepare('UPDATE integrations SET webhook_envelope=? WHERE id=?').run(damaged, id);
    const res = await call('PATCH', `/api/integrations/${id}`, { eventTypes: ['issues.closed'] });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      fields: [{ field: 'webhookUrl', message: STORED_DESTINATION_UNREADABLE }],
    });
    expect(eventTypes(id)).toEqual(['issues.opened']);
    expect(logged()).toContain('destination_recheck_unreadable');
    expect(logged()).toContain('"code":"destination_credentials_invalid"');
    // Pausing it still works.
    expect((await call('PATCH', `/api/integrations/${id}`, { enabled: false })).status).toBe(200);
  });

  it('decrypts only the URL: a damaged signing-secret envelope does not block the re-check', async () => {
    const id = await createIntegration({ destination: 'lark', webhookUrl: LARK, signingSecret: 'Abc123xyz' });
    db.raw
      .prepare('UPDATE integrations SET lark_secret_envelope=? WHERE id=?')
      .run(new Uint8Array([1, 0, 9, 9, 9]), id);
    const res = await call('PATCH', `/api/integrations/${id}`, { eventTypes: ['issues.closed'] });
    expect(res.status).toBe(200);
  });

  it('a quarantined row is not re-checked: nothing is sent to it until a new credential is entered', async () => {
    const id = await createIntegration();
    await storeUrl(id, REMOVED_HOST);
    db.raw
      .prepare("UPDATE integrations SET credentials_quarantined_at='2026-10-15 00:00:00' WHERE id=?")
      .run(id);
    expect((await call('PATCH', `/api/integrations/${id}`, { eventTypes: ['issues.closed'] })).status).toBe(
      200,
    );
  });
});
