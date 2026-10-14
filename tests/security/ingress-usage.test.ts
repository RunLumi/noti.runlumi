import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { INGRESS_USAGE_SQL, recordIngressUsage, usageDay } from '../../src/security/ingress-usage';
import { createFakeD1, seedOrganization } from '../support/d1';

const T0 = Date.UTC(2026, 9, 13, 23, 59, 59);

const rows = (raw: ReturnType<typeof createFakeD1>['raw']) =>
  raw
    .prepare(
      'SELECT organization_id AS org, day, source, events_accepted AS a, events_duplicate AS d, events_rate_limited AS r FROM ingress_usage ORDER BY org, day, source',
    )
    .all();

describe('ingress usage accounting (F29)', () => {
  it('counts per workspace, UTC day and source, and adds up within a day', async () => {
    const { d1, raw } = createFakeD1();
    seedOrganization(raw, 'org-a');
    seedOrganization(raw, 'org-b');
    await recordIngressUsage(d1, 'org-a', 'github', { accepted: 1 }, T0);
    await recordIngressUsage(d1, 'org-a', 'github', { accepted: 1 }, T0);
    await recordIngressUsage(d1, 'org-a', 'github', { duplicate: 1 }, T0);
    await recordIngressUsage(d1, 'org-a', 'github', { rateLimited: 1 }, T0);
    await recordIngressUsage(d1, 'org-a', 'generic', { accepted: 1 }, T0);
    await recordIngressUsage(d1, 'org-b', 'github', { accepted: 1 }, T0);
    // Past UTC midnight is a new day.
    await recordIngressUsage(d1, 'org-a', 'github', { accepted: 1 }, T0 + 2000);
    expect(rows(raw)).toEqual([
      { org: 'org-a', day: '2026-10-13', source: 'generic', a: 1, d: 0, r: 0 },
      { org: 'org-a', day: '2026-10-13', source: 'github', a: 2, d: 1, r: 1 },
      { org: 'org-a', day: '2026-10-14', source: 'github', a: 1, d: 0, r: 0 },
      { org: 'org-b', day: '2026-10-13', source: 'github', a: 1, d: 0, r: 0 },
    ]);
    expect(usageDay(T0)).toBe('2026-10-13');
  });

  it('writes nothing for an empty delta', async () => {
    const { d1, raw } = createFakeD1();
    seedOrganization(raw, 'org-a');
    await recordIngressUsage(d1, 'org-a', 'github', {}, T0);
    expect(rows(raw)).toEqual([]);
  });

  it('never throws: a failed write is logged as a source name only and the caller carries on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing = {
      prepare: () => ({
        bind: () => ({
          run: () => Promise.reject(new Error('D1 down: secret-token-123')),
        }),
      }),
    } as unknown as D1Database;
    await expect(
      recordIngressUsage(failing, 'org-a', 'github', { accepted: 1 }, T0),
    ).resolves.toBeUndefined();
    const line = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(line).toContain('ingress_usage_write_failed');
    expect(line).not.toContain('secret-token');
    warn.mockRestore();
  });

  it('is separate from the abuse limiter: shares no table with it (F29, F231)', async () => {
    const source = readFileSync('src/security/ingress-usage.ts', 'utf8');
    expect(source.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('api_rate_limits');
    expect(INGRESS_USAGE_SQL).not.toContain('api_rate_limits');
    const { d1, raw } = createFakeD1();
    seedOrganization(raw, 'org-a');
    await recordIngressUsage(d1, 'org-a', 'github', { accepted: 1 }, T0);
    expect((raw.prepare('SELECT COUNT(*) AS n FROM api_rate_limits').get() as { n: number }).n).toBe(0);
  });

  it('keys every row by the workspace and cascades when the workspace is deleted', async () => {
    const { d1, raw } = createFakeD1();
    seedOrganization(raw, 'org-a');
    await recordIngressUsage(d1, 'org-a', 'github', { accepted: 1 }, T0);
    raw.prepare('DELETE FROM organization WHERE id=?').run('org-a');
    expect(rows(raw)).toEqual([]);
  });
});
