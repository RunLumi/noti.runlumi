import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURE_DIR } from './load';

/**
 * Fixture hygiene (spec 05 F72, spec 06 F79): a fixture is committed data that may be copied from
 * a provider's documentation or a capture, so it is scanned for secret shapes, personal data and
 * invisible text controls. The scan reads every file under tests/fixtures, goldens included.
 */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}
const all = files(FIXTURE_DIR).filter((f) => f.endsWith('.json'));

// Built from pieces so this file itself holds no secret-shaped literal.
const DENY: readonly [string, RegExp][] = [
  ['OpenAI-style key', new RegExp('sk-' + '[A-Za-z0-9]{20,}')],
  ['GitHub token', new RegExp('gh[pousr]_' + '[A-Za-z0-9]{36}')],
  ['GitHub fine-grained token', new RegExp('github_pat_' + '[A-Za-z0-9_]{20,}')],
  ['AWS access key', new RegExp('AKIA' + '[0-9A-Z]{16}')],
  ['Stripe live or restricted key', new RegExp('[sr]k_live_' + '[A-Za-z0-9]{10,}')],
  ['Stripe signing secret', new RegExp('whsec' + '_[A-Za-z0-9+/=_-]{16,}')],
  ['private key block', new RegExp('-----BEGIN [A-Z ]*' + 'PRIVATE KEY-----')],
  ['bearer credential', /Bearer\s+[A-Za-z0-9._-]{16,}/],
  ['Slack webhook URL', new RegExp('hooks\\.slack\\.com/' + 'services/')],
  ['bidirectional control', /[‎‏‪-‮⁦-⁩]/],
];

/** Addresses that appear in the providers' published examples or are reserved for examples. */
const EMAIL_OK = /@(example\.com|gitlab\.example\.com|github\.com|users\.noreply\.github\.com|gitlab\.com|softcatala\.org)$/;

describe('fixtures contain no secrets, no invisible controls and no real personal data', () => {
  it('finds fixtures to scan', () => {
    expect(all.length).toBeGreaterThan(50);
  });

  for (const [name, pattern] of DENY) {
    it(`no ${name}`, () => {
      const hits = all.filter((f) => pattern.test(readFileSync(f, 'utf8'))).map((f) => f.slice(FIXTURE_DIR.length));
      expect(hits).toEqual([]);
    });
  }

  it('every email address is one the provider published or an example domain', () => {
    const bad: string[] = [];
    for (const f of all) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]+/g))
        if (!EMAIL_OK.test(m[0])) bad.push(`${f.slice(FIXTURE_DIR.length)}: ${m[0]}`);
    }
    expect(bad).toEqual([]);
  });
});
