import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LOG_EVENTS, LOG_EVENT_NAMES } from '../../src/platform/log-events';
import { isDeniedKey } from '../../src/platform/redact';

/**
 * F194 (ADR 0051): the log catalogue is closed, described and alive. The compile-time half (an unknown
 * event or undeclared field does not type-check) is pinned in tests/platform/log.test.ts.
 */
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? filesUnder(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('log event catalogue (F194)', () => {
  it('names are snake_case and sorted, so the generated table is stable', () => {
    for (const name of LOG_EVENT_NAMES) expect(name).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
    expect([...LOG_EVENT_NAMES]).toEqual([...LOG_EVENT_NAMES].sort());
  });

  it.each(LOG_EVENT_NAMES)('%s has a one-line description and well-formed fields', (name) => {
    const { description, fields } = LOG_EVENTS[name];
    expect(description).toMatch(/^[A-Z].{9,119}\.$/);
    expect(description).not.toMatch(/[\n|]/);
    expect(new Set(fields).size).toBe(fields.length);
    for (const field of fields) {
      expect(field).toMatch(/^[a-z][A-Za-z0-9_]*$/);
      // A declared field that the redactor always blanks would be documented noise, or a design smell.
      expect(isDeniedKey(field), `${name}.${field} is a denylisted key`).toBe(false);
      expect(['ts', 'level', 'msg', 'correlation_id', 'external_request_id', 'cf_ray']).not.toContain(field);
    }
  });

  it('every catalogued event is emitted somewhere in src/ (no dead entries)', () => {
    const source = filesUnder(join(root, 'src'))
      .filter((f) => !f.endsWith(join('platform', 'log-events.ts')))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    // The alert log sink builds its name from the event kind: `alert_${e.kind}`.
    const alertKinds = ['firing', 'renotify', 'resolved'];
    expect(source).toContain('`alert_${e.kind}`');
    const dead = LOG_EVENT_NAMES.filter(
      (name) => !source.includes(`'${name}'`) && !alertKinds.some((kind) => name === `alert_${kind}`),
    );
    expect(dead).toEqual([]);
  });
});
