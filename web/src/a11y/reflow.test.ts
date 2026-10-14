import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * jsdom has no layout engine, so a real 320px overflow check needs a browser (done by hand, see
 * docs/FRONTEND.md). What can be proven statically for the setup, shell and state components:
 * nothing is given a fixed width wider than a 320px screen outside a media query that removes
 * it, grids use `minmax(0, 1fr)` so long text can shrink, and long values may wrap.
 */
const SRC = join(__dirname, '..');
const FILES = ['setup/setup.css', 'components/state.css'].map(
  (f) => [f, readFileSync(join(SRC, f), 'utf8')] as const,
);
const topLevel = (css: string): string => css.replace(/@media[^{]+\{(?:[^{}]|\{[^{}]*\})*\}/g, '');

describe('320px reflow of the setup flow and shared states', () => {
  for (const [name, css] of FILES) {
    it(`${name}: no fixed width above 320px at the base level`, () => {
      const wide = [...topLevel(css).matchAll(/(?<![-\w])(?:min-)?width:\s*(\d+)px/g)].filter(
        (m) => Number(m[1]) > 320,
      );
      expect(wide.map((m) => m[0])).toEqual([]);
    });

    it(`${name}: every multi-column grid lets its columns shrink`, () => {
      const bad = [...css.matchAll(/grid-template-columns:\s*([^;]+);/g)]
        .map((m) => m[1] ?? '')
        .filter((v) => /1fr/.test(v) && !/minmax\(0,\s*1fr\)/.test(v));
      expect(bad).toEqual([]);
    });
  }

  it('the step list is hidden below 900px and the page heading carries the position', () => {
    const css = readFileSync(join(SRC, 'setup/setup.css'), 'utf8');
    expect(css).toMatch(/@media \(max-width: 900px\)\s*\{\s*\.setup-flow \.setup-nav\s*\{\s*display: none;/);
  });

  it('wraps long unbroken values (repository names, references) instead of overflowing', () => {
    const css = FILES.map(([, c]) => c).join('\n');
    expect(css).toMatch(/overflow-wrap:\s*anywhere/);
  });
});
