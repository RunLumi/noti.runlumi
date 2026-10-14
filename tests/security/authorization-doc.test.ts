import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderCapabilityTable, renderRouteTable, replaceBlock } from '../support/authorization-doc';
import { must } from '../support/must';

/**
 * docs/AUTHORIZATION.md carries two generated tables (roles x capabilities, routes x guards).
 * They are rendered from the code that enforces them, so the document cannot drift. To refresh
 * after a change: `npm run docs:authorization`.
 */
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const DOC = join(root, 'docs', 'AUTHORIZATION.md');

const BLOCKS: readonly [string, () => string][] = [
  ['capabilities', renderCapabilityTable],
  ['routes', renderRouteTable],
];

describe('docs/AUTHORIZATION.md', () => {
  it('has both generated tables, and they match the code', () => {
    let doc = readFileSync(DOC, 'utf8');
    const stale: string[] = [];
    for (const [name, render] of BLOCKS) {
      const next = replaceBlock(doc, name, render());
      expect(next, `markers for "${name}" are missing from docs/AUTHORIZATION.md`).not.toBeNull();
      if (next !== doc) stale.push(name);
      doc = must(next);
    }
    if (stale.length > 0 && process.env.UPDATE_AUTHORIZATION_DOC === '1') {
      writeFileSync(DOC, doc);
      return;
    }
    expect(stale, 'run `npm run docs:authorization` and commit the result').toEqual([]);
  });

  it('states the four rules nobody may assume, and where to add a route', () => {
    const doc = readFileSync(DOC, 'utf8');
    for (const phrase of [
      'membership registry',
      'verified credential',
      '404',
      'Client-side',
      'src/auth/route-policy.ts',
    ])
      expect(doc, phrase).toContain(phrase);
  });
});
