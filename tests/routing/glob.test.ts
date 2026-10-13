import { describe, expect, it } from 'vitest';
import { compileGlob, globMatches, GLOB_INPUT_MAX, GLOB_PATTERN_MAX } from '../../src/routing/glob';

function match(pattern: string, value: string): boolean | undefined {
  const c = compileGlob(pattern);
  if (!c.ok) throw new Error(`pattern should compile: ${pattern}`);
  return globMatches(c.glob, value);
}

describe('glob matching (F127)', () => {
  it.each([
    ['main', 'main', true],
    ['main', 'main2', false],
    ['main', 'Main', true], // case-insensitive
    ['release/*', 'release/1.0', true],
    ['release/*', 'release/1.0/hotfix', false], // * stops at /
    ['release/**', 'release/1.0/hotfix', true],
    ['release/**', 'release/', true],
    ['release/**', 'release', false],
    ['**', 'anything/at/all', true],
    ['*', 'a/b', false],
    ['*', 'ab', true],
    ['*', '', true],
    ['fix/*-rc', 'fix/foo-rc', true],
    ['fix/*-rc', 'fix/foo-rcx', false],
    ['a/**/z', 'a/b/c/z', true],
    ['a/**/z', 'a/z', false],
    ['feat-*', 'feat-', true],
    ['\\*', '*', true], // escaped star is literal
    ['\\*', 'x', false],
    ['a\\\\b', 'a\\b', true], // escaped backslash
  ])('%s vs %s -> %s', (pattern, value, expected) => {
    expect(match(pattern, value)).toBe(expected);
  });

  it('compares after NFC normalisation, so a decomposed name matches a composed pattern', () => {
    expect(match('café', 'café')).toBe(true);
  });

  it('treats an over-long value as not comparable rather than truncating it', () => {
    expect(match('**', 'a'.repeat(GLOB_INPUT_MAX + 1))).toBeUndefined();
    expect(match('**', 'a'.repeat(GLOB_INPUT_MAX))).toBe(true);
  });
});

describe('glob compilation (F127)', () => {
  it.each([
    ['empty', ''],
    ['too long', 'a'.repeat(GLOB_PATTERN_MAX + 1)],
    ['question mark', 'a?b'],
    ['character class', 'a[bc]'],
    ['brace expansion', 'a{b,c}'],
    ['plus', 'c++'],
    ['leading negation', '!main'],
    ['three stars', 'a***b'],
    ['dangling escape', 'a\\'],
    ['escape of an ordinary character', 'a\\b'],
    ['control character', 'a\u0007b'],
    ['bidi override', `a${String.fromCharCode(0x202e)}b`],
    ['too many wildcards', Array(10).fill('*').join('a')],
  ])('rejects %s', (_name, pattern) => {
    expect(compileGlob(pattern).ok).toBe(false);
  });

  it('accepts the supported syntax', () => {
    for (const p of ['main', 'release/**', 'a*b*c', 'feature/\\*literal', 'x'.repeat(GLOB_PATTERN_MAX)])
      expect(compileGlob(p).ok).toBe(true);
  });
});

describe('glob matching is linear-time on adversarial input', () => {
  it('does not backtrack catastrophically', () => {
    const pattern = compileGlob('*a*a*a*a*a*a*b'); // 6 stars: the classic exponential shape
    if (!pattern.ok) throw new Error('should compile');
    const started = performance.now();
    for (let i = 0; i < 200; i++) expect(globMatches(pattern.glob, 'a'.repeat(250))).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('handles the widest legal pattern against the longest legal value quickly', () => {
    const pattern = compileGlob('**a**a**a**a'.padEnd(GLOB_PATTERN_MAX, 'a'));
    if (!pattern.ok) throw new Error('should compile');
    const started = performance.now();
    for (let i = 0; i < 100; i++) globMatches(pattern.glob, 'a'.repeat(GLOB_INPUT_MAX) + '/');
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('rejects a megabyte of input without scanning it', () => {
    const pattern = compileGlob('**');
    if (!pattern.ok) throw new Error('should compile');
    const started = performance.now();
    expect(globMatches(pattern.glob, 'a'.repeat(1_000_000))).toBeUndefined();
    expect(compileGlob('a'.repeat(1_000_000)).ok).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
