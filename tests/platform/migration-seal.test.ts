import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface Seal {
  hashMigration: (text: string) => string;
  checkSeal: (files: Record<string, string>, manifest: Record<string, string>) => string[];
  compareToBase: (base: Record<string, string>, current: Record<string, string>) => string[];
  renderManifest: (hashes: Record<string, string>) => string;
}
const libPath = '../../scripts/lib/migration-seal.mjs';
const { hashMigration, checkSeal, compareToBase, renderManifest } = (await import(
  /* @vite-ignore */ libPath
)) as Seal;

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

describe('checkSeal', () => {
  const files = { '0001_a.sql': 'CREATE TABLE a(x);', '0002_b.sql': 'CREATE TABLE b(x);' };
  const sealed = {
    '0001_a.sql': hashMigration(files['0001_a.sql']),
    '0002_b.sql': hashMigration(files['0002_b.sql']),
  };

  it('accepts an untouched, fully sealed chain', () => {
    expect(checkSeal(files, sealed)).toEqual([]);
  });

  it('rejects an edit to a sealed migration and points at a new migration', () => {
    const problems = checkSeal({ ...files, '0001_a.sql': 'CREATE TABLE a(x, y);' }, sealed);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/0001_a\.sql: changed after it was sealed.*new migration/);
  });

  it('rejects deleting a sealed migration', () => {
    expect(checkSeal({ '0001_a.sql': files['0001_a.sql'] }, sealed)).toEqual([
      expect.stringContaining('0002_b.sql: sealed but missing'),
    ]);
  });

  it('rejects a migration nobody sealed', () => {
    expect(checkSeal({ ...files, '0003_c.sql': 'SELECT 1;' }, sealed)).toEqual([
      expect.stringContaining('0003_c.sql: not sealed'),
    ]);
  });

  it('allows a gap in numbering but not a repeated or out-of-order number', () => {
    const gap = { '0001_a.sql': 'x', '0003_c.sql': 'y' };
    expect(checkSeal(gap, { '0001_a.sql': hashMigration('x'), '0003_c.sql': hashMigration('y') })).toEqual(
      [],
    );
    const dup = { '0001_a.sql': 'x', '0001_b.sql': 'y' };
    expect(
      checkSeal(dup, { '0001_a.sql': hashMigration('x'), '0001_b.sql': hashMigration('y') }).join('\n'),
    ).toMatch(/0001_b\.sql: number 0001 is not greater/);
  });

  it('rejects a name that is not NNNN_snake_case.sql', () => {
    expect(checkSeal({ 'bad.sql': 'x' }, { 'bad.sql': hashMigration('x') })[0]).toMatch(/not named/);
  });

  it('hashes CRLF and LF alike so a Windows checkout is not an edit', () => {
    expect(hashMigration('a\r\nb\r\n')).toBe(hashMigration('a\nb\n'));
  });
});

describe('compareToBase', () => {
  it('allows new entries and unchanged ones', () => {
    expect(compareToBase({ '0001_a.sql': 'h1' }, { '0001_a.sql': 'h1', '0002_b.sql': 'h2' })).toEqual([]);
  });

  it('catches a rewritten hash (the file and the manifest edited together)', () => {
    expect(compareToBase({ '0001_a.sql': 'h1' }, { '0001_a.sql': 'forged' })).toEqual([
      expect.stringContaining('0001_a.sql: its sealed hash differs'),
    ]);
  });

  it('catches a removed entry', () => {
    expect(compareToBase({ '0001_a.sql': 'h1' }, {})).toEqual([expect.stringContaining('removed here')]);
  });
});

describe('renderManifest', () => {
  it('is sorted, one entry per line and ends with a newline', () => {
    const text = renderManifest({ '0002_b.sql': 'bb', '0001_a.sql': 'aa' });
    expect(text).toBe('{\n  "0001_a.sql": "aa",\n  "0002_b.sql": "bb"\n}\n');
    expect(JSON.parse(text)).toEqual({ '0001_a.sql': 'aa', '0002_b.sql': 'bb' });
  });
});

describe('the repository chain', () => {
  it('is sealed and unedited (a correction is a new numbered migration)', () => {
    const dir = join(root, 'migrations');
    const files = Object.fromEntries(
      readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .map((f) => [f, readFileSync(join(dir, f), 'utf8')]),
    );
    const manifest = JSON.parse(readFileSync(join(root, 'migrations.sealed.json'), 'utf8')) as Record<
      string,
      string
    >;
    expect(checkSeal(files, manifest)).toEqual([]);
  });
});
