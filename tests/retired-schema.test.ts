import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * F31: the hand-rolled identity tables from migration 0004 are retired. They stay in the
 * migration chain (already applied, forward-only), but no code may read or write them —
 * `auth_tokens` stores bearer tokens in plaintext.
 */
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const RETIRED = /\b(auth_users|auth_orgs|auth_memberships|auth_tokens|auth_invites)\b/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

describe('retired identity schema (F31)', () => {
  it('is referenced by no application or dashboard source', () => {
    const offenders = [...files(join(root, 'src')), ...files(join(root, 'web', 'src'))].filter((f) =>
      RETIRED.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
