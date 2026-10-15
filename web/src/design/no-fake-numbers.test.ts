import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalogues } from '../i18n';
import { scanNumericDisplay, type NumericFinding } from './numeric-display';

/**
 * No fabricated numbers (F206: "every displayed figure is read from an API"). The product
 * promise is that a figure on screen is a count, rate or time the server returned, or nothing.
 * Three things are checked:
 *
 *  1. component source (`web/src/**` .tsx, not tests or the a11y fixtures): no numeral or percent
 *     sign in JSX text, no numeric literal rendered as a child, and no `?? 0` / `|| 0` fallback
 *     that a not-yet-loaded query could turn into a zero;
 *  2. the catalogue: a sentence in a metric namespace (overview, nav, health, `*.count`) states a
 *     number only through a placeholder, except the fixed 24-hour window the summary uses;
 *  3. the scanner itself, on fixtures, so a silent break of the scan fails here.
 *
 * `ALLOWLIST` is the only way past 1. Each key is `file::kind::text`, and each value is the reason
 * the number is not a live figure. A key that no longer matches anything fails the test, so a
 * removed or changed offender cannot leave a stale excuse behind. Do not add an entry to make a
 * screen look complete: show a dash and say why (see `DeliveryStats.tsx`).
 */
const ALLOWLIST: Readonly<Record<string, string>> = {
  'pages.tsx::jsx-digits::01':
    'Step number in the three-step "Get started" list on the Overview. It is a sequence label, not a count.',
  'pages.tsx::jsx-digits::02':
    'Step number in the three-step "Get started" list on the Overview. It is a sequence label, not a count.',
  'pages.tsx::jsx-digits::03':
    'Step number in the three-step "Get started" list on the Overview. It is a sequence label, not a count.',
  'pages.tsx::numeric-fallback::summary.data?.dead_lettered ?? 0':
    'The nav link returns nothing at zero, so an unloaded summary shows no failed count, and a zero is never displayed.',
  'onboarding.tsx::numeric-fallback::me.data?.user.organizations.length ?? 0':
    'Used as a yes or no (the person already has a workspace to switch to). The number is never displayed.',
  'integrations/noise/NoiseEditor.tsx::numeric-fallback::GROUP_WINDOW_CHOICES.find((c) => String(c.value) === e.target.value)?.value ?? 0':
    'Form state for the grouping-window select, where 0 is the choice "Off". It is a setting, not a figure on screen.',
  'integrations/noise/NoiseEditor.tsx::numeric-fallback::MAX_WAIT_CHOICES.find((c) => String(c.value) === e.target.value)?.value ?? 0':
    'Form state for the maximum-wait select (ADR 0043), where 0 is the choice "Off". It is a setting, not a figure on screen.',
};

/** Catalogue keys that state the fixed summary window. Their number is checked against the server below. */
const WINDOW_KEYS: readonly string[] = ['overview.delivered', 'overview.delivered.none', 'overview.failed'];

/** Namespaces whose sentences describe data on screen; a literal number there must be a placeholder. */
const METRIC_KEY = /^(overview|nav|health)\.|\.count(\.|$)/;

const SRC = join(__dirname, '..');
const ROOT = join(SRC, '..', '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const componentFiles = walk(SRC).filter((file) => {
  const rel = relative(SRC, file).split(sep).join('/');
  return file.endsWith('.tsx') && !/\.test\.tsx$/.test(rel) && !rel.startsWith('a11y/testing');
});

const keyOf = (rel: string, finding: NumericFinding) => `${rel}::${finding.kind}::${finding.text}`;

/** Catalogue sentences, flattened: plural objects contribute each form. */
function sentences(catalogue: object): [string, string][] {
  const entries: [string, unknown][] = Object.entries(catalogue);
  return entries.flatMap(([key, value]): [string, string][] => {
    if (typeof value === 'string') return [[key, value]];
    if (value && typeof value === 'object') {
      const forms: unknown[] = Object.values(value);
      return forms.flatMap((form): [string, string][] => (typeof form === 'string' ? [[key, form]] : []));
    }
    return [];
  });
}

/** A digit or percent sign that is not inside a `{placeholder}`: a figure written into the text. */
const writtenNumber = (text: string) => /[\d%]/.test(text.replace(/\{[^}]*\}/g, ''));

/** "24 hours" in English, "24 giờ" in Vietnamese: the number is the server's, the unit is the locale's. */
const windowPattern = (hours: number) =>
  new RegExp(`(?<![\\p{L}\\d])${hours} (?:hours|giờ)(?![\\p{L}\\d])`, 'u');

/** The fixed summary window the server computes over, from `src/api/deliveries.ts`. */
function serverWindowHours(): number {
  const source = readFileSync(join(ROOT, 'src', 'api', 'deliveries.ts'), 'utf8');
  const match = /SUMMARY_WINDOW_MS\s*=\s*(\d+)\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.exec(source);
  if (!match?.[1])
    throw new Error('SUMMARY_WINDOW_MS is not a whole number of hours in src/api/deliveries.ts');
  return Number(match[1]);
}

describe('no fabricated numbers in component source (F206)', () => {
  const findings = componentFiles.flatMap((file) => {
    const rel = relative(SRC, file).split(sep).join('/');
    return scanNumericDisplay(file, readFileSync(file, 'utf8')).map((finding) => ({
      rel,
      finding,
      key: keyOf(rel, finding),
    }));
  });

  it('finds the component files (guards against a broken glob passing vacuously)', () => {
    expect(componentFiles.length).toBeGreaterThan(30);
  });

  it('every reason is a sentence, not an empty excuse', () => {
    for (const [key, reason] of Object.entries(ALLOWLIST))
      expect(reason.trim().length, key).toBeGreaterThan(40);
  });

  it('shows no number outside the allow-list', () => {
    const offenders = findings
      .filter(({ key }) => !(key in ALLOWLIST))
      .map(({ rel, finding }) => `${rel}:${finding.line} ${finding.kind} ${finding.text}`);
    expect(
      offenders,
      'a number that is not a live figure needs a reason, or a dash until the API supplies it',
    ).toEqual([]);
  });

  it('every allow-list entry still matches a finding (a stale entry is removed, not kept)', () => {
    const current = new Set(findings.map(({ key }) => key));
    expect(Object.keys(ALLOWLIST).filter((key) => !current.has(key))).toEqual([]);
  });
});

describe('catalogue sentences in metric namespaces (F206, F224)', () => {
  const windowHours = serverWindowHours();

  it('the summary window the Overview labels describe is the server window', () => {
    expect(windowHours).toBe(24);
  });

  it('a metric sentence states a number only through a placeholder, except the fixed window', () => {
    const offenders: string[] = [];
    for (const [locale, catalogue] of Object.entries(catalogues)) {
      for (const [key, text] of sentences(catalogue)) {
        if (!METRIC_KEY.test(key) || !writtenNumber(text)) continue;
        if (WINDOW_KEYS.includes(key) && windowPattern(windowHours).test(text)) continue;
        offenders.push(`${locale} ${key}: ${text}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the window labels name the server window in both locales', () => {
    for (const [locale, catalogue] of Object.entries(catalogues)) {
      const found = sentences(catalogue).filter(([key]) => WINDOW_KEYS.includes(key));
      expect(found.length, locale).toBeGreaterThanOrEqual(WINDOW_KEYS.length);
      for (const [key, text] of found) expect(text, `${locale} ${key}`).toMatch(windowPattern(windowHours));
    }
  });
});

describe('the scanner (fixtures)', () => {
  const kinds = (source: string) => scanNumericDisplay('fixture.tsx', source).map((f) => f.kind);

  it('reports digits in JSX text', () => {
    expect(kinds('const a = <p>3 failed</p>;')).toEqual(['jsx-digits']);
  });

  it('reports a numeric literal rendered as a child', () => {
    expect(kinds('const a = <strong>{12}</strong>;')).toEqual(['jsx-number']);
  });

  it('reports a percent built in a template and a digit in a string child', () => {
    expect(kinds('const a = <b>{`${pct}%`}</b>;')).toEqual(['jsx-digits']);
    expect(kinds("const a = <b>{'Step 1'}</b>;")).toEqual(['jsx-digits']);
  });

  it('reports a numeric literal in a conditional or logical branch that a child renders', () => {
    expect(kinds('const a = <b>{loaded ? count : 12}</b>;')).toEqual(['jsx-number']);
    expect(kinds('const a = <b>{loaded && 0}</b>;')).toEqual(['jsx-number']);
  });

  it('reports a numeric fallback, and the zero it renders', () => {
    expect(kinds('const a = <b>{total ?? 0}</b>;')).toEqual(['jsx-number', 'numeric-fallback']);
    expect(kinds('const total = data?.total ?? 0;')).toEqual(['numeric-fallback']);
  });

  it('does not report icon sizes, props, catalogue calls or live values', () => {
    expect(kinds('const a = <Icon size={18} aria-hidden="true" />;')).toEqual([]);
    expect(kinds('const a = <strong>{count}</strong>;')).toEqual([]);
    expect(kinds("const a = <p>{t('deliveries.count', { count })}</p>;")).toEqual([]);
  });
});
