import { describe, expect, it } from 'vitest';

// The script is plain ESM so CI can run it without a build step; it has no type declarations.
interface Exception {
  id: string;
  expires: string;
  reason?: string;
}
interface AuditGate {
  EXCEPTIONS: Exception[];
  evaluateAudit: (
    report: unknown,
    exceptions?: Exception[],
    now?: Date,
  ) => { failures: string[]; excepted: string[] };
}
const scriptPath = '../../scripts/audit-gate.mjs';
const { EXCEPTIONS, evaluateAudit } = (await import(/* @vite-ignore */ scriptPath)) as AuditGate;

const advisory = (id: string, severity: string) => ({
  source: 1,
  name: 'pkg',
  title: 'bad thing',
  url: `https://github.com/advisories/${id}`,
  severity,
});
const report = (...via: unknown[]) => ({ vulnerabilities: { pkg: { name: 'pkg', via } } });
const NOW = new Date('2026-10-13T00:00:00Z');

describe('audit gate', () => {
  it('fails on an unexcepted high or critical advisory', () => {
    const r = evaluateAudit(report(advisory('GHSA-aaaa-bbbb-cccc', 'critical')), [], NOW);
    expect(r.failures).toHaveLength(1);
  });

  it('ignores moderate and low advisories and transitive string pointers', () => {
    const r = evaluateAudit(
      report(advisory('GHSA-x', 'moderate'), advisory('GHSA-y', 'low'), 'other-pkg'),
      [],
      NOW,
    );
    expect(r).toEqual({ failures: [], excepted: [] });
  });

  it('lets a dated exception through and reports it', () => {
    const r = evaluateAudit(
      report(advisory('GHSA-aaaa', 'high')),
      [{ id: 'GHSA-aaaa', expires: '2026-12-01' }],
      NOW,
    );
    expect(r.failures).toEqual([]);
    expect(r.excepted).toHaveLength(1);
  });

  it('fails once an exception has expired', () => {
    const r = evaluateAudit(
      report(advisory('GHSA-aaaa', 'high')),
      [{ id: 'GHSA-aaaa', expires: '2026-10-01' }],
      NOW,
    );
    expect(r.failures[0]).toContain('exception expired');
  });

  it('every committed exception has a reason and an ISO expiry date', () => {
    for (const e of EXCEPTIONS) {
      expect((e.reason ?? '').length).toBeGreaterThan(20);
      expect(e.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
