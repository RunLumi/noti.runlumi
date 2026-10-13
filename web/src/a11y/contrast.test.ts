import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LARGE_TEXT_MINIMUM,
  TEXT_MINIMUM,
  UI_MINIMUM,
  colourTokens,
  contrastRatio,
  parseHex,
  relativeLuminance,
} from './contrast';

/**
 * Contrast of the DESIGN.md palette, as pairs the product actually draws (F221, WCAG 1.4.3 and
 * 1.4.11). jsdom has no layout or computed colour, so axe's `color-contrast` rule cannot run
 * in the component tests (see `axe.ts`); this pure test is what covers it, and the rendered
 * result is covered by the in-browser axe run recorded in ADR 0013.
 *
 * Tokens are read from the stylesheet and compared with the canonical block in DESIGN.md §5,
 * so a drifting token fails here before a ratio is computed on a wrong value.
 */
const ROOT = join(__dirname, '..', '..', '..');
const tokens = colourTokens(readFileSync(join(ROOT, 'web/src/styles.css'), 'utf8'));
const canonical = colourTokens(readFileSync(join(ROOT, 'DESIGN.md'), 'utf8'));

type Kind = 'text' | 'large-text' | 'ui';
interface Pair {
  readonly fg: string;
  readonly bg: string;
  readonly kind: Kind;
  readonly usage: string;
}

/** A token name, or a literal `#rrggbb` for the white used on solid buttons. */
const aliases: Readonly<Record<string, string>> = { '--color-control-border': '--color-soft-slate' };
const resolve = (value: string): string =>
  value.startsWith('#') ? value : (tokens[aliases[value] ?? value] ?? value);
const minimum = (kind: Kind): number =>
  kind === 'text' ? TEXT_MINIMUM : kind === 'large-text' ? LARGE_TEXT_MINIMUM : UI_MINIMUM;

const PAIRS: readonly Pair[] = [
  // Body and headings
  { fg: '--color-ink', bg: '--color-paper-white', kind: 'text', usage: 'body text on the page canvas' },
  { fg: '--color-ink', bg: '--color-surface-white', kind: 'text', usage: 'body text on a sheet' },
  { fg: '--color-ink', bg: '--color-archive-gray', kind: 'text', usage: 'hovered nav link and ghost button' },
  { fg: '--color-civic-navy', bg: '--color-paper-white', kind: 'text', usage: 'headings on the canvas' },
  { fg: '--color-civic-navy', bg: '--color-surface-white', kind: 'text', usage: 'headings on a sheet' },
  // Secondary text
  {
    fg: '--color-soft-slate',
    bg: '--color-paper-white',
    kind: 'text',
    usage: 'muted text, nav links on the canvas',
  },
  { fg: '--color-soft-slate', bg: '--color-surface-white', kind: 'text', usage: 'muted text on a sheet' },
  { fg: '--color-soft-slate', bg: '--color-archive-gray', kind: 'text', usage: 'neutral badge' },
  {
    fg: '--color-soft-slate',
    bg: '#f9f7f2',
    kind: 'text',
    usage: 'opaque sidebar fallback (glass-bg-opaque)',
  },
  // Lumi Blue as authority
  {
    fg: '--color-lumi-blue',
    bg: '--color-surface-white',
    kind: 'text',
    usage: 'links and secondary actions',
  },
  { fg: '--color-lumi-blue', bg: '--color-paper-white', kind: 'text', usage: 'links on the canvas' },
  { fg: '--color-lumi-blue', bg: '--color-lumi-blue-soft', kind: 'text', usage: 'avatar, workspace tile' },
  { fg: '--color-lumi-blue-active', bg: '--color-lumi-blue-soft', kind: 'text', usage: 'selected nav link' },
  { fg: '#ffffff', bg: '--color-lumi-blue', kind: 'text', usage: 'primary button' },
  { fg: '#ffffff', bg: '--color-lumi-blue-hover', kind: 'text', usage: 'primary button, hover' },
  { fg: '#ffffff', bg: '--color-lumi-blue-active', kind: 'text', usage: 'primary button, pressed' },
  // Status colours
  { fg: '--color-risk-red', bg: '--color-surface-white', kind: 'text', usage: 'error text on a sheet' },
  { fg: '--color-risk-red', bg: '--color-paper-white', kind: 'text', usage: 'error text on the canvas' },
  { fg: '--color-risk-red', bg: '--color-red-soft', kind: 'text', usage: 'error notice' },
  { fg: '#ffffff', bg: '--color-risk-red', kind: 'text', usage: 'danger button' },
  { fg: '--color-success-green', bg: '--color-surface-white', kind: 'text', usage: 'success text' },
  { fg: '--color-success-green', bg: '--color-green-soft', kind: 'text', usage: 'success badge' },
  {
    fg: '--color-ink',
    bg: '--color-amber-soft',
    kind: 'text',
    usage: 'warning notice body (Ink, never amber text)',
  },
  // Non-text: UI components and graphical objects (1.4.11)
  { fg: '--color-lumi-blue', bg: '--color-paper-white', kind: 'ui', usage: 'focus ring on the canvas' },
  { fg: '--color-lumi-blue', bg: '--color-surface-white', kind: 'ui', usage: 'focus ring on a sheet' },
  { fg: '--color-lumi-blue', bg: '--color-archive-gray', kind: 'ui', usage: 'focus ring on hovered rows' },
  {
    fg: '--color-soft-slate',
    bg: '--color-surface-white',
    kind: 'ui',
    usage: 'icons, control outlines in high contrast',
  },
  { fg: '--color-risk-red', bg: '--color-surface-white', kind: 'ui', usage: 'error icon and rail' },
  { fg: '--color-success-green', bg: '--color-surface-white', kind: 'ui', usage: 'success icon' },
  { fg: '--color-civic-navy', bg: '--color-paper-white', kind: 'ui', usage: 'icons in headings' },
  // Control boundaries: an empty text field is identified by its edge alone.
  {
    fg: '--color-control-border',
    bg: '--color-surface-white',
    kind: 'ui',
    usage: 'text field edge on a sheet',
  },
  {
    fg: '--color-control-border',
    bg: '--color-paper-white',
    kind: 'ui',
    usage: 'text field edge on the canvas',
  },
  // Known gaps: no canonical colour reaches 3:1 here. See ACCEPTED.
  { fg: '--color-border-strong', bg: '--color-surface-white', kind: 'ui', usage: 'switch track edge' },
  { fg: '--color-signal-amber', bg: '--color-surface-white', kind: 'ui', usage: 'warning severity rail' },
];

/**
 * Pairs that do not reach their minimum with canonical colours. Each is a recorded, reasoned
 * deviation (ADR 0013), pinned to its exact ratio so a token change cannot hide behind it.
 * Nothing is added here to make a build pass: the entry must name why DESIGN.md leaves no
 * compliant canonical colour and what covers the gap.
 */
const ACCEPTED: Readonly<Record<string, { readonly ratio: number; readonly reason: string }>> = {
  '--color-border-strong on --color-surface-white [ui]': {
    ratio: 1.55,
    reason:
      'Switch track edge. The switch always shows its state as the words On / Paused and by thumb position, so the edge is not the only cue (1.4.1). No canonical colour is both quiet and 3:1.',
  },
  '--color-signal-amber on --color-surface-white [ui]': {
    ratio: 2.03,
    reason:
      'The 3px amber severity rail beside a warning. Meaning is carried by an icon and text in every use (1.4.1); the rail is reinforcement. Amber is never used for text.',
  },
};

const key = (pair: Pair) => `${pair.fg} on ${pair.bg} [${pair.kind}]`;

describe('palette tokens', () => {
  it('match the canonical block in DESIGN.md §5 exactly', () => {
    expect(Object.keys(canonical).length).toBeGreaterThanOrEqual(18);
    for (const [name, value] of Object.entries(canonical))
      expect(tokens[name], `${name} drifted from DESIGN.md`).toBe(value);
  });
});

describe('WCAG arithmetic', () => {
  it('reproduces the spec’s anchor values', () => {
    expect(relativeLuminance(parseHex('#ffffff'))).toBe(1);
    expect(relativeLuminance(parseHex('#000000'))).toBe(0);
    expect(contrastRatio('#000000', '#ffffff')).toBe(21);
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1);
    // #767676 on white is the well-known smallest grey that passes 4.5:1.
    expect(contrastRatio('#767676', '#ffffff')).toBe(4.54);
    expect(contrastRatio('#777777', '#ffffff')).toBe(4.47);
  });

  it('is symmetric in its arguments', () => {
    expect(contrastRatio('#006093', '#ffffff')).toBe(contrastRatio('#ffffff', '#006093'));
  });
});

describe('palette contrast as drawn', () => {
  for (const pair of PAIRS) {
    const name = key(pair);
    it(`${pair.usage}: ${name}`, () => {
      const ratio = contrastRatio(resolve(pair.fg), resolve(pair.bg));
      const accepted = ACCEPTED[name];
      if (accepted) {
        expect(ratio, `${name} no longer fails; remove it from ACCEPTED`).toBeLessThan(minimum(pair.kind));
        expect(ratio).toBe(accepted.ratio);
      } else {
        expect(ratio, `${name} = ${ratio}:1, needs ${minimum(pair.kind)}:1`).toBeGreaterThanOrEqual(
          minimum(pair.kind),
        );
      }
    });
  }
});

describe('control borders', () => {
  const css = readFileSync(join(ROOT, 'web/src/styles.css'), 'utf8');

  it('resolve --color-control-border to a canonical Lumi value, not a new colour', () => {
    expect(css).toMatch(/--color-control-border:\s*var\(--color-soft-slate\)/);
  });

  it('are used by text fields and selects', () => {
    expect(css).toMatch(/\.input\s*\{[^}]*border:\s*1px solid var\(--color-control-border\)/);
    expect(css).toMatch(/\.role-select\s*\{[^}]*border:\s*1px solid var\(--color-control-border\)/);
  });
});
