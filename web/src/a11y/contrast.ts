/**
 * WCAG 2.2 contrast arithmetic (1.4.3 Contrast Minimum, 1.4.11 Non-text Contrast) as pure
 * functions, so the DESIGN.md palette can be checked in a unit test without a browser.
 * Reference: https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio
 */
export type Rgb = readonly [number, number, number];

export function parseHex(hex: string): Rgb {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match?.[1]) throw new Error(`Not a 6-digit hex colour: ${hex}`);
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function channel(value: number): number {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Ratio in 1..21, rounded down to two decimals the way the spec's thresholds are applied. */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(parseHex(foreground));
  const b = relativeLuminance(parseHex(background));
  const [light, dark] = a >= b ? [a, b] : [b, a];
  return Math.floor(((light + 0.05) / (dark + 0.05)) * 100) / 100;
}

/** `--color-name: #rrggbb;` declarations of the first `:root` block that defines them. */
export function colourTokens(css: string): Readonly<Record<string, string>> {
  const tokens: Record<string, string> = {};
  for (const match of css.matchAll(/(--color-[a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    const [, name, value] = match;
    if (name && value && !(name in tokens)) tokens[name] = value.toLowerCase();
  }
  return tokens;
}

export const TEXT_MINIMUM = 4.5;
export const LARGE_TEXT_MINIMUM = 3;
export const UI_MINIMUM = 3;
