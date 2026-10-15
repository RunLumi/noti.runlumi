import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOT_ENV } from '../support/boot-env';
import type { Bindings } from '../../src/env';
import { recordAudit } from '../../src/audit/audit';
import { scrubSecrets } from '../../src/platform/redact';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';
import { scanTexts, type Needle } from '../support/scan';

/**
 * F12 and F236 (ADR 0039): audit rows and audit read responses never carry a token, a signing secret, a
 * password or a URL path. The secrets below are FIXTURES shaped like real ones; none is a credential.
 *
 * Three places are checked: the writer (what is stored), the reader (what is returned, including rows
 * written before the writer scrubbed), and every string of every response.
 */
vi.mock('../../src/auth/better-auth', () => ({
  createAuth: () => ({
    api: {
      getSession: ({ headers }: { headers: Headers }) => {
        const id = headers.get('x-test-user');
        return Promise.resolve(
          id
            ? {
                user: { id, email: `${id}@example.test`, emailVerified: true, name: `Name of ${id}` },
                session: { id: `sess-${id}`, activeOrganizationId: null },
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
const GITHUB_TOKEN = 'ghp_FixtureTokenA1b2C3d4E5f6G7h8I9j0K1l2';
const SLACK_PATH = 'https://hooks.slack.com/services/T0FIXTURE/B0FIXTURE/fixtureSecretPath99';
const SIGNING = 'whsec_FixtureSigningSecret0123456789';
const BEARER = 'Bearer fixtureBearerToken0123456789';
const PASSWORD = 'password=fixturePassword2024!';

const needles: Needle[] = [
  { label: 'github token', value: GITHUB_TOKEN },
  { label: 'slack webhook path', value: 'fixtureSecretPath99' },
  { label: 'signing secret', value: SIGNING },
  { label: 'bearer token', value: 'fixtureBearerToken0123456789' },
  { label: 'password value', value: 'fixturePassword2024!' },
];

let db: FakeD1;
let env: Bindings;

beforeEach(() => {
  db = createFakeD1();
  for (const id of ['alice']) {
    db.raw
      .prepare('INSERT INTO "user"(id,name,email,email_verified,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(id, `Name of ${id}`, `${id}@example.test`, 1, 1, 1);
  }
  seedOrganization(db.raw, 'org-a');
  db.raw
    .prepare('INSERT INTO "member"(id,user_id,organization_id,role,created_at) VALUES(?,?,?,?,?)')
    .run('m1', 'alice', 'org-a', 'admin', 1);
  env = { ...BOOT_ENV, DB: db.d1, APP_ORIGIN: ORIGIN } as unknown as Bindings;
});

/** Every string value of every audit row, as stored. */
function storedTexts(): string[] {
  const rows = db.raw.prepare('SELECT * FROM audit_events').all() as Record<string, unknown>[];
  return rows.flatMap((r) => Object.values(r).filter((v): v is string => typeof v === 'string'));
}

/** Every string value in a JSON response, at any depth. */
function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringsOf);
  return [];
}

async function readAll(as = 'alice'): Promise<{ status: number; text: string; body: unknown }> {
  const res = await worker.fetch(
    new Request(`${ORIGIN}/api/audit?limit=100`, { headers: { 'x-test-user': as } }),
    env,
    { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
  );
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as unknown };
}

describe('the writer stores no secret-shaped value', () => {
  it('scrubs what it stores, and keeps what is not a secret', async () => {
    await recordAudit(db.d1, {
      organizationId: 'org-a',
      actorId: 'alice',
      action: 'integration.update',
      subjectType: 'integration',
      subjectId: 'int-1',
      outcome: 'success',
      userAgent: `probe ${BEARER}`,
      metadata: {
        repo: 'acme/app',
        destinationHost: 'hooks.slack.com',
        reason: `token=${GITHUB_TOKEN}`,
        fields: [SLACK_PATH, PASSWORD],
      },
    });
    expect(scanTexts(storedTexts(), needles)).toEqual([]);
    const row = db.raw.prepare('SELECT metadata_json, user_agent FROM audit_events').get() as {
      metadata_json: string;
      user_agent: string;
    };
    expect(JSON.parse(row.metadata_json)).toEqual({
      repo: 'acme/app',
      destinationHost: 'hooks.slack.com',
      reason: 'token=[redacted]',
      fields: ['https://hooks.slack.com/[redacted]', 'password=[redacted]'],
    });
    expect(row.user_agent).toBe('probe Bearer [redacted]');
  });

  it('a value with no secret in it is stored exactly as it was given', async () => {
    await recordAudit(db.d1, {
      organizationId: 'org-a',
      actorId: 'alice',
      action: 'source.update',
      subjectType: 'source',
      subjectId: 'src-1',
      outcome: 'success',
      metadata: { fields: ['enabled', 'eventTypes'], enabled: true, kind: 'github' },
    });
    const row = db.raw.prepare('SELECT metadata_json FROM audit_events').get() as { metadata_json: string };
    expect(JSON.parse(row.metadata_json)).toEqual({
      fields: ['enabled', 'eventTypes'],
      enabled: true,
      kind: 'github',
    });
  });
});

describe('the reader returns no secret-shaped value, even from a row written before the writer scrubbed', () => {
  it('scrubs a legacy row on the way out, and every string of every response is already clean', async () => {
    // Rows as an earlier writer would have stored them: the raw values, bypassing the writer. Each action
    // shows only its own allow-listed keys, so each row carries the keys its action shows.
    const insert = db.raw.prepare(
      'INSERT INTO audit_events(id,organization_id,actor_id,action,subject_type,subject_id,outcome,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    );
    insert.run(
      'legacy-1',
      'org-a',
      'alice',
      'integration.update',
      'integration',
      'int-1',
      'success',
      JSON.stringify({ fields: [SLACK_PATH, SIGNING, BEARER], repo: 'acme/app' }),
      '2026-10-01 10:00:00',
    );
    insert.run(
      'legacy-2',
      'org-a',
      'alice',
      'integration.credentials.revoke',
      'integration',
      'int-1',
      'success',
      JSON.stringify({ reason: `token=${GITHUB_TOKEN}`, destinationHost: SLACK_PATH }),
      '2026-10-02 10:00:00',
    );
    const res = await readAll();
    expect(res.status).toBe(200);
    expect(scanTexts([res.text], needles)).toEqual([]);
    expect(res.text).toContain('acme/app');
    const events = (res.body as { events: { id: string; summary: { key: string; value: unknown }[] }[] })
      .events;
    expect(events.find((e) => e.id === 'legacy-1')?.summary).toEqual(
      expect.arrayContaining([
        { key: 'fields', value: ['https://hooks.slack.com/[redacted]', '[redacted]', 'Bearer [redacted]'] },
        { key: 'repo', value: 'acme/app' },
      ]),
    );
    const revoke = events.find((e) => e.id === 'legacy-2')?.summary;
    expect(revoke).toHaveLength(2);
    expect(revoke).toEqual(
      expect.arrayContaining([
        { key: 'reason', value: 'token=[redacted]' },
        { key: 'destinationHost', value: 'https://hooks.slack.com/[redacted]' },
      ]),
    );
    // Clean by the redaction layer's own definition, not only by the needles above.
    for (const s of stringsOf(res.body)) expect(scrubSecrets(s), s).toBe(s);
  });

  it('every audit row written by the real routes, and every read, is clean of the fixtures', async () => {
    await recordAudit(db.d1, {
      organizationId: 'org-a',
      actorId: 'alice',
      action: 'source.update',
      subjectType: 'source',
      subjectId: 'src-1',
      outcome: 'success',
      metadata: { reason: GITHUB_TOKEN, fields: [SIGNING] },
    });
    const first = await readAll();
    const second = await readAll();
    expect(scanTexts(storedTexts(), needles)).toEqual([]);
    expect(scanTexts([first.text, second.text], needles)).toEqual([]);
    // The read rows are written by the reads themselves and are in the responses too.
    const actions = (second.body as { events: { action: string }[] }).events.map((e) => e.action);
    expect(actions).toContain('audit.read');
    for (const s of stringsOf(second.body)) expect(scrubSecrets(s), s).toBe(s);
  });
});
