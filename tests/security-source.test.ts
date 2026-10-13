import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Trojan Source guard: invisible bidirectional controls must be written as `\uXXXX`
 * escapes, never as raw characters, so reviewers can see what a regex rejects.
 */
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const BIDI = /[‎‏‪-‮⁦-⁩]/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

describe('source hygiene', () => {
  it('contains no raw bidirectional control characters', () => {
    const sources = [...files(join(root, 'src')), ...files(join(root, 'web', 'src'))].filter((f) =>
      /\.(ts|tsx|css)$/.test(f),
    );
    expect(sources.filter((f) => BIDI.test(readFileSync(f, 'utf8')))).toEqual([]);
  });
});
