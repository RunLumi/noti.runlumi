import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LOG_EVENTS, LOG_EVENT_NAMES } from '../../src/platform/log-events';
import { LOG_LINE_BUDGET_BYTES } from '../../src/platform/log';
import { replaceBlock } from '../support/authorization-doc';
import { must } from '../support/must';

/**
 * docs/LOGS.md carries the log event table generated from src/platform/log-events.ts (F194, ADR 0051),
 * so the documented catalogue cannot drift from the one `log()` accepts. To refresh after a change:
 * `npm run docs:logs`.
 */
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const DOC = join(root, 'docs', 'LOGS.md');

export function renderLogEventTable(): string {
  const rows = LOG_EVENT_NAMES.map((name) => {
    const { description, fields } = LOG_EVENTS[name];
    const listed = fields.length > 0 ? fields.map((f) => `\`${f}\``).join(', ') : 'none';
    return `| \`${name}\` | ${description} | ${listed} |`;
  });
  return ['| Event (`msg`) | What happened | Fields |', '| --- | --- | --- |', ...rows].join('\n');
}

describe('docs/LOGS.md', () => {
  it('has the generated event table, and it matches the catalogue', () => {
    const doc = readFileSync(DOC, 'utf8');
    const next = replaceBlock(doc, 'log-events', renderLogEventTable());
    expect(next, 'markers for "log-events" are missing from docs/LOGS.md').not.toBeNull();
    if (next !== doc && process.env.UPDATE_LOGS_DOC === '1') {
      writeFileSync(DOC, must(next));
      return;
    }
    expect(next === doc, 'run `npm run docs:logs` and commit the result').toBe(true);
  });

  it('states the line budget the code enforces and where to add an event', () => {
    const doc = readFileSync(DOC, 'utf8');
    expect(doc).toContain(`${LOG_LINE_BUDGET_BYTES} bytes`);
    for (const phrase of ['src/platform/log-events.ts', 'log_truncated', 'redaction_failed', 'no-console'])
      expect(doc, phrase).toContain(phrase);
  });
});
