import ts from 'typescript';

/**
 * Heuristic scan for user-visible text that bypasses the message catalogue. Test tooling, not
 * product code: it parses a TSX file and reports
 *
 *  - JSX text nodes ("<p>Hello</p>"),
 *  - string literals that are rendered directly inside JSX (`{cond ? 'Saving…' : 'Save'}`),
 *  - string-valued accessible or visible attributes (`aria-label`, `placeholder`, `title`,
 *    `alt`, `aria-description`, `aria-placeholder`, `label`).
 *
 * It is deliberately a heuristic: it cannot see text built in helper functions or hooks, and
 * it cannot tell a brand name from a sentence. Brand names and symbols are exempt by rule
 * (`isExemptText`); everything else that is intentional must be allow-listed, with a reason,
 * in `hardcoded-strings.test.ts`.
 */
export interface Literal {
  readonly text: string;
  readonly line: number;
  readonly kind: 'jsx-text' | 'jsx-expression' | 'attribute';
}

const VISIBLE_ATTRIBUTES = new Set([
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'placeholder',
  'title',
  'alt',
  'label',
]);

/** Product and provider names are the same in every language and are never translated. */
const BRAND_WORDS = new Set(['lumi', 'noti', 'github', 'lark', 'slack', 'teams', 'microsoft', 'feishu']);

/** At least two letters in a row: filters out `·`, `×`, `…`, `—`, digits and other glyphs. */
const HAS_WORD = /\p{L}{2,}/u;

export function isExemptText(text: string): boolean {
  const trimmed = text.trim();
  if (!HAS_WORD.test(trimmed)) return true;
  const words = trimmed.toLowerCase().match(/\p{L}+/gu) ?? [];
  return words.every((word) => BRAND_WORDS.has(word));
}

function stringOf(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/** String literals a JSX expression can render: through `?:`, `&&`, `||`, `??` and parens. */
function renderedStrings(node: ts.Expression): ts.Node[] {
  const text = stringOf(node);
  if (text !== null) return [node];
  if (ts.isParenthesizedExpression(node)) return renderedStrings(node.expression);
  if (ts.isConditionalExpression(node))
    return [...renderedStrings(node.whenTrue), ...renderedStrings(node.whenFalse)];
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    )
      return [...renderedStrings(node.left), ...renderedStrings(node.right)];
  }
  if (ts.isTemplateExpression(node)) return [node];
  return [];
}

function templateText(node: ts.Node): string {
  if (ts.isTemplateExpression(node))
    return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ');
  return stringOf(node) ?? '';
}

export function scanSource(fileName: string, source: string): Literal[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const found: Literal[] = [];
  const lineOf = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const add = (node: ts.Node, text: string, kind: Literal['kind']) => {
    if (!isExemptText(text)) found.push({ text: text.trim().replace(/\s+/g, ' '), line: lineOf(node), kind });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) add(node, node.text, 'jsx-text');
    else if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
      for (const literal of renderedStrings(node.expression))
        add(literal, templateText(literal), 'jsx-expression');
    } else if (ts.isJsxAttribute(node) && VISIBLE_ATTRIBUTES.has(node.name.getText(file))) {
      const init = node.initializer;
      if (init && ts.isStringLiteral(init)) add(init, init.text, 'attribute');
      else if (init && ts.isJsxExpression(init) && init.expression)
        for (const literal of renderedStrings(init.expression))
          add(literal, templateText(literal), 'attribute');
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}
