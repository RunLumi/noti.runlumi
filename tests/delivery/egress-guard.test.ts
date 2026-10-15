import { beforeEach, describe, expect, it } from 'vitest';
import {
  HARD_REQUESTS_PER_MINUTE,
  INTEGRATION_INVALID_BUDGET,
  INVALID_TRIP,
  LIGHT_TENANT_REQUESTS,
  OPEN_MS,
  REQUESTS_PER_MINUTE,
  TENANT_INVALID_BUDGET,
  TENANT_REQUESTS_PER_MINUTE,
  faultCount,
  guardGate,
  purgeEgressBuckets,
  recordEgress,
  type GuardScope,
} from '../../src/delivery/egress-guard';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 30);
let db: FakeD1;
const A: GuardScope = { organizationId: 'org-a', integrationId: 'int-a' };

beforeEach(() => {
  db = createFakeD1();
  for (const o of ['org-a', 'org-b', 'org-c']) seedOrganization(db.raw, o);
});

async function record(n: number, status: number | null, scope: GuardScope = A, at = NOW): Promise<void> {
  for (let i = 0; i < n; i += 1) await recordEgress(db.d1, 'discord', scope, at, status);
}
const gate = (scope: GuardScope = A, at = NOW) => guardGate(db.d1, 'discord', scope, at);
const globalRow = () =>
  db.raw
    .prepare(
      'SELECT COALESCE(SUM(requests),0) AS requests, COALESCE(SUM(invalid),0) AS invalid FROM egress_guard_buckets',
    )
    .get() as {
    requests: number;
    invalid: number;
  };

/** Put the platform at the trip point with invalid answers spread over enough workspaces (each within budget). */
function seedGlobalInvalid(n: number, at = NOW): void {
  db.raw
    .prepare(
      'INSERT INTO egress_guard_buckets(provider,minute_start,requests,invalid) VALUES(?,?,?,?) ON CONFLICT(provider,minute_start) DO UPDATE SET requests = requests + excluded.requests, invalid = invalid + excluded.invalid',
    )
    .run('discord', Math.floor(at / 60_000) * 60_000, n, n);
}

describe('Discord global guard (F108)', () => {
  it('proceeds on an empty table', async () => {
    expect(await gate()).toEqual({ action: 'proceed' });
  });

  it('counts only 401, 403 and 429 as invalid, in the global and the tenant rows', async () => {
    await record(3, 200);
    await record(1, 401);
    await record(1, 403);
    await record(1, 429);
    await record(2, 404);
    await record(1, null);
    expect(globalRow()).toEqual({ requests: 9, invalid: 3 });
    expect(db.raw.prepare('SELECT requests, invalid FROM egress_guard_tenant_buckets').get()).toEqual({
      requests: 9,
      invalid: 3,
    });
  });

  it('opens at the trip point, for every caller, and stays open for OPEN_MS', async () => {
    seedGlobalInvalid(INVALID_TRIP - 1);
    expect((await gate()).action).toBe('proceed');
    seedGlobalInvalid(1, NOW + 1000);
    const g = await gate({ organizationId: 'org-b', integrationId: 'x' });
    expect(g).toEqual({ action: 'defer', untilMs: NOW + OPEN_MS, reason: 'platform_paused' });
    expect((await gate(A, NOW + 60_000)).action).toBe('defer');
    const state = db.raw.prepare('SELECT opened_count FROM egress_guard_state').get() as {
      opened_count: number;
    };
    expect(state.opened_count).toBe(1);
  });

  it('closes after OPEN_MS because the counted responses have aged out, and trips again if they return', async () => {
    seedGlobalInvalid(INVALID_TRIP);
    await gate();
    const later = NOW + OPEN_MS + 1;
    expect((await gate(A, later)).action).toBe('proceed');
    seedGlobalInvalid(INVALID_TRIP, later);
    expect((await gate(A, later)).action).toBe('defer');
    expect(
      (db.raw.prepare('SELECT opened_count FROM egress_guard_state').get() as { opened_count: number })
        .opened_count,
    ).toBe(2);
  });

  it('does not count invalid answers older than ten minutes', async () => {
    seedGlobalInvalid(INVALID_TRIP, NOW - 11 * 60_000);
    expect((await gate()).action).toBe('proceed');
  });

  it('fails open, counts the fault, and a recording fault never throws', async () => {
    db.raw.exec('DROP TABLE egress_guard_state');
    expect(await gate()).toEqual({ action: 'proceed' });
    const row = db.raw.prepare("SELECT value FROM ops_state WHERE key='egress_guard_fault'").get() as {
      value: string;
    };
    expect(faultCount(row.value, NOW)).toBe(1);
    await gate();
    const again = db.raw.prepare("SELECT value FROM ops_state WHERE key='egress_guard_fault'").get() as {
      value: string;
    };
    expect(faultCount(again.value, NOW)).toBe(2);
    expect(faultCount(again.value, NOW + 16 * 60_000)).toBe(0);
    const broken = {
      prepare: () => {
        throw new Error('d1 down');
      },
      batch: () => {
        throw new Error('d1 down');
      },
    } as unknown as D1Database;
    await expect(recordEgress(broken, 'discord', A, NOW, 429)).resolves.toBeUndefined();
    expect(await guardGate(broken, 'discord', A, NOW)).toEqual({ action: 'proceed' });
  });

  it('the GLOBAL tables carry no tenant data', () => {
    for (const table of ['egress_guard_buckets', 'egress_guard_state']) {
      const cols = (db.raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
        (c) => c.name,
      );
      expect(cols.filter((c) => /org|integration|host|url|tenant|workspace/i.test(c))).toEqual([]);
    }
  });

  it('purges buckets past retention, global and per workspace', async () => {
    await record(1, 200, A, NOW - 3 * 3_600_000);
    await record(1, 200, A, NOW);
    expect(await purgeEgressBuckets(db.d1, NOW)).toBe(2);
    expect(globalRow().requests).toBe(1);
  });
});

describe('a tenant cannot open the global breaker for everyone (H1)', () => {
  it('an attacker with 100 integrations on one webhook is held on its own budget and adds only its budget to the global count', async () => {
    for (let i = 0; i < 100; i += 1) {
      const scope = { organizationId: 'org-a', integrationId: `atk-${i}` };
      // Every send is gated first, like the consumer: once the workspace is over budget nothing more is sent.
      for (let k = 0; k < 20; k += 1) {
        if ((await gate(scope)).action === 'proceed') await record(1, 429, scope);
      }
    }
    // The attacker stopped at its workspace budget, not at 100 x 20.
    expect(
      (
        db.raw
          .prepare("SELECT SUM(invalid) AS n FROM egress_guard_tenant_buckets WHERE organization_id='org-a'")
          .get() as { n: number }
      ).n,
    ).toBeLessThanOrEqual(TENANT_INVALID_BUDGET + 1);
    expect(globalRow().invalid).toBeLessThanOrEqual(TENANT_INVALID_BUDGET + 1);
    expect(globalRow().invalid).toBeLessThan(INVALID_TRIP);
    // The global breaker is NOT open, and a second workspace keeps delivering.
    const other = { organizationId: 'org-b', integrationId: 'honest' };
    expect(await gate(other)).toEqual({ action: 'proceed' });
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM egress_guard_state').get()).toEqual({ n: 0 });
    // The attacker, however, is held with the workspace reason.
    expect(await gate({ organizationId: 'org-a', integrationId: 'atk-0' })).toMatchObject({
      action: 'defer',
      reason: 'workspace_paused',
    });
  });

  it('one integration over its own budget is held while its workspace siblings still send', async () => {
    const bad = { organizationId: 'org-a', integrationId: 'dead-token' };
    await record(INTEGRATION_INVALID_BUDGET, 401, bad);
    expect(await gate(bad)).toMatchObject({ action: 'defer', reason: 'workspace_paused' });
    expect(await gate({ organizationId: 'org-a', integrationId: 'fine' })).toEqual({ action: 'proceed' });
  });

  it('invalid answers beyond a workspace budget are NOT added to the global count', async () => {
    await record(TENANT_INVALID_BUDGET + 30, 429, A);
    expect(globalRow().invalid).toBeLessThanOrEqual(TENANT_INVALID_BUDGET);
  });

  it('a workspace over budget is released when its answers age out of the window', async () => {
    await record(TENANT_INVALID_BUDGET, 401, { organizationId: 'org-a', integrationId: 'x' });
    expect((await gate({ organizationId: 'org-a', integrationId: 'y' })).action).toBe('defer');
    expect((await gate({ organizationId: 'org-a', integrationId: 'y' }, NOW + 11 * 60_000)).action).toBe(
      'proceed',
    );
  });
});

describe('fair share of the pacing cap (H1b)', () => {
  it('a workspace is limited to its own share of a minute and released at the next minute', async () => {
    await record(TENANT_REQUESTS_PER_MINUTE, 200);
    expect(await gate()).toMatchObject({ action: 'defer', reason: 'workspace_paused' });
    expect((await gate(A, NOW + 60_000)).action).toBe('proceed');
  });

  it('a heavy tenant cannot starve a light one: at the soft cap only light workspaces are admitted', async () => {
    const heavy = { organizationId: 'org-a', integrationId: 'h' };
    db.raw
      .prepare('INSERT INTO egress_guard_buckets(provider,minute_start,requests,invalid) VALUES(?,?,?,0)')
      .run('discord', Math.floor(NOW / 60_000) * 60_000, REQUESTS_PER_MINUTE);
    // The heavy workspace has already used its light allowance this minute.
    db.raw
      .prepare(
        "INSERT INTO egress_guard_tenant_buckets(organization_id,integration_id,provider,minute_start,requests,invalid) VALUES('org-a','h','discord',?,?,0)",
      )
      .run(Math.floor(NOW / 60_000) * 60_000, LIGHT_TENANT_REQUESTS);
    expect(await gate(heavy)).toMatchObject({ action: 'defer', reason: 'platform_paused' });
    expect(await gate({ organizationId: 'org-b', integrationId: 'light' })).toEqual({ action: 'proceed' });
  });

  it('nothing is admitted above the documented hard limit, even for a light workspace', async () => {
    db.raw
      .prepare('INSERT INTO egress_guard_buckets(provider,minute_start,requests,invalid) VALUES(?,?,?,0)')
      .run('discord', Math.floor(NOW / 60_000) * 60_000, HARD_REQUESTS_PER_MINUTE);
    expect(await gate({ organizationId: 'org-b', integrationId: 'light' })).toMatchObject({
      action: 'defer',
      reason: 'platform_paused',
    });
  });

  it('starvation: many heavy workspaces at the soft cap still leave a light workspace delivering every minute', async () => {
    for (const o of ['org-a', 'org-b', 'org-c']) {
      for (let m = 0; m < 3; m += 1) {
        const at = NOW + m * 60_000;
        // each heavy workspace sends until its own gate says stop
        let sent = 0;
        while (
          sent < 1000 &&
          (await gate({ organizationId: o, integrationId: 'h' }, at)).action === 'proceed'
        ) {
          await record(1, 200, { organizationId: o, integrationId: 'h' }, at);
          sent += 1;
        }
        expect(sent).toBeLessThanOrEqual(TENANT_REQUESTS_PER_MINUTE);
      }
    }
    seedOrganization(db.raw, 'org-light');
    for (let m = 0; m < 3; m += 1)
      expect((await gate({ organizationId: 'org-light', integrationId: 'l' }, NOW + m * 60_000)).action).toBe(
        'proceed',
      );
  });
});
