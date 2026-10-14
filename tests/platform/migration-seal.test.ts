import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

type Tree = Record<string, string>;
interface Seal {
  hashMigration: (text: string) => string;
  checkSeal: (files: Tree, seals: Tree, options?: { allowUnsealed?: boolean }) => string[];
  compareToBase: (base: { files: Tree; seals: Tree }, current: { files: Tree; seals: Tree }) => string[];
  parseSeal: (text: string) => string | undefined;
  renderSeal: (hash: string) => string;
}
const libPath = '../../scripts/lib/migration-seal.mjs';
const { hashMigration, checkSeal, compareToBase, parseSeal, renderSeal } = (await import(
  /* @vite-ignore */ libPath
)) as Seal;

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CLI = join(root, 'scripts', 'migration-seal.mjs');

const seal = (files: Tree): Tree =>
  Object.fromEntries(Object.entries(files).map(([n, t]) => [n, renderSeal(hashMigration(t))]));

describe('checkSeal', () => {
  const files = { '0001_a.sql': 'CREATE TABLE a(x);', '0002_b.sql': 'CREATE TABLE b(x);' };

  it('accepts an untouched, fully sealed chain', () => {
    expect(checkSeal(files, seal(files))).toEqual([]);
  });

  it('rejects an edit to a sealed migration and points at a new migration', () => {
    const problems = checkSeal({ ...files, '0001_a.sql': 'CREATE TABLE a(x, y);' }, seal(files));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/0001_a\.sql: changed after it was sealed.*new migration/);
  });

  it('rejects deleting a sealed migration', () => {
    expect(checkSeal({ '0001_a.sql': files['0001_a.sql'] }, seal(files))).toEqual([
      expect.stringContaining('0002_b.sql: sealed but missing'),
    ]);
  });

  it('rejects a migration nobody sealed, unless sealing is what is running', () => {
    const more = { ...files, '0003_c.sql': 'SELECT 1;' };
    expect(checkSeal(more, seal(files))).toEqual([expect.stringContaining('0003_c.sql: not sealed')]);
    expect(checkSeal(more, seal(files), { allowUnsealed: true })).toEqual([]);
  });

  it('rejects a malformed sidecar', () => {
    expect(checkSeal(files, { ...seal(files), '0001_a.sql': 'nonsense\n' })[0]).toMatch(
      /0001_a\.sql\.sha256: not a 64 character hex digest/,
    );
    expect(parseSeal(`${'a'.repeat(64)}\n`)).toBe('a'.repeat(64));
    expect(parseSeal('A'.repeat(64))).toBeUndefined();
  });

  it('rejects two migrations with the same number', () => {
    const dup = { '0001_a.sql': 'x', '0001_b.sql': 'y' };
    expect(checkSeal(dup, seal(dup)).join('\n')).toMatch(/0001_b\.sql: duplicate migration number 0001/);
  });

  it('allows only the listed gap (0023) and rejects any other', () => {
    const ok = { '0022_a.sql': 'x', '0024_b.sql': 'y' };
    expect(checkSeal(ok, seal(ok))).toEqual([]);
    const bad = { '0001_a.sql': 'x', '0003_c.sql': 'y' };
    expect(checkSeal(bad, seal(bad)).join('\n')).toMatch(/0003_c\.sql: number 0003 leaves a gap after 0001/);
  });

  it('rejects a name that is not NNNN_snake_case.sql', () => {
    expect(checkSeal({ 'bad.sql': 'x' }, seal({ 'bad.sql': 'x' }))[0]).toMatch(/not named/);
  });

  it('hashes CRLF and LF alike so a Windows checkout is not an edit', () => {
    expect(hashMigration('a\r\nb\r\n')).toBe(hashMigration('a\nb\n'));
  });
});

describe('compareToBase', () => {
  const baseFiles = { '0001_a.sql': 'x', '0002_b.sql': 'y' };
  const base = { files: baseFiles, seals: seal(baseFiles) };

  it('allows a new migration above the base maximum and nothing else changing', () => {
    const files = { ...baseFiles, '0003_c.sql': 'z' };
    expect(compareToBase(base, { files, seals: seal(files) })).toEqual([]);
  });

  it('catches an edit even when the file and its sidecar are rewritten together', () => {
    const files = { ...baseFiles, '0001_a.sql': 'forged' };
    const problems = compareToBase(base, { files, seals: seal(files) }).join('\n');
    expect(problems).toMatch(/0001_a\.sql: differs from the base branch/);
    expect(problems).toMatch(/0001_a\.sql\.sha256: differs from the base branch/);
  });

  it('catches a deleted migration and a deleted sidecar', () => {
    const problems = compareToBase(base, { files: { '0001_a.sql': 'x' }, seals: {} }).join('\n');
    expect(problems).toMatch(/0002_b\.sql: exists on the base branch and was removed/);
    expect(problems).toMatch(/0001_a\.sql\.sha256: sealed on the base branch and removed/);
  });

  it('works when the base has no sidecars yet: its migrations are compared by content', () => {
    const noSeals = { files: baseFiles, seals: {} };
    const files = { ...baseFiles, '0001_a.sql': 'forged' };
    expect(compareToBase(noSeals, { files, seals: seal(files) }).join('\n')).toMatch(/0001_a\.sql: differs/);
  });

  it('requires a new migration to be numbered above the base maximum (a late merge cannot slot in below)', () => {
    const files = { ...baseFiles, '0001_late.sql': 'q' };
    expect(compareToBase(base, { files, seals: seal(files) }).join('\n')).toMatch(
      /0001_late\.sql: new migration is numbered 0001, not above the base's highest 0002/,
    );
  });
});

/** The real script in a throwaway git repository, so the failure modes are the ones CI would see. */
describe('the CLI against a real git repository', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  // Run from a pre-push hook, the environment carries variables that redirect every git call to the real
  // repository; the throwaway repositories must not inherit them.
  const cleanEnv: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
  ) as NodeJS.ProcessEnv;
  const run = (cwd: string, ...args: string[]) =>
    spawnSync(process.execPath, [CLI, '--root', cwd, ...args], { encoding: 'utf8', env: cleanEnv });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv },
    );
  const put = (cwd: string, name: string, text: string) => writeFileSync(join(cwd, 'migrations', name), text);

  /** A repo whose `main` has two sealed migrations, checked out on a feature branch. */
  function repo(): string {
    const cwd = mkdtempSync(join(tmpdir(), 'seal-'));
    dirs.push(cwd);
    mkdirSync(join(cwd, 'migrations'));
    git(cwd, 'init', '-q', '-b', 'main');
    put(cwd, '0001_a.sql', 'CREATE TABLE a(x);\n');
    put(cwd, '0002_b.sql', 'CREATE TABLE b(x);\n');
    expect(run(cwd).status).toBe(0);
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', 'base');
    git(cwd, 'checkout', '-q', '-b', 'feature');
    return cwd;
  }

  it('passes on an untouched tree', () => {
    const cwd = repo();
    expect(run(cwd, '--check', '--base', 'main', '--require-base').status).toBe(0);
  });

  it('a base ref that does not resolve is an error, not "no base" (H1)', () => {
    const cwd = repo();
    const result = run(cwd, '--check', '--base', 'origin/nonexistent');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('does not resolve');
  });

  it('--base without a value, and --require-base without --base, are usage errors', () => {
    const cwd = repo();
    expect(run(cwd, '--check', '--base').status).toBe(2);
    expect(run(cwd, '--check', '--require-base').status).toBe(2);
  });

  it('an edited migration with a forged sidecar fails against the base', () => {
    const cwd = repo();
    put(cwd, '0001_a.sql', 'CREATE TABLE a(x, y);\n');
    expect(run(cwd, '--check').status).toBe(1); // sidecar no longer matches
    writeFileSync(
      join(cwd, 'migrations', '0001_a.sql.sha256'),
      renderSeal(hashMigration('CREATE TABLE a(x, y);\n')),
    );
    expect(run(cwd, '--check').status).toBe(0); // self-consistent...
    const against = run(cwd, '--check', '--base', 'main');
    expect(against.status).toBe(1); // ...but not against the base
    expect(against.stderr).toContain('0001_a.sql: differs from the base branch');
  });

  it('adding a migration through the seal command passes, end to end', () => {
    const cwd = repo();
    put(cwd, '0003_c.sql', 'CREATE TABLE c(x);\n');
    expect(run(cwd, '--check').status).toBe(1); // unsealed
    const sealed = run(cwd);
    expect(sealed.status).toBe(0);
    expect(sealed.stdout).toContain('sealed 0003_c.sql');
    expect(readFileSync(join(cwd, 'migrations', '0003_c.sql.sha256'), 'utf8')).toBe(
      renderSeal(hashMigration('CREATE TABLE c(x);\n')),
    );
    expect(run(cwd, '--check', '--base', 'main', '--require-base').status).toBe(0);
  });

  it('two branches that pick the same number merge with no textual conflict (disjoint files) but fail the check', () => {
    const cwd = repo();
    put(cwd, '0003_c.sql', 'CREATE TABLE c(x);\n');
    run(cwd);
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', 'c');
    git(cwd, 'checkout', '-q', 'main');
    git(cwd, 'checkout', '-q', '-b', 'other');
    put(cwd, '0003_d.sql', 'CREATE TABLE d(x);\n');
    run(cwd);
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', 'd');
    git(cwd, 'merge', '-q', '--no-edit', 'feature');
    const result = run(cwd, '--check');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('duplicate migration number 0003');
  });

  it('a deleted migration fails against the base', () => {
    const cwd = repo();
    rmSync(join(cwd, 'migrations', '0002_b.sql'));
    rmSync(join(cwd, 'migrations', '0002_b.sql.sha256'));
    const result = run(cwd, '--check', '--base', 'main');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('0002_b.sql: exists on the base branch and was removed');
  });

  it('--require-base fails when the base has no sidecars, plain --base compares by content', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'seal-'));
    dirs.push(cwd);
    mkdirSync(join(cwd, 'migrations'));
    git(cwd, 'init', '-q', '-b', 'main');
    put(cwd, '0001_a.sql', 'CREATE TABLE a(x);\n');
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', 'unsealed base');
    git(cwd, 'checkout', '-q', '-b', 'feature');
    expect(run(cwd).status).toBe(0);
    expect(run(cwd, '--check', '--base', 'main').status).toBe(0);
    expect(run(cwd, '--check', '--base', 'main', '--require-base').status).toBe(1);
    put(cwd, '0001_a.sql', 'CREATE TABLE a(x, y);\n');
    expect(run(cwd, '--check', '--base', 'main').status).toBe(1);
  });

  it('the seal command refuses an edited sealed migration and writes nothing', () => {
    const cwd = repo();
    put(cwd, '0001_a.sql', 'edited\n');
    put(cwd, '0003_c.sql', 'CREATE TABLE c(x);\n');
    const before = readFileSync(join(cwd, 'migrations', '0001_a.sql.sha256'), 'utf8');
    const result = run(cwd);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('nothing was written');
    expect(readFileSync(join(cwd, 'migrations', '0001_a.sql.sha256'), 'utf8')).toBe(before);
    expect(existsSync(join(cwd, 'migrations', '0003_c.sql.sha256'))).toBe(false);
  });

  it('running the seal command twice changes nothing', () => {
    const cwd = repo();
    const first = run(cwd);
    expect(first.status).toBe(0);
    expect(first.stdout).toBe('');
  });
});
