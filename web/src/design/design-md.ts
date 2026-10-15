import { parseCss, type Declaration } from '../a11y/css';

/**
 * Reads the machine-checkable parts of `DESIGN.md` (test tooling, not product code).
 *
 * DESIGN.md states its tokens as fenced ```css blocks under numbered headings (`# 5.`, `## 8.4`).
 * This reader finds the heading for a section number, returns that section's CSS blocks, and
 * throws when the heading is missing or holds no block: a renamed or moved section must fail the
 * drift test, not turn it into a pass over nothing.
 */
const HEADING = /^(#{1,6})\s+/;

function headingLevel(line: string): number | null {
  const match = HEADING.exec(line);
  return match?.[1]?.length ?? null;
}

/** The CSS fenced blocks under the heading numbered `section` (`'5'`, `'6.1'`, `'8.4'`). */
export function cssBlocksUnder(markdown: string, section: string): string[] {
  const lines = markdown.split('\n');
  const escaped = section.replace(/\./g, '\\.');
  const start = lines.findIndex((line) => new RegExp(`^#{1,6}\\s+${escaped}\\.?\\s`).test(line));
  if (start === -1) throw new Error(`DESIGN.md has no heading for section ${section}`);
  const level = headingLevel(lines[start] ?? '') ?? 1;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const next = headingLevel(lines[i] ?? '');
    if (next !== null && next <= level) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end).join('\n');
  const blocks = [...body.matchAll(/```css\n([\s\S]*?)```/g)].map((match) => match[1] ?? '');
  if (blocks.length === 0) throw new Error(`DESIGN.md section ${section} has no css block`);
  return blocks;
}

/** Declarations in a CSS block, in order. A block is wrapped in a rule so the stylesheet reader can parse it. */
export function declarationsIn(block: string): Declaration[] {
  return parseCss(`:root {\n${block}\n}`).flatMap((rule) => rule.declarations);
}

/** Collapses whitespace and the spaces around punctuation, so two spellings of one value compare equal. */
export function normaliseValue(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .trim()
    .toLowerCase();
}

/** Splits a font stack at its top-level commas and strips quotes: `'Geist Variable', geist` -> `['geist variable', 'geist']`. */
export function familyList(stack: string): string[] {
  return stack
    .split(',')
    .map((family) =>
      family
        .trim()
        .replace(/^['"]|['"]$/g, '')
        .replace(/\s+/g, ' ')
        .toLowerCase(),
    )
    .filter(Boolean);
}

/** Replaces `var(--name)` with the value it resolves to, through `tokens`, up to a small depth. */
export function resolveVars(value: string, tokens: Readonly<Record<string, string>>, depth = 0): string {
  if (depth > 8) throw new Error(`var() chain too deep resolving ${value}`);
  const replaced = value.replace(/var\((--[\w-]+)\)/g, (_, name: string) => {
    const next = tokens[name];
    if (next === undefined) throw new Error(`${name} is referenced but not declared in :root`);
    return next;
  });
  return replaced.includes('var(') ? resolveVars(replaced, tokens, depth + 1) : replaced;
}
