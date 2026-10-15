import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface File {
  name: string;
  text: string;
}
interface Checks {
  checkAdrs: (files: File[]) => string[];
  checkAdrUrls: (files: File[]) => string[];
  checkSourcedDecisions: (files: File[]) => string[];
  checkControlIds: (i: { threatModel: string; specs: File[]; others: File[] }) => string[];
  loadRepo: () => { adrs: File[]; specs: File[]; others: File[]; threatModel: string };
}
const scriptPath = '../../scripts/check-docs.mjs';
const { checkAdrs, checkAdrUrls, checkSourcedDecisions, checkControlIds, loadRepo } = (await import(
  /* @vite-ignore */ scriptPath
)) as Checks;
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const good = (n: string, extra = '') =>
  `# ADR ${n}: A title\n\nStatus: Accepted · Date: 2026-10-14\n\n## Context\n\nc\n\n## Decision\n\nd\n\n## Consequences\n\nx\n\n## Revisit when\n\nr\n${extra}`;
const adr = (n: string, text = good(n)) => ({ name: `${n}-some-slug.md`, text });

describe('ADR check', () => {
  it('accepts a complete ADR and a gap in numbering', () => {
    expect(checkAdrs([adr('0031'), adr('0033')])).toEqual([]);
  });
  it('rejects a duplicate number', () => {
    const dup = { name: '0031-other-slug.md', text: good('0031') };
    expect(checkAdrs([adr('0031'), dup]).join('\n')).toContain('number 0031 is also used');
  });
  it('rejects a bad file name, a mismatched heading and a missing status', () => {
    expect(checkAdrs([{ name: 'adr-1.md', text: good('0001') }]).join('\n')).toContain('file name');
    expect(checkAdrs([adr('0031', good('0032'))]).join('\n')).toContain('heading says ADR 0032');
    expect(checkAdrs([adr('0031', good('0031').replace('Status: Accepted', 'Date:'))]).join('\n')).toContain(
      'Status:',
    );
  });
  it('rejects a missing Decision, and missing strict headings from the strict number on', () => {
    expect(checkAdrs([adr('0031', good('0031').replace('## Decision', '## Choice'))]).join('\n')).toContain(
      '## Decision',
    );
    const out = checkAdrs([adr('0031', good('0031').replace('## Revisit when', '## Later'))]).join('\n');
    expect(out).toContain('Revisit when');
    // The same omission is tolerated in an older ADR.
    expect(checkAdrs([adr('0010', good('0010').replace('## Revisit when', '## Later'))])).toEqual([]);
  });
  it('holds the real docs/adr directory to the rules', () => {
    expect(checkAdrs(loadRepo().adrs)).toEqual([]);
  });
});

describe('ADR URL check (offline, no network)', () => {
  const url = (text: string) => checkAdrUrls([{ name: '0040-x.md', text }]);
  it('accepts https URLs in plain, autolink, markdown-link and code-span forms', () => {
    expect(url('See https://developers.cloudflare.com/d1/platform/limits/ for limits.')).toEqual([]);
    expect(url('Read <https://developers.cloudflare.com/queues/reference/delivery-guarantees/>.')).toEqual(
      [],
    );
    expect(url('[D1](https://developers.cloudflare.com/d1/platform/limits/)')).toEqual([]);
    expect(url('`https://discord.com/api/webhooks/{id}/{token}`')).toEqual([]);
    expect(url('wiki: https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual([]);
  });
  it('rejects http and reports the line', () => {
    const out = url('ok\nsee http://example.com/x for details');
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('0040-x.md:2');
    expect(out[0]).toContain('must use https');
  });
  it('rejects a URL that does not parse', () => {
    expect(url('a bare scheme: https:// and nothing else').join('\n')).toContain('is not a valid URL');
  });
  it('rejects trailing punctuation picked up from the prose', () => {
    expect(
      url('see https://developers.cloudflare.com/queues/reference/delivery-guarantees/, then').join('\n'),
    ).toContain('ends in punctuation');
    expect(url('the page https://example.com/a.').join('\n')).toContain('ends in punctuation');
  });
  it('rejects whitespace inside a markdown link destination', () => {
    expect(url('[x](https://example.com/a )').join('\n')).toContain('contains whitespace');
  });
  it('holds the real docs/adr directory to the rules', () => {
    expect(checkAdrUrls(loadRepo().adrs)).toEqual([]);
  });
});

describe('sourced decision ADR check', () => {
  const adr = (name: string, text: string) => ({ name, text });
  const all = (withSource: boolean) =>
    ['0031', '0032', '0033', '0034', '0035'].map((n) =>
      adr(
        `${n}-x.md`,
        withSource ? 'Claim: https://developers.cloudflare.com/d1/platform/limits/' : 'No link here',
      ),
    );
  it('accepts each of ADRs 0031 to 0035 when it cites an https source', () => {
    expect(checkSourcedDecisions(all(true))).toEqual([]);
  });
  it('rejects a decision ADR with no source, and a missing one', () => {
    const out = checkSourcedDecisions(all(false)).join('\n');
    expect(out).toContain('ADR 0031: cites no https:// source');
    expect(checkSourcedDecisions(all(true).slice(1)).join('\n')).toContain('ADR 0031: missing');
  });
  it('reports only the sourced ADRs that are absent, ignoring other ADRs', () => {
    const out = checkSourcedDecisions([adr('0036-x.md', 'no link')]);
    expect(out).toHaveLength(5);
    expect(out.join('\n')).not.toContain('0036');
  });
  it('holds the real ADRs 0031 to 0035 to the rule', () => {
    expect(checkSourcedDecisions(loadRepo().adrs)).toEqual([]);
  });
});

describe('control ID check', () => {
  const tm = (rows: string, extra = '') => `${extra}\n| ID | Risk |\n${rows}\n`;
  const spec = (...ids: string[]) => ({
    name: 'docs/specs/01-x.md',
    text: ids.map((i) => `## ${i} — t\n`).join(''),
  });
  it('accepts consistent IDs', () => {
    const input = {
      threatModel: tm('| AR-1 | a |\n| AR-2 | b |', 'See F22 and AR-2.'),
      specs: [spec('F22')],
      others: [],
    };
    expect(checkControlIds(input)).toEqual([]);
  });
  it('rejects a duplicate AR row, an undefined citation, and an unknown F id', () => {
    const dup = checkControlIds({ threatModel: tm('| AR-1 | a |\n| AR-1 | b |'), specs: [], others: [] });
    expect(dup.join('\n')).toContain('AR-1 is defined twice');
    const undef = checkControlIds({
      threatModel: tm('| AR-1 | a |'),
      specs: [],
      others: [{ name: 'docs/X.md', text: 'see AR-9' }],
    });
    expect(undef.join('\n')).toContain('docs/X.md: cites AR-9');
    const f = checkControlIds({ threatModel: tm('| AR-1 | a |', 'F999'), specs: [spec('F22')], others: [] });
    expect(f.join('\n')).toContain('F999');
  });
  it('rejects a spec heading used twice', () => {
    const input = { threatModel: tm('| AR-1 | a |'), specs: [spec('F22', 'F22')], others: [] };
    expect(checkControlIds(input).join('\n')).toContain('F22 is also a heading');
  });
  it('holds the real threat model and every citation to the rules', () => {
    expect(checkControlIds(loadRepo())).toEqual([]);
  });
});

describe('supply-chain CI wiring', () => {
  const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  it('installs without lifecycle scripts and checks registry signatures', () => {
    for (const line of ci.split('\n').filter((l) => /run: npm ci/.test(l))) {
      expect(line).toContain('--ignore-scripts');
    }
    expect(ci).toContain('npm audit signatures');
  });
});
