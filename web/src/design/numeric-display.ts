import ts from 'typescript';

/**
 * Heuristic scan for numbers a person could read as data (F206: "no fabricated numbers").
 * Test tooling, not product code. It parses a TSX file and reports
 *
 *  - `jsx-digits`: JSX text, or a string or template rendered as a child, that contains a digit
 *    or a percent sign (`<strong>12</strong>`, `{`${pct}%`}`);
 *  - `jsx-number`: a numeric literal rendered as a child (`<strong>{0}</strong>`). A numeric
 *    literal in an attribute (`size={18}`) is an icon size, not a figure, and is not reported;
 *  - `numeric-fallback`: `x ?? 0` or `x || 0`, where the left side is not yet loaded data and a
 *    zero would stand in for it.
 *
 * It cannot tell a live figure from a fixed policy number, and it cannot see a fallback that is
 * assigned to a variable before it is rendered. Those are why the test pairs it with an
 * allow-list that states the reason for each entry, and why a new finding fails the build.
 */
export type NumericKind = 'jsx-digits' | 'jsx-number' | 'numeric-fallback';

export interface NumericFinding {
  readonly kind: NumericKind;
  /** Source text of the offending node, whitespace collapsed and capped; the allow-list key. */
  readonly text: string;
  readonly line: number;
}

const MAX_TEXT = 120;

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

function stringValues(node: ts.Expression): string[] | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node))
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
  return null;
}

/**
 * The leaves a JSX child can render: through `?:`, `&&`, `||`, `??` and parentheses. A condition
 * is included too, because `0 && x` renders the zero.
 */
function renderedLeaves(node: ts.Expression): ts.Expression[] {
  if (ts.isParenthesizedExpression(node)) return renderedLeaves(node.expression);
  if (ts.isConditionalExpression(node))
    return [...renderedLeaves(node.whenTrue), ...renderedLeaves(node.whenFalse)];
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    )
      return [...renderedLeaves(node.left), ...renderedLeaves(node.right)];
  }
  return [node];
}

export function scanNumericDisplay(fileName: string, source: string): NumericFinding[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const found: NumericFinding[] = [];
  const add = (node: ts.Node, kind: NumericKind, text: string) =>
    found.push({
      kind,
      text: collapse(text).slice(0, MAX_TEXT),
      line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
    });

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node) && /[\d%]/.test(node.text)) add(node, 'jsx-digits', node.text);

    if (
      ts.isJsxExpression(node) &&
      node.expression &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      for (const leaf of renderedLeaves(node.expression)) {
        if (ts.isNumericLiteral(leaf)) add(leaf, 'jsx-number', leaf.getText(file));
        const values = stringValues(leaf);
        if (values && values.some((value) => /[\d%]/.test(value)))
          add(leaf, 'jsx-digits', leaf.getText(file));
      }
    }

    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
      ts.isNumericLiteral(node.right)
    )
      add(node, 'numeric-fallback', node.getText(file));

    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}
