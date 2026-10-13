/**
 * A deliberately small CSS reader for the stylesheet tests: enough to ask "which selectors
 * set `backdrop-filter`, and inside which `@media` / `@supports`?" without a full parser
 * dependency. It understands nested at-rules, comments, and declarations; it does not
 * understand `url()` containing braces or CSS nesting, neither of which the project uses.
 */
export interface Declaration {
  readonly property: string;
  readonly value: string;
}

export interface FlatRule {
  /** Comma-separated selector list, split and trimmed. */
  readonly selectors: readonly string[];
  readonly declarations: readonly Declaration[];
  /** Enclosing at-rule preludes from outermost in, e.g. `@media (forced-colors: active)`. */
  readonly context: readonly string[];
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === separator && depth === 0) {
      parts.push(current);
      current = '';
    } else current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function parseDeclarations(body: string): Declaration[] {
  return splitTopLevel(body, ';').flatMap((part) => {
    const colon = part.indexOf(':');
    if (colon < 1) return [];
    return [{ property: part.slice(0, colon).trim().toLowerCase(), value: part.slice(colon + 1).trim() }];
  });
}

function walk(css: string, context: readonly string[], out: FlatRule[]): void {
  let index = 0;
  while (index < css.length) {
    const open = css.indexOf('{', index);
    const semicolon = css.indexOf(';', index);
    // A statement like `@import 'x';` ends before any block opens.
    if (semicolon !== -1 && (open === -1 || semicolon < open)) {
      index = semicolon + 1;
      continue;
    }
    if (open === -1) return;
    const prelude = css.slice(index, open).trim();
    let depth = 1;
    let end = open + 1;
    while (end < css.length && depth > 0) {
      if (css[end] === '{') depth += 1;
      if (css[end] === '}') depth -= 1;
      end += 1;
    }
    const body = css.slice(open + 1, end - 1);
    if (prelude.startsWith('@')) {
      if (!prelude.startsWith('@keyframes') && !prelude.startsWith('@font-face'))
        walk(body, [...context, prelude.replace(/\s+/g, ' ')], out);
    } else {
      out.push({
        selectors: splitTopLevel(prelude, ','),
        declarations: parseDeclarations(body),
        context,
      });
    }
    index = end;
  }
}

export function parseCss(css: string): FlatRule[] {
  const out: FlatRule[] = [];
  walk(stripComments(css), [], out);
  return out;
}

export function declares(rule: FlatRule, property: string): Declaration | undefined {
  return rule.declarations.find((d) => d.property === property);
}
