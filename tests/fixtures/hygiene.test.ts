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
const all = files(FIXTURE_DIR).filter((f) => /\.(json|md)$/.test(f));

// Built from pieces so this file itself holds no secret-shaped literal.
const DENY: readonly [string, RegExp][] = [
  ['OpenAI-style key', new RegExp('sk-' + '[A-Za-z0-9]{20,}')],
  ['GitHub token', new RegExp('gh[pousr]_' + '[A-Za-z0-9]{36}')],
  ['GitHub fine-grained token', new RegExp('github_pat_' + '[A-Za-z0-9_]{20,}')],
  ['GitLab token', new RegExp('glpat-' + '[A-Za-z0-9_-]{16,}')],
  ['Slack token', new RegExp('xox[abprs]-' + '[A-Za-z0-9-]{10,}')],
  ['AWS access key', new RegExp('AKIA' + '[0-9A-Z]{16}')],
  ['Stripe key', new RegExp('[sr]k_(live|test)_' + '[A-Za-z0-9]{10,}')],
  ['Stripe signing secret', new RegExp('whsec' + '_[A-Za-z0-9+/=_-]{16,}')],
  ['JWT', new RegExp('eyJ' + '[A-Za-z0-9_-]{8,}\\.eyJ' + '[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}')],
  ['private key block', new RegExp('-----BEGIN [A-Z ]*' + 'PRIVATE KEY-----')],
  ['bearer credential', /Bearer\s+[A-Za-z0-9._-]{16,}/],
  ['Slack webhook URL', new RegExp('hooks\\.slack\\.com/' + 'services/')],
  ['Discord webhook URL', new RegExp('discord(app)?\\.com/api/' + 'webhooks/\\d')],
  ['Teams or Power Automate webhook URL', new RegExp('(logic\\.azure\\.com/' + 'workflows|webhook\\.office\\.com/' + 'webhookb2)')],
  ['Lark or Feishu bot webhook URL', new RegExp('open\\.(larksuite\\.com|feishu\\.cn)/open-apis/bot/' + 'v2/hook')],
  ['invisible text control', /[\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff\u061c]|[\u{e0000}-\u{e007f}]/u],
];

/**
 * The only addresses allowed: the ones that appear verbatim in the providers' published examples,
 * listed exactly, and the reserved example domain. A new address has to be added here on purpose.
 */
const EMAIL_OK = new Set([
  'git@github.com',
  'noreply@github.com',
  '21031067+Codertocat@users.noreply.github.com',
  'matfax@users.noreply.github.com',
  'git@gitlab.example.com',
  'user@gitlab.com',
  'user_email@gitlab.com',
  'jordi@softcatala.org',
]);
const emailAllowed = (email: string): boolean => EMAIL_OK.has(email) || /@example\.com$/.test(email);

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

  it('every email address is one the provider published, listed exactly, or on example.com', () => {
    const bad: string[] = [];
    for (const f of all) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]+/g))
        if (!emailAllowed(m[0])) bad.push(`${f.slice(FIXTURE_DIR.length)}: ${m[0]}`);
    }
    expect(bad).toEqual([]);
  });
});
