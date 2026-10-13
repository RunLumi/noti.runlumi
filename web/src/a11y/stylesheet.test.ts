import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalogues } from '../i18n';
import { declares, parseCss, type FlatRule } from './css';

/**
 * DESIGN.md §16 and F221, asserted against the shipped CSS (not a rendering). jsdom does not
 * evaluate media queries or layout, so these tests read the stylesheets: they prove the
 * required fallbacks *exist and are wired to the right selectors*; they do not prove how a
 * browser paints them (that is the manual pass recorded in ADR 0013).
 */
const SRC = join(__dirname, '..');
const NODE_MODULES = join(__dirname, '..', '..', '..', 'node_modules');

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return path.endsWith('.css') ? [path] : [];
  });
}

const files = cssFiles(SRC).map((path) => ({
  name: relative(SRC, path),
  css: readFileSync(path, 'utf8'),
  rules: parseCss(readFileSync(path, 'utf8')),
}));
const allRules: FlatRule[] = files.flatMap((f) => f.rules);
const styles = files.find((f) => f.name === 'styles.css');

const inMedia = (rule: FlatRule, query: string) => rule.context.some((c) => c.includes(query));
const rulesIn = (query: string) => allRules.filter((r) => inMedia(r, query));
const selectorsOf = (rules: readonly FlatRule[]) => new Set(rules.flatMap((r) => r.selectors));
const backdrop = (rule: FlatRule) =>
  rule.declarations.filter((d) => d.property.endsWith('backdrop-filter') && d.value !== 'none');

describe('stylesheet discovery', () => {
  it('reads every stylesheet (guards against a vacuous pass)', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(styles?.rules.length).toBeGreaterThan(100);
  });

  it('parses nested at-rules', () => {
    const [rule] = parseCss('@media (a) { @supports (b) { .x, .y { color: red; } } }');
    expect(rule?.selectors).toEqual(['.x', '.y']);
    expect(rule?.context).toEqual(['@media (a)', '@supports (b)']);
  });
});

describe('glass and transparency (DESIGN.md §8.4)', () => {
  const glass = allRules.filter((r) => backdrop(r).length > 0);

  it('is confined to the navigation sidebar and the modal scrim', () => {
    expect(selectorsOf(glass)).toEqual(new Set(['.sidebar', '.modal-backdrop']));
  });

  it('only turns blur on inside @supports, so an unsupporting browser keeps the opaque material', () => {
    for (const rule of glass)
      expect(
        rule.context.some((c) => c.startsWith('@supports')),
        `${rule.selectors.join(',')} blurs outside @supports`,
      ).toBe(true);
  });

  it('declares an opaque background before the translucent one', () => {
    const sidebar = allRules.filter((r) => r.selectors.includes('.sidebar') && r.context.length === 0);
    const first = sidebar.find((r) => declares(r, 'background'));
    expect(first, 'no top-level .sidebar background').toBeDefined();
    expect(declares(first as FlatRule, 'background')?.value).not.toMatch(/rgba|transparent|color-mix/);
  });

  it('collapses to opaque under prefers-reduced-transparency', () => {
    const turnedOff = rulesIn('prefers-reduced-transparency: reduce').filter((r) =>
      r.declarations.some((d) => d.property === 'backdrop-filter' && d.value === 'none'),
    );
    for (const selector of ['.sidebar', '.modal-backdrop'])
      expect(selectorsOf(turnedOff), selector).toContain(selector);
  });

  it('collapses to opaque under prefers-contrast: more', () => {
    const turnedOff = rulesIn('prefers-contrast: more').filter((r) =>
      r.declarations.some((d) => d.property === 'backdrop-filter' && d.value === 'none'),
    );
    for (const selector of ['.sidebar', '.modal-backdrop'])
      expect(selectorsOf(turnedOff)).toContain(selector);
  });

  it('uses a Paper-family opaque colour for the glass fallback token, never a mid grey', () => {
    expect(styles?.css).toMatch(/--glass-bg-opaque:\s*#f9f7f2/);
  });
});

describe('reduced motion (DESIGN.md §13, WCAG 2.3.3)', () => {
  const reduced = rulesIn('prefers-reduced-motion: reduce');

  it('zeroes transitions and animations for everything, with !important', () => {
    const universal = reduced.find((r) => r.selectors.includes('*'));
    expect(universal, 'no universal reduced-motion rule').toBeDefined();
    const get = (p: string) => declares(universal as FlatRule, p)?.value ?? '';
    expect(get('animation-duration')).toMatch(/^0\.01ms !important$/);
    expect(get('transition-duration')).toMatch(/^0\.01ms !important$/);
    expect(get('animation-iteration-count')).toMatch(/^1 !important$/);
    expect(get('scroll-behavior')).toMatch(/^auto !important$/);
  });

  it('removes the 1px hover lift', () => {
    const lifted = reduced.filter((r) => declares(r, 'transform')?.value === 'none');
    expect(selectorsOf(lifted)).toContain('.btn:hover:not(:disabled)');
  });

  it('plays an animation only when the person has not asked for less motion', () => {
    for (const rule of allRules.filter((r) => declares(r, 'animation')))
      expect(
        inMedia(rule, 'prefers-reduced-motion: no-preference'),
        `${rule.selectors.join(',')} animates unconditionally`,
      ).toBe(true);
  });

  it('never requests smooth scrolling outside the no-preference query', () => {
    for (const rule of allRules.filter((r) => declares(r, 'scroll-behavior')?.value.startsWith('smooth')))
      expect(inMedia(rule, 'prefers-reduced-motion: no-preference')).toBe(true);
  });
});

describe('forced colors (Windows High Contrast, WCAG 1.4.11)', () => {
  const forced = rulesIn('forced-colors: active');
  const forcedSelectors = selectorsOf(forced);

  it('keeps explicit borders on the main surfaces and controls', () => {
    const bordered = forced.filter((r) => declares(r, 'border')?.value.includes('CanvasText'));
    for (const selector of ['.btn', '.input', '.card', '.panel', '.badge', '.nav-link'])
      expect(selectorsOf(bordered), selector).toContain(selector);
  });

  it('keeps explicit borders on the delivery drawer and integration sheets', () => {
    const bordered = selectorsOf(forced.filter((r) => declares(r, 'border')?.value.includes('CanvasText')));
    for (const selector of ['.drawer', '.integration-card', '.settings-section', '.wizard-sheet'])
      expect(bordered, selector).toContain(selector);
  });

  it('shows selection with system colours, not a background tint that would be dropped', () => {
    const selected = forced.filter((r) => r.selectors.includes('.nav-link.selected'));
    expect(selected.some((r) => declares(r, 'background')?.value === 'Highlight')).toBe(true);
    expect(selected.some((r) => declares(r, 'color')?.value === 'HighlightText')).toBe(true);
  });

  it('keeps the focus indicator visible with a system colour', () => {
    expect(forcedSelectors).toContain(':focus-visible');
    const focus = forced.find((r) => r.selectors.includes(':focus-visible'));
    expect(declares(focus as FlatRule, 'outline-color')?.value).toBe('Highlight');
  });

  it('states the switch on/off with system colours and never opts text out of adjustment', () => {
    const switchOn = forced.find((r) => r.selectors.includes(".switch[aria-checked='true']::before"));
    expect(declares(switchOn as FlatRule, 'background')?.value).toBe('Highlight');
    const optOut = allRules.filter((r) => declares(r, 'forced-color-adjust')?.value === 'none');
    // Only the logo mark, the monogram tile and the switch thumb may opt out.
    expect(selectorsOf(optOut)).toEqual(new Set(['.brand-mark', '.workspace-icon', '.switch-thumb']));
  });
});

describe('focus, target size and type size (DESIGN.md §16)', () => {
  it('draws a focus ring at least 2px wide on every focusable element', () => {
    expect(styles?.css).toMatch(/--focus-ring:\s*(\d+)px solid/);
    const width = Number(/--focus-ring:\s*(\d+)px solid/.exec(styles?.css ?? '')?.[1]);
    expect(width).toBeGreaterThanOrEqual(2);
    const base = styles?.rules.find((r) => r.selectors.includes(':focus-visible') && r.context.length === 0);
    expect(declares(base as FlatRule, 'outline')?.value).toBe('var(--focus-ring)');
  });

  it('removes an outline only on tabindex=-1 landmarks and headings', () => {
    const removed = allRules.filter((r) => /^(none|0)$/.test(declares(r, 'outline')?.value ?? ''));
    expect(selectorsOf(removed)).toEqual(new Set(["main[tabindex='-1']:focus", "h1[tabindex='-1']:focus"]));
  });

  it('sizes the touch target token at 44px and applies it to controls', () => {
    expect(styles?.css).toMatch(/--touch-target:\s*44px/);
    for (const selector of ['.btn', '.input', '.nav-link', '.modal-close']) {
      const rule = allRules.find((r) => r.selectors.includes(selector) && declares(r, 'min-height'));
      expect(rule, `${selector} has no min-height`).toBeDefined();
      expect(declares(rule as FlatRule, 'min-height')?.value).toMatch(/var\(--touch-target\)|^44px$/);
    }
  });

  it('keeps body text at 16px and never sets text below 12px', () => {
    const body = styles?.rules.find((r) => r.selectors.includes('body') && declares(r, 'font-size'));
    expect(declares(body as FlatRule, 'font-size')?.value).toBe('16px');
    for (const rule of allRules)
      for (const d of rule.declarations.filter((x) => x.property === 'font-size')) {
        const px = /^(\d+(?:\.\d+)?)px$/.exec(d.value)?.[1];
        if (px)
          expect(Number(px), `${rule.selectors.join(',')} font-size ${d.value}`).toBeGreaterThanOrEqual(12);
      }
  });
});

describe('reflow fixes found in the browser pass (WCAG 1.4.10)', () => {
  it('stacks the wizard review rows below 1100px so values are not squeezed to a few characters', () => {
    const rule = allRules.find(
      (r) => r.selectors.includes('.review .review-row') && inMedia(r, 'max-width: 1100px'),
    );
    expect(declares(rule as FlatRule, 'grid-template-columns')?.value).toBe('minmax(0, 1fr) auto');
  });

  it('lets destination option cards fill the columns that fit instead of a fixed two', () => {
    const rule = allRules.find((r) => r.selectors.includes('.destination-choice .destination-options'));
    expect(declares(rule as FlatRule, 'grid-template-columns')?.value).toMatch(/auto-fit/);
  });
});

describe('Vietnamese typography (DESIGN.md §6.2, F224)', () => {
  const vi = allRules.filter((r) => r.selectors.some((s) => s.includes(':lang(vi)')));

  it('applies Vietnamese display metrics per script, via :lang(vi), not globally', () => {
    const hero = vi.find((r) => r.selectors.includes(':lang(vi) .auth-hero h1') && r.context.length === 0);
    expect(declares(hero as FlatRule, 'line-height')?.value).toBe('1.14');
    const mobile = vi.find((r) => r.selectors.includes(':lang(vi) .auth-hero h1') && r.context.length > 0);
    expect(declares(mobile as FlatRule, 'line-height')?.value).toBe('1.13');
  });

  it('gives Vietnamese headings room for stacked tone marks and lighter tracking', () => {
    const headings = vi.find((r) => r.selectors.includes(':lang(vi) h1'));
    expect(Number(declares(headings as FlatRule, 'line-height')?.value)).toBeGreaterThanOrEqual(1.14);
    const tracking = Number(
      /(-?[\d.]+)em/.exec(declares(headings as FlatRule, 'letter-spacing')?.value ?? '')?.[1],
    );
    expect(tracking).toBeGreaterThan(-0.05);
  });

  it('does not shrink Vietnamese body text', () => {
    for (const rule of vi) expect(declares(rule, 'font-size')).toBeUndefined();
  });
});

describe('bundled Geist covers every Vietnamese character in the catalogue', () => {
  const fontCss = readFileSync(join(NODE_MODULES, '@fontsource-variable/geist/index.css'), 'utf8');
  const faces = [...fontCss.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1] ?? '');

  const ranges = faces
    .flatMap((face) => /unicode-range:\s*([^;]+);/.exec(face)?.[1]?.split(',') ?? [])
    .map((token) =>
      token
        .trim()
        .replace(/^U\+/i, '')
        .split('-')
        .map((hex) => parseInt(hex, 16)),
    )
    .map(([from, to]) => [from ?? 0, to ?? from ?? 0] as const);
  const covered = (codePoint: number) =>
    codePoint < 0x100 || ranges.some(([from, to]) => codePoint >= from && codePoint <= to);

  it('ships the Vietnamese face, swap-loaded, from the package (no font CDN)', () => {
    const vietnamese = faces.find((face) => face.includes('geist-vietnamese-wght-normal'));
    expect(vietnamese, 'no Vietnamese @font-face').toBeDefined();
    expect(vietnamese).toMatch(/font-display:\s*swap/);
    expect(vietnamese).toMatch(/U\+1EA0-1EF9/);
    for (const face of faces) expect(face).not.toMatch(/https?:\/\//);
  });

  it('is imported by the app entry point', () => {
    expect(readFileSync(join(SRC, 'routes', '__root.tsx'), 'utf8')).toMatch(
      /import '@fontsource-variable\/geist'/,
    );
    expect(styles?.css).toMatch(/--font-sans:\s*'Geist Variable'/);
  });

  it('has a glyph source for every non-Latin-1 character Vietnamese messages use', () => {
    const text = Object.values(catalogues.vi)
      .flatMap((entry) => (typeof entry === 'string' ? [entry] : Object.values(entry)))
      .join('');
    const missing = [...new Set(text.normalize('NFC'))]
      .map((char) => char.codePointAt(0) ?? 0)
      // CJK menu labels in the Lark steps are verbatim provider text; they come from the
      // Noto CJK fallbacks in --font-sans by design (DESIGN.md §6.1), not from Geist.
      .filter((cp) => !(cp >= 0x2e80 && cp <= 0x9fff) && !(cp >= 0x3000 && cp <= 0x303f))
      .filter((cp) => !covered(cp))
      .map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')} ${String.fromCodePoint(cp)}`);
    expect(missing).toEqual([]);
  });
});
