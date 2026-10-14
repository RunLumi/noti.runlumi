import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { JOB_NAMES } from '../../src/observability/cadence';
import { ALERTS, runbookAnchor, runbookHeading } from '../../src/observability/alerts/registry';
import { createFakeD1 } from '../support/d1';

/**
 * F201: an alert without a runbook entry is an alert nobody knows how to act on. The runbook is
 * checked against the registry in both directions, and its job table against the cadence table.
 */
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const runbook = readFileSync(join(root, 'docs/RUNBOOK.md'), 'utf8');

/** The text under a `### Alert: <id>` heading, up to the next heading. */
function section(id: string): string {
  const start = runbook.indexOf(`### ${id}\n`);
  if (start < 0) return '';
  const rest = runbook.slice(start + id.length + 5);
  const end = rest.search(/\n#{2,3} /);
  return end < 0 ? rest : rest.slice(0, end);
}

describe('alert-to-runbook', () => {
  it('every alert has its own runbook section with a real body', () => {
    for (const a of ALERTS) {
      const body = section(runbookHeading(a.id));
      expect(
        body.length,
        `${a.id}: missing or empty "### ${runbookHeading(a.id)}" in docs/RUNBOOK.md`,
      ).toBeGreaterThan(80);
      expect(body, a.id).toContain(a.severity);
    }
  });

  it('has no runbook section for an alert that does not exist', () => {
    const documented = [...runbook.matchAll(/^### Alert: ([a-z_]+)$/gm)].map((m) => m[1]);
    expect(documented.sort()).toEqual(ALERTS.map((a) => a.id).sort());
  });

  it('the anchor an alert message links to is the heading GitHub generates', () => {
    for (const a of ALERTS) {
      const generated = runbookHeading(a.id)
        .toLowerCase()
        .replace(/[^a-z0-9_\- ]/g, '')
        .replace(/ /g, '-');
      expect(runbookAnchor(a.id)).toBe(generated);
    }
  });

  it('names every cron job of the cadence table, and no job it does not schedule', () => {
    const table = runbook.slice(runbook.indexOf('## Cron jobs'), runbook.indexOf('## Alerts'));
    const listed = [...table.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
    expect(listed.sort()).toEqual([...JOB_NAMES].sort());
  });

  it('documents the thresholds it can: the dead-letter and drop windows match the code', () => {
    expect(section('Alert: dead_letter_spike')).toContain('20');
    expect(section('Alert: cron_heartbeat_missing')).toContain('five minutes');
  });
});

describe('the alert tables exist where the runbook queries them', () => {
  const { raw } = createFakeD1();
  it.each(['job_runs', 'alert_state', 'destination_health', 'delivery_attempts', 'ops_state'])(
    '%s',
    (table) => {
      expect(raw.prepare('SELECT name FROM sqlite_master WHERE name=?').get(table)).toBeDefined();
    },
  );

  it('every SQL block of the new sections is valid against the migrated schema', () => {
    const from = runbook.indexOf('## Cron jobs');
    const to = runbook.indexOf('## Stuck outbox');
    const blocks = [...runbook.slice(from, to).matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
    expect(blocks.length).toBeGreaterThanOrEqual(10);
    for (const block of blocks) {
      const statements = block
        .replace(/^--.*$/gm, '')
        .split(/;\s*$/m)
        .map((s) => s.trim().replace(/<id>/g, 'x'))
        .filter(Boolean);
      for (const statement of statements) expect(() => raw.prepare(statement).all(), statement).not.toThrow();
    }
  });

  it('the runbook correlation lookup runs against the schema', () => {
    const sql = `SELECT 'delivery' AS kind, id, organization_id, state, created_at FROM deliveries WHERE correlation_id = 'x'
UNION ALL SELECT 'outbox', id, organization_id, state, created_at FROM notification_outbox WHERE correlation_id = 'x'
UNION ALL SELECT 'attempt', delivery_id, organization_id, outcome, datetime(started_at/1000,'unixepoch')
FROM delivery_attempts WHERE correlation_id = 'x'`;
    expect(raw.prepare(sql).all()).toEqual([]);
  });
});
