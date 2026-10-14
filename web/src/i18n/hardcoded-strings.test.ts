import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from './index';
import { isExemptText, scanSource, scanTsStrings } from './literal-scan';

/**
 * No user-visible English in components (F224: "zero literals in components").
 *
 * The scan walks every `.tsx` under `web/src` except tests and the i18n folder itself and
 * fails on JSX text, string literals rendered in JSX, and visible string attributes
 * (`aria-label`, `placeholder`, `title`, `alt`, ...). Calls like `window.confirm('...')` are
 * checked by a separate pattern. It is a heuristic: it cannot see strings built in helpers.
 *
 * `ALLOWLIST` is the only way past it. Each entry is `file::text` plus the reason the text is
 * not translatable copy. It starts empty: every existing literal was moved to the catalogue.
 * Do not add an entry to make a screen "work"; add a message id and a Vietnamese translation.
 */
const ALLOWLIST: Readonly<Record<string, string>> = {};

/**
 * Plain `.ts` strings that read like sentences but are never shown to a person: internal
 * `ApiError` / `Error` messages. Screens show `describeError()` / `describeDeliveryError()`
 * output, which is chosen from the HTTP status and the catalogue and never from these.
 */
const INTERNAL = 'Internal error text; users see describeError() output chosen by status.';
const TS_ALLOWLIST: Readonly<Record<string, string>> = {
  'account/device.ts::Samsung Internet': 'A browser’s product name, shown as written; it is not translated.',
  'integrations/errors.ts::Missing capability': 'Compared with the server’s error text; never displayed.',
  'lib/api.ts::Network request failed': INTERNAL,
  'lib/api.ts::Request failed': INTERNAL,
  'lib/api.ts::Unexpected integration shape': INTERNAL,
  'lib/api.ts::Unexpected response': INTERNAL,
  'lib/api.ts::Unexpected routing log entry': INTERNAL,
  'lib/api.ts::Unexpected installation shape': INTERNAL,
  'lib/api.ts::Unexpected install URL': INTERNAL,
  'integrations/test/api.ts::Unexpected response': INTERNAL,
  'setup/api.ts::Unexpected response': INTERNAL,
  'sources/api.ts::Unexpected source shape': INTERNAL,
  'sources/api.ts::Unexpected response': INTERNAL,
  'workspace/api.ts::Unexpected response': INTERNAL,
  'workspace/api.ts::Network request failed': INTERNAL,
  'workspace/api.ts::Request failed': INTERNAL,
};

const SRC = join(__dirname, '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const componentFiles = walk(SRC).filter((file) => {
  const rel = relative(SRC, file).split(sep).join('/');
  return (
    file.endsWith('.tsx') &&
    !rel.startsWith('i18n/') &&
    !/\.test\.tsx$/.test(rel) &&
    !rel.startsWith('a11y/testing')
  );
});

describe('hard-coded user-visible strings', () => {
  it('finds component files to scan (guards against a broken glob passing vacuously)', () => {
    expect(componentFiles.length).toBeGreaterThan(30);
  });

  it('has none outside the allow-list', () => {
    const offenders: string[] = [];
    for (const file of componentFiles) {
      const rel = relative(SRC, file).split(sep).join('/');
      for (const hit of scanSource(file, readFileSync(file, 'utf8'))) {
        if (`${rel}::${hit.text}` in ALLOWLIST) continue;
        // A prop such as `label="filters.branches.title"` carries a catalogue id that the
        // receiving component looks up; it is not display text.
        // Only for components (`<Field label="…">`): their props are typed `MessageId` and
        // resolved by the component. A native element's attribute (`<option label=…>`) is
        // displayed as written, so an id-shaped value there is still reported.
        if (hit.kind === 'attribute' && hit.text in en && /^[A-Z]/.test(hit.tag ?? '')) continue;
        offenders.push(`${rel}:${hit.line} [${hit.kind}] ${JSON.stringify(hit.text)}`);
      }
    }
    expect(offenders, `Move these into the message catalogue:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('has no sentence-like display strings in plain .ts files outside the allow-list', () => {
    const offenders: string[] = [];
    const used = new Set<string>();
    for (const file of walk(SRC).filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f))) {
      const rel = relative(SRC, file).split(sep).join('/');
      if (rel.startsWith('i18n/') || rel.startsWith('a11y/') || rel.endsWith('.d.ts')) continue;
      for (const hit of scanTsStrings(file, readFileSync(file, 'utf8'))) {
        const key = `${rel}::${hit.text}`;
        if (key in TS_ALLOWLIST) used.add(key);
        else offenders.push(`${rel}:${hit.line} ${JSON.stringify(hit.text)}`);
      }
    }
    expect(offenders, `Move these into the catalogue or allow-list them:\n${offenders.join('\n')}`).toEqual(
      [],
    );
    expect([...used].sort(), 'stale TS allow-list entries').toEqual(Object.keys(TS_ALLOWLIST).sort());
  });

  it('has no window.confirm / alert / prompt with a literal message', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))) {
      const rel = relative(SRC, file).split(sep).join('/');
      if (rel.startsWith('i18n/')) continue;
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/\b(?:confirm|alert|prompt)\(\s*(['"`])([^'"`]*)\1/g))
        if (!isExemptText(match[2] ?? '')) offenders.push(`${rel}: ${match[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('keeps allow-list entries honest: every entry still matches something and has a reason', () => {
    for (const [key, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.length, key).toBeGreaterThan(10);
      const [rel, text] = key.split('::');
      const source = readFileSync(join(SRC, rel ?? ''), 'utf8');
      expect(
        scanSource(rel ?? '', source).some((hit) => hit.text === text),
        `stale allow-list entry ${key}`,
      ).toBe(true);
    }
  });
});

describe('message ids passed as props', () => {
  it('are exempt only on components, never on native elements', () => {
    const hits = scanSource(
      'x.tsx',
      `const A = () => <><Field label="Branches" /><option label="Branches" /></>;`,
    );
    expect(hits.map((h) => h.tag)).toEqual(['Field', 'option']);
    expect('filters.branches.title' in en).toBe(true);
  });

  it('flags the extra visible attributes and plain-TS sentences', () => {
    expect(
      scanSource(
        'x.tsx',
        `const A = () => <Box description="Save your work" heading="Welcome back" text="Click here" aria-valuetext="Half way" />;`,
      ).map((h) => h.text),
    ).toEqual(['Save your work', 'Welcome back', 'Click here', 'Half way']);
    expect(
      scanTsStrings('x.ts', `export const L = { a: 'Save changes', b: 'btn btn-primary', c: 'ok' };`).map(
        (h) => h.text,
      ),
    ).toEqual(['Save changes']);
  });
});

describe('the scanner itself', () => {
  const scan = (source: string) => scanSource('x.tsx', source).map((h) => h.text);

  it('flags JSX text, rendered literals and visible attributes', () => {
    expect(scan(`const A = () => <p>Hello there</p>;`)).toEqual(['Hello there']);
    expect(scan(`const A = ({ b }: { b: boolean }) => <p>{b ? 'Saving…' : 'Save changes'}</p>;`)).toEqual([
      'Saving…',
      'Save changes',
    ]);
    expect(scan(`const A = () => <input placeholder="Your name" aria-label="Name field" />;`)).toEqual([
      'Your name',
      'Name field',
    ]);
    expect(scan('const A = ({ n }: { n: string }) => <p>{`Hello ${n}`}</p>;')).toEqual(['Hello']);
  });

  it('ignores catalogue calls, class names, brand names and symbols', () => {
    expect(scan(`const A = () => <p className="muted card">{t('a.b')}</p>;`)).toEqual([]);
    expect(scan(`const A = () => <span>Noti</span>;`)).toEqual([]);
    expect(scan(`const A = () => <span>Lark · Slack</span>;`)).toEqual([]);
    expect(scan(`const A = () => <span>×</span>;`)).toEqual([]);
    expect(scan(`const A = () => <img alt="Lumi" />;`)).toEqual([]);
  });
});
