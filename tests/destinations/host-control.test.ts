import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DnsFetcher } from '../../src/connectors/destinations/dns-check';
import {
  MAX_ALLOWED_HOSTS_PER_WORKSPACE,
  PURGE_BATCH,
  RECHECK_BATCH,
  RESOLUTION_RETENTION_MS,
  RESOLUTION_TTL_MS,
  addAllowedHost,
  hostAllowed,
  isSharedSuffix,
  loadAllowedHosts,
  loadResolution,
  normalizeHostRule,
  purgeStaleResolutions,
  removeAllowedHost,
  reresolveDueHosts,
  verifyHostAtSend,
} from '../../src/connectors/destinations/generic-webhook/host-control';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const STALE = NOW + RESOLUTION_TTL_MS + 1;
let db: FakeD1;
let answers: Record<string, string[]>;
let lookups: number;

/** A DNS-over-HTTPS fixture: A records by host. No network. */
const dns: DnsFetcher = (input) => {
  lookups += 1;
  const url = new URL(input);
  const name = url.searchParams.get('name') ?? '';
  const data = url.searchParams.get('type') === 'A' ? (answers[name] ?? []) : [];
  return Promise.resolve(
    new Response(JSON.stringify({ Status: 0, Answer: data.map((d) => ({ name, type: 1, data: d })) }), {
      status: 200,
    }),
  );
};
const deps = () => ({ db: db.d1, fetcher: dns });

function customWebhook(org: string, id: string, enabled = 1): void {
  db.raw
    .prepare(
      "INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,organization_id,enabled) VALUES(?,?,?,'generic_webhook','x',?,?)",
    )
    .run(id, 'acme/web', '[]', org, enabled);
}
const resolutionIds = (): string[] =>
  (
    db.raw.prepare('SELECT integration_id FROM webhook_host_resolutions ORDER BY integration_id').all() as {
      integration_id: string;
    }[]
  ).map((r) => r.integration_id);

beforeEach(() => {
  db = createFakeD1();
  seedOrganization(db.raw, 'org-a');
  seedOrganization(db.raw, 'org-b');
  answers = { 'hooks.example.com': ['93.184.216.34'] };
  lookups = 0;
});

describe('host rules', () => {
  it.each([
    ['Hooks.Example.com', 'hooks.example.com'],
    ['*.example.com', '*.example.com'],
  ])('normalises %s', (raw, out) => expect(normalizeHostRule(raw)).toBe(out));

  it.each([
    '',
    'localhost',
    '10.0.0.1',
    '[::1]',
    'a.example.com:8443',
    'https://a.example.com',
    '*',
    '*.com.',
    'a b.com',
    'x.internal',
  ])('rejects %j', (raw) => expect(normalizeHostRule(raw)).toBeNull());

  it('matches exactly, or by subdomain wildcard, never by suffix trick', () => {
    expect(hostAllowed(['hooks.example.com'], 'hooks.example.com')).toBe(true);
    expect(hostAllowed(['hooks.example.com'], 'evil-hooks.example.com')).toBe(false);
    expect(hostAllowed(['*.example.com'], 'a.b.example.com')).toBe(true);
    expect(hostAllowed(['*.example.com'], 'example.com')).toBe(false);
    expect(hostAllowed(['*.example.com'], 'badexample.com')).toBe(false);
    expect(hostAllowed([], 'hooks.example.com')).toBe(false);
  });
});

describe('wildcard rules over shared hosting (review L2)', () => {
  it.each(['*.herokuapp.com', '*.github.io', '*.pages.dev', '*.co.uk', '*.com.au', '*.com', '*.vercel.app'])(
    'rejects %s',
    (rule) => expect(normalizeHostRule(rule)).toBeNull(),
  );
  it('accepts a wildcard on a company domain and an exact host on shared hosting', () => {
    expect(normalizeHostRule('*.acme.co.uk')).toBe('*.acme.co.uk');
    expect(normalizeHostRule('hooks.acme.com')).toBe('hooks.acme.com');
    expect(normalizeHostRule('my-app.herokuapp.com')).toBe('my-app.herokuapp.com');
  });
  it('isSharedSuffix knows a bare TLD', () => expect(isSharedSuffix('com')).toBe(true));
});

describe('workspace allowlist', () => {
  it('is per tenant', async () => {
    await addAllowedHost(db.d1, 'org-a', 'hooks.example.com', 'u1', NOW);
    expect(await loadAllowedHosts(db.d1, 'org-a')).toEqual(['hooks.example.com']);
    expect(await loadAllowedHosts(db.d1, 'org-b')).toEqual([]);
    expect(await removeAllowedHost(db.d1, 'org-b', 'hooks.example.com')).toBe(false);
    expect(await removeAllowedHost(db.d1, 'org-a', 'hooks.example.com')).toBe(true);
  });

  it('refuses invalid hosts and a full list', async () => {
    expect(await addAllowedHost(db.d1, 'org-a', '10.0.0.1', null, NOW)).toEqual({
      ok: false,
      reason: 'invalid_host',
    });
    for (let i = 0; i < MAX_ALLOWED_HOSTS_PER_WORKSPACE; i += 1)
      await addAllowedHost(db.d1, 'org-a', `h${i}.example.com`, null, NOW);
    expect(await addAllowedHost(db.d1, 'org-a', 'one-more.example.com', null, NOW)).toEqual({
      ok: false,
      reason: 'too_many',
    });
  });
});

describe('verifyHostAtSend', () => {
  it('refuses a host that is not allowlisted, without any DNS lookup', async () => {
    const r = await verifyHostAtSend(deps(), 'org-a', 'int-1', 'hooks.example.com', NOW);
    expect(r).toEqual({ ok: false, reason: 'host_not_allowed' });
    expect(lookups).toBe(0);
  });

  it("another tenant's allowlist does not approve it", async () => {
    await addAllowedHost(db.d1, 'org-b', 'hooks.example.com', null, NOW);
    expect(await verifyHostAtSend(deps(), 'org-a', 'int-1', 'hooks.example.com', NOW)).toEqual({
      ok: false,
      reason: 'host_not_allowed',
    });
  });

  it('returns a verification for exactly the checked host, records the addresses and trusts them for the TTL', async () => {
    await addAllowedHost(db.d1, 'org-a', 'hooks.example.com', null, NOW);
    const r = await verifyHostAtSend(deps(), 'org-a', 'int-1', 'hooks.example.com', NOW);
    expect(r).toMatchObject({ ok: true, verification: { host: 'hooks.example.com' } });
    expect(await loadResolution(db.d1, 'org-a', 'int-1')).toMatchObject({
      host: 'hooks.example.com',
      addresses: ['93.184.216.34'],
      status: 'ok',
    });
    const after = lookups;
    await verifyHostAtSend(deps(), 'org-a', 'int-1', 'hooks.example.com', NOW + RESOLUTION_TTL_MS - 1);
    expect(lookups).toBe(after);
    await verifyHostAtSend(deps(), 'org-a', 'int-1', 'hooks.example.com', NOW + RESOLUTION_TTL_MS);
    expect(lookups).toBeGreaterThan(after);
  });

  it('a host that is statically changed to a private address is refused at the next re-resolution', async () => {
    await addAllowedHost(db.d1, 'org-a', 'hooks.example.com', null, NOW);
    await verifyHostAtSend(deps(), 'org-a', 'int-1', 'hooks.example.com', NOW);
    answers['hooks.example.com'] = ['169.254.169.254'];
    expect(await verifyHostAtSend(deps(), 'org-a', 'int-1', 'hooks.example.com', STALE)).toEqual({
      ok: false,
      reason: 'blocked_address',
    });
    expect((await loadResolution(db.d1, 'org-a', 'int-1'))?.status).toBe('blocked_address');
  });

  it('counts a change of the address set (a public-to-public rotation is allowed but visible)', async () => {
    await addAllowedHost(db.d1, 'org-a', 'hooks.example.com', null, NOW);
    await verifyHostAtSend(deps(), 'org-a', 'int-1', 'hooks.example.com', NOW);
    answers['hooks.example.com'] = ['93.184.216.35'];
    expect(await verifyHostAtSend(deps(), 'org-a', 'int-1', 'hooks.example.com', STALE)).toMatchObject({
      ok: true,
    });
    expect((await loadResolution(db.d1, 'org-a', 'int-1'))?.changedCount).toBe(1);
  });

  it('fails closed (retryable) when the lookup itself fails', async () => {
    await addAllowedHost(db.d1, 'org-a', 'hooks.example.com', null, NOW);
    const down: DnsFetcher = () => Promise.resolve(new Response('', { status: 503 }));
    expect(
      await verifyHostAtSend({ db: db.d1, fetcher: down }, 'org-a', 'int-1', 'hooks.example.com', NOW),
    ).toEqual({ ok: false, reason: 'lookup_failed' });
  });
});

describe('periodic re-resolution', () => {
  it('re-resolves stale records, refuses what turned private or left the allowlist', async () => {
    customWebhook('org-a', 'int-a');
    customWebhook('org-b', 'int-b');
    await addAllowedHost(db.d1, 'org-a', 'hooks.example.com', null, NOW);
    await addAllowedHost(db.d1, 'org-b', 'hooks.example.com', null, NOW);
    await verifyHostAtSend(deps(), 'org-a', 'int-a', 'hooks.example.com', NOW);
    await verifyHostAtSend(deps(), 'org-b', 'int-b', 'hooks.example.com', NOW);
    await removeAllowedHost(db.d1, 'org-b', 'hooks.example.com');
    answers['hooks.example.com'] = ['10.0.0.8'];
    const report = await reresolveDueHosts(deps(), STALE);
    expect(report).toMatchObject({ checked: 2, refused: 2 });
    expect((await loadResolution(db.d1, 'org-a', 'int-a'))?.status).toBe('blocked_address');
    expect((await loadResolution(db.d1, 'org-b', 'int-b'))?.status).toBe('not_allowed');
  });

  it('leaves fresh records alone', async () => {
    customWebhook('org-a', 'int-a');
    await addAllowedHost(db.d1, 'org-a', 'hooks.example.com', null, NOW);
    await verifyHostAtSend(deps(), 'org-a', 'int-a', 'hooks.example.com', NOW);
    const spy = vi.fn();
    const watched: DnsFetcher = (i, n) => (spy(), dns(i, n));
    expect((await reresolveDueHosts({ ...deps(), fetcher: watched }, NOW + 1000)).checked).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('record lifecycle (review M2)', () => {
  it('the cron sweep refreshes resolved_at but NOT last_used_at, so an unused record still ages out', async () => {
    customWebhook('org-a', 'int-a');
    await addAllowedHost(db.d1, 'org-a', 'hooks.example.com', null, NOW);
    await verifyHostAtSend(deps(), 'org-a', 'int-a', 'hooks.example.com', NOW);
    await reresolveDueHosts(deps(), STALE);
    expect(db.raw.prepare('SELECT resolved_at, last_used_at FROM webhook_host_resolutions').get()).toEqual({
      resolved_at: STALE,
      last_used_at: NOW,
    });
    expect(await purgeStaleResolutions(db.d1, NOW + RESOLUTION_RETENTION_MS + 1)).toBe(1);
    expect(resolutionIds()).toEqual([]);
  });

  it('a send renews last_used_at', async () => {
    customWebhook('org-a', 'int-a');
    await addAllowedHost(db.d1, 'org-a', 'hooks.example.com', null, NOW);
    await verifyHostAtSend(deps(), 'org-a', 'int-a', 'hooks.example.com', NOW);
    await verifyHostAtSend(deps(), 'org-a', 'int-a', 'hooks.example.com', STALE);
    expect(db.raw.prepare('SELECT last_used_at FROM webhook_host_resolutions').get()).toEqual({
      last_used_at: STALE,
    });
  });

  it('records of a deleted or disabled integration are removed, an enabled one is kept', async () => {
    customWebhook('org-a', 'kept');
    customWebhook('org-a', 'disabled', 0);
    await addAllowedHost(db.d1, 'org-a', 'hooks.example.com', null, NOW);
    for (const id of ['kept', 'disabled', 'deleted'])
      await verifyHostAtSend(deps(), 'org-a', id, 'hooks.example.com', NOW);
    expect(await purgeStaleResolutions(db.d1, NOW)).toBe(2);
    expect(resolutionIds()).toEqual(['kept']);
  });

  it('a disabled or deleted integration is not re-resolved by the sweep', async () => {
    customWebhook('org-a', 'disabled', 0);
    await addAllowedHost(db.d1, 'org-a', 'hooks.example.com', null, NOW);
    await verifyHostAtSend(deps(), 'org-a', 'disabled', 'hooks.example.com', NOW);
    await verifyHostAtSend(deps(), 'org-a', 'deleted', 'hooks.example.com', NOW);
    const before = lookups;
    expect((await reresolveDueHosts(deps(), STALE)).checked).toBe(0);
    expect(lookups).toBe(before);
  });

  it('work per run is bounded', async () => {
    await addAllowedHost(db.d1, 'org-a', 'hooks.example.com', null, NOW);
    for (let i = 0; i < RECHECK_BATCH + 8; i += 1) {
      customWebhook('org-a', `i${i}`);
      await verifyHostAtSend(deps(), 'org-a', `i${i}`, 'hooks.example.com', NOW);
    }
    expect((await reresolveDueHosts(deps(), STALE)).checked).toBe(RECHECK_BATCH);
    for (let i = 0; i < PURGE_BATCH + 20; i += 1)
      db.raw
        .prepare(
          "INSERT INTO webhook_host_resolutions(organization_id,integration_id,host,addresses,status,resolved_at,last_used_at) VALUES('org-a',?,'hooks.example.com','[]','ok',1,1)",
        )
        .run(`orphan${i}`);
    expect(await purgeStaleResolutions(db.d1, NOW)).toBe(PURGE_BATCH);
  });
});
