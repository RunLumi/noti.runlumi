import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from './index';
import { isExemptText, scanSource } from './literal-scan';

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
        if (hit.kind === 'attribute' && hit.text in en) continue;
        offenders.push(`${rel}:${hit.line} [${hit.kind}] ${JSON.stringify(hit.text)}`);
      }
    }
    expect(offenders, `Move these into the message catalogue:\n${offenders.join('\n')}`).toEqual([]);
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
  it('are recognised by the catalogue, so a mistyped id is not silently skipped', () => {
    expect('filters.branches.title' in en).toBe(true);
    expect('filters.branches.titel' in en).toBe(false);
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
