import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCss } from '../a11y/css';
import { cssBlocksUnder, declarationsIn, familyList, normaliseValue, resolveVars } from './design-md';

/**
 * Design-token drift (F206, ADR 0038): the tokens DESIGN.md states must be the values the
 * shipped stylesheet (`web/src/styles.css`, imported by `routes/__root.tsx`) resolves to.
 *
 * Source of truth: the fenced ```css blocks under DESIGN.md §5 (colour), §6.1 (type stacks),
 * §7 (spacing scale), §8.1 (radii), §8.3 and §8.4 (elevation, glass), plus the §8.2 and §13
 * sentences that state a border, focus or motion width. Nothing here is typed in by hand: a
 * value changed in DESIGN.md fails this file until the CSS follows, and a value changed in the
 * CSS fails it until DESIGN.md is changed too. The two documented exceptions are listed below
 * with their reasons; a new exception needs a new reason, not a wider comparison.
 */
const ROOT = join(__dirname, '..', '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const designMd = read('DESIGN.md');
const stylesCss = read('web/src/styles.css');
const rootRoute = read('web/src/routes/__root.tsx');

/** The family the self-hosted package (`@fontsource-variable/geist`) registers; DESIGN.md says "Geist". */
const BUNDLED_GEIST_FAMILY = 'geist variable';

/**
 * Colour names the stylesheet declares that DESIGN.md does not, each mapped to the exact value
 * it must have. `--color-control-border` is the WCAG 1.4.11 edge of a text field (3:1 needed; the
 * archival border is 1.35:1), reusing the canonical Soft Slate value. It is not a new colour.
 */
const COLOUR_ALIASES: Readonly<Record<string, string>> = {
  '--color-control-border': 'var(--color-soft-slate)',
};

/** The top-level `:root` declarations of the shipped stylesheet, and any custom property declared twice. */
const rootRules = parseCss(stylesCss).filter(
  (rule) => rule.context.length === 0 && rule.selectors.includes(':root'),
);
const shipped: Record<string, string> = {};
const duplicates: string[] = [];
for (const rule of rootRules)
  for (const declaration of rule.declarations) {
    if (!declaration.property.startsWith('--')) continue;
    if (declaration.property in shipped) duplicates.push(declaration.property);
    shipped[declaration.property] = declaration.value;
  }

function shippedValue(name: string): string {
  const value = shipped[name];
  if (value === undefined) throw new Error(`${name} is not declared in a top-level :root of styles.css`);
  return value;
}

function required(value: string | undefined, what: string): string {
  if (value === undefined) throw new Error(`DESIGN.md does not state ${what}`);
  return value;
}

const section = (number: string) => cssBlocksUnder(designMd, number).flatMap(declarationsIn);
const resolved = (name: string) => normaliseValue(resolveVars(shippedValue(name), shipped));

describe('colour tokens (DESIGN.md §5)', () => {
  const designColours = Object.fromEntries(
    section('5')
      .filter((d) => d.property.startsWith('--color-'))
      .map((d) => [d.property, normaliseValue(d.value)]),
  );

  it('reads the canonical palette (guards against an empty parse)', () => {
    expect(Object.keys(designColours).length).toBeGreaterThanOrEqual(19);
  });

  it.each(Object.entries(designColours))('%s is the value DESIGN.md states', (name, value) => {
    expect(resolved(name)).toBe(value);
  });

  it('declares no colour that DESIGN.md does not define, apart from the documented aliases', () => {
    const unknown = Object.keys(shipped).filter(
      (name) => name.startsWith('--color-') && !(name in designColours) && !(name in COLOUR_ALIASES),
    );
    expect(unknown, 'colour tokens with no DESIGN.md value').toEqual([]);
    for (const [name, target] of Object.entries(COLOUR_ALIASES)) {
      expect(shipped[name], `${name} alias`).toBe(target);
      const colour = normaliseValue(resolveVars(shippedValue(name), shipped));
      expect(Object.values(designColours), `${name} must resolve to a canonical colour`).toContain(colour);
    }
  });
});

describe('typography (DESIGN.md §6.1)', () => {
  const stacks = Object.fromEntries(
    section('6.1')
      .filter((d) => d.property.startsWith('--font-'))
      .map((d) => [d.property, d.value]),
  );

  it('reads both family stacks', () => {
    expect(Object.keys(stacks).sort()).toEqual(['--font-mono', '--font-sans']);
  });

  it('the sans stack is the DESIGN.md stack, led by the bundled Geist family', () => {
    const designSans = familyList(required(stacks['--font-sans'], 'a sans stack'));
    expect(familyList(shippedValue('--font-sans'))).toEqual([BUNDLED_GEIST_FAMILY, ...designSans]);
  });

  it('the mono stack is the DESIGN.md stack', () => {
    expect(familyList(shippedValue('--font-mono'))).toEqual(
      familyList(required(stacks['--font-mono'], 'a mono stack')),
    );
  });

  it('the leading family is the one the self-hosted package registers', () => {
    const fontCss = readFileSync(join(ROOT, 'node_modules/@fontsource-variable/geist/index.css'), 'utf8');
    expect(fontCss).toMatch(/font-family:\s*'Geist Variable';/);
    expect(familyList(shippedValue('--font-sans'))[0]).toBe(BUNDLED_GEIST_FAMILY);
  });
});

describe('spacing (DESIGN.md §7)', () => {
  const scaleBlocks = cssBlocksUnder(designMd, '7').filter((block) =>
    /^\s*\d+(?:\s*·\s*\d+)+\s*$/.test(block),
  );
  const scale = (scaleBlocks[0] ?? '').split('·').map((step) => Number(step.trim()));
  const spacing = Object.entries(shipped).filter(([name]) => name.startsWith('--space-'));

  it('finds exactly one scale block in §7 (guards against a moved or duplicated scale)', () => {
    expect(scaleBlocks).toHaveLength(1);
    expect(scale.length).toBeGreaterThanOrEqual(10);
  });

  it('every --space-N token is N × 4px, the naming the scale uses', () => {
    expect(spacing.length).toBeGreaterThan(0);
    for (const [name, value] of spacing)
      expect(value, name).toBe(`${Number(name.slice('--space-'.length)) * 4}px`);
  });

  it('the set of spacing values equals the DESIGN.md scale', () => {
    const shippedSteps = spacing.map(([, value]) => Number(value.replace(/px$/, ''))).sort((a, b) => a - b);
    expect(shippedSteps).toEqual([...scale].sort((a, b) => a - b));
  });
});

describe('radius (DESIGN.md §8.1)', () => {
  const ranges = cssBlocksUnder(designMd, '8.1')
    .filter((block) => /^\s*\d+px\b/m.test(block))
    .flatMap((block) => block.split('\n'))
    .map((line) => /^\s*(\d+)(?:–(\d+))?px\b/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => [Number(match[1]), Number(match[2] ?? match[1])] as const)
    .sort((a, b) => a[0] - b[0]);

  it('reads the radius scale (guards against an empty parse)', () => {
    expect(ranges.length).toBeGreaterThanOrEqual(8);
  });

  it('the shipped radii are the DESIGN.md scale, one for one (a range admits any value inside it)', () => {
    const shippedRadii = Object.entries(shipped)
      .filter(([name]) => name.startsWith('--radius-'))
      .map(([name, value]) => ({ name, px: Number(/^(\d+)px$/.exec(value)?.[1]) }))
      .sort((a, b) => a.px - b.px);
    expect(shippedRadii).toHaveLength(ranges.length);
    ranges.forEach(([low, high], index) => {
      const radius = shippedRadii[index];
      expect(radius?.px, `${radius?.name} against DESIGN.md ${low}–${high}px`).toBeGreaterThanOrEqual(low);
      expect(radius?.px, `${radius?.name} against DESIGN.md ${low}–${high}px`).toBeLessThanOrEqual(high);
    });
  });
});

describe('elevation and glass (DESIGN.md §8.3, §8.4)', () => {
  const elevation = Object.fromEntries(section('8.3').map((d) => [d.property, d.value]));

  it.each(['--shadow-card', '--shadow-button'])('%s is the value DESIGN.md states', (name) => {
    expect(resolved(name)).toBe(normaliseValue(required(elevation[name], name)));
  });

  // The §8.4 block states the opaque material first, then the @supports-only values. The first
  // declaration of each property is the opaque one, which is the one the token must carry.
  const glass = declarationsIn(cssBlocksUnder(designMd, '8.4')[0] ?? '');
  const firstOf = (property: string) => glass.find((d) => d.property === property)?.value;

  it.each([
    ['--glass-bg-opaque', 'background'],
    ['--glass-border', 'border'],
    ['--glass-shadow', 'box-shadow'],
  ])('%s is the opaque glass value DESIGN.md states (%s)', (token, property) => {
    expect(resolved(token)).toBe(normaliseValue(required(firstOf(property), `${property} in §8.4`)));
  });
});

describe('borders, focus and motion (DESIGN.md §8.2, §13)', () => {
  const width = (pattern: RegExp, what: string) =>
    Number(required(pattern.exec(designMd)?.[1], `the ${what} width`));

  it('border, focus and severity-rail widths match §8.2', () => {
    const archival = width(/(\d+)px archival borders/, 'archival border');
    const focus = width(/(\d+)px focus ring/, 'focus ring');
    const rail = width(/(\d+)px semantic severity rail/, 'severity rail');
    expect(shippedValue('--border-archival')).toMatch(new RegExp(`^${archival}px solid `));
    expect(shippedValue('--focus-ring')).toMatch(new RegExp(`^${focus}px solid `));
    expect(shippedValue('--rail-severity')).toMatch(new RegExp(`^${rail}px solid$`));
  });

  it('transition durations sit inside the hover and focus range §13 allows', () => {
    const match = /(\d+)–(\d+)ms hover\/focus transitions/.exec(designMd);
    const low = Number(required(match?.[1], 'the transition range'));
    const high = Number(required(match?.[2], 'the transition range'));
    const durations = Object.entries(shipped).filter(([name]) => name.startsWith('--transition-'));
    expect(durations.length).toBeGreaterThan(0);
    for (const [name, value] of durations) {
      const ms = Number(/^(\d+)ms\b/.exec(value)?.[1]);
      expect(ms, name).toBeGreaterThanOrEqual(low);
      expect(ms, name).toBeLessThanOrEqual(high);
    }
  });
});

describe('the shipped stylesheet', () => {
  it('reads its top-level :root block (guards against a vacuous pass)', () => {
    expect(rootRules.length).toBeGreaterThan(0);
  });

  it('declares every custom property once, so the value that ships is not decided by source order', () => {
    expect(duplicates).toEqual([]);
  });

  it('is the stylesheet the application imports', () => {
    expect(rootRoute).toMatch(/import appCss from '\.\.\/styles\.css\?url';/);
  });
});
