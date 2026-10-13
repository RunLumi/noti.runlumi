import axe, { type AxeResults, type Result } from 'axe-core';

/**
 * axe-core adapter for the jsdom component tests (F221: "fail the build on serious or critical").
 *
 * What this can and cannot check, plainly:
 *
 *  - It runs axe's DOM and ARIA rules against the rendered markup: names and roles, labels,
 *    landmarks, headings, duplicate ids, ARIA validity, table structure, link and button
 *    names, language, and so on.
 *  - `color-contrast` is switched off. jsdom performs no layout and no CSS cascade for
 *    external stylesheets, so axe cannot resolve foreground and background colours and would
 *    either skip or guess. Contrast is covered by `contrast.test.ts` (palette pairs) and by
 *    the in-browser axe run recorded in ADR 0013.
 *  - Rules that need real layout (`target-size`, `scrollable-region-focusable`, overlap,
 *    reflow, text spacing, zoom) cannot be evaluated either; those are manual or in-browser.
 *  - Automated rules find a minority of WCAG failures. A clean run is a floor, not a claim of
 *    conformance (F221).
 */
export const BLOCKING_IMPACTS: readonly string[] = ['serious', 'critical'];

/** Rules jsdom cannot evaluate; kept explicit so nobody believes they were checked. */
export const RULES_NOT_CHECKED_IN_JSDOM: readonly string[] = ['color-contrast', 'target-size'];

export interface Audit {
  readonly blocking: readonly Result[];
  /** Everything axe found, including moderate and minor, for the test log. */
  readonly all: readonly Result[];
}

export async function audit(root: Element = document.body): Promise<Audit> {
  const results: AxeResults = await axe.run(root, {
    rules: Object.fromEntries(RULES_NOT_CHECKED_IN_JSDOM.map((id) => [id, { enabled: false }])),
    resultTypes: ['violations'],
  });
  return {
    all: results.violations,
    blocking: results.violations.filter((v) => v.impact && BLOCKING_IMPACTS.includes(v.impact)),
  };
}

/** A readable failure message: rule, impact, help URL, and the offending markup. */
export function describeViolations(violations: readonly Result[]): string {
  return violations
    .map(
      (v) =>
        `${v.impact ?? '?'} ${v.id}: ${v.help}\n  ${v.helpUrl}\n` +
        v.nodes.map((n) => `  - ${n.target.join(' ')}\n    ${n.html.slice(0, 200)}`).join('\n'),
    )
    .join('\n');
}
