import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOG_EVENTS, LOG_EVENT_NAMES } from '../../src/platform/log-events';
import type * as RedactModule from '../../src/platform/redact';
import type { Redacted } from '../../src/platform/redact';
import { captureConsole, Planted } from '../support/log-capture';

/**
 * F195 for the `console` exit point (ADR 0051): every log field passes through `redact()` in exactly
 * one place. Statically, `console` is referenced only in src/platform/log.ts, which calls `redact()`
 * once and hands `console` nothing but the line built from its result; ESLint's `no-console` enforces
 * the same for new code. At run time, every catalogued event is emitted with every declared field set
 * to a planted secret, and each line must come from exactly one `redact()` call and carry no secret.
 */

const spy = vi.hoisted(() => ({
  calls: 0,
  outputs: [] as unknown[],
  fail: false,
}));

vi.mock('../../src/platform/redact', async (importOriginal) => {
  const actual = await importOriginal<typeof RedactModule>();
  return {
    ...actual,
    redact: (value: unknown, options?: Parameters<typeof actual.redact>[1]): Redacted => {
      spy.calls++;
      const out = spy.fail ? '[unredactable]' : actual.redact(value, options);
      spy.outputs.push(out);
      return out;
    },
  };
});

const { log } = await import('../../src/platform/log');

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const LOG_FILE = join(root, 'src', 'platform', 'log.ts');

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? filesUnder(full) : full.endsWith('.ts') ? [full] : [];
  });
}

function nodes(file: string, text = readFileSync(file, 'utf8')): ts.Node[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(source);
  return out;
}

/** Identifiers named `console` in code (comments and strings are not identifiers). */
const consoleRefs = (file: string, text?: string): ts.Identifier[] =>
  nodes(file, text).filter((n): n is ts.Identifier => ts.isIdentifier(n) && n.text === 'console');

const callsOf = (file: string, name: string): ts.CallExpression[] =>
  nodes(file).filter(
    (n): n is ts.CallExpression =>
      ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name,
  );

describe('console is reached only through log() (F195)', () => {
  it('the detector sees aliases and property access, not comments or strings', () => {
    expect(consoleRefs('x.ts', 'const c = console; globalThis.console.info(1);')).toHaveLength(2);
    expect(consoleRefs('x.ts', '// console.log(x)\nconst s = "console";')).toHaveLength(0);
  });

  it('no file under src/ other than src/platform/log.ts references console', () => {
    const offenders = filesUnder(join(root, 'src'))
      .filter((f) => f !== LOG_FILE && consoleRefs(f).length > 0)
      .map((f) => relative(root, f));
    expect(offenders).toEqual([]);
  });

  it('log.ts calls redact() once, and console only with the line built from it', () => {
    expect(callsOf(LOG_FILE, 'redact')).toHaveLength(1);
    const consoleCalls = consoleRefs(LOG_FILE).map((id) => id.parent.parent);
    expect(consoleCalls).toHaveLength(3);
    for (const call of consoleCalls) {
      expect(ts.isCallExpression(call)).toBe(true);
      const args = (call as ts.CallExpression).arguments.map((a) => a.getText());
      expect(args).toEqual(['line']);
    }
    expect(readFileSync(LOG_FILE, 'utf8')).toMatch(/const line = logLine</);
  });

  it('ESLint no-console is an error for src/ and off only for src/platform/log.ts', async () => {
    const eslint = new ESLint({ cwd: root });
    const level = async (file: string): Promise<unknown> => {
      const config = (await eslint.calculateConfigForFile(join(root, file))) as {
        rules?: Record<string, unknown>;
      };
      const rule = config.rules?.['no-console'];
      return Array.isArray(rule) ? rule[0] : rule;
    };
    expect(await level('src/api/github.ts')).toBe(2);
    expect(await level('src/pipeline/consumer.ts')).toBe(2);
    expect(await level('src/platform/log.ts')).toBe(0);
  });
});

describe('every catalogued event is redacted exactly once (F195)', () => {
  let capture: ReturnType<typeof captureConsole>;
  beforeEach(() => {
    capture = captureConsole();
    spy.calls = 0;
    spy.outputs = [];
    spy.fail = false;
  });
  afterEach(() => {
    capture.restore();
  });

  const SECRET = ['planted', 'secret', 'Zq7Kd2mV9xR4tLw8'].join('_');
  const planted = (field: string): unknown => ({
    [field]: `token=${SECRET} https://hooks.slack.com/services/${SECRET}`,
    webhook_url: SECRET,
  });

  it.each(LOG_EVENT_NAMES)('%s', (event) => {
    const fields = Object.fromEntries(LOG_EVENTS[event].fields.map((f) => [f, planted(f)]));
    log('error', event, fields as never);
    expect(spy.calls).toBe(1);
    expect(capture.lines).toHaveLength(1);
    const line = capture.lines[0] ?? '';
    expect(JSON.parse(line)).toEqual(spy.outputs[0]);
    const secrets = new Planted();
    secrets.add('planted secret', SECRET);
    expect(secrets.leaked(line)).toEqual([]);
  });

  it('a redaction failure drops the fields and keeps the line', () => {
    spy.fail = true;
    log('error', 'cron_job_failed', { job: 'j', error: new Error(SECRET) });
    expect(spy.calls).toBe(1);
    const line = JSON.parse(capture.lines[0] ?? '{}') as Record<string, unknown>;
    expect(line).toMatchObject({ level: 'error', msg: 'cron_job_failed', redaction_failed: true });
    expect(line).not.toHaveProperty('job');
    expect(capture.lines[0]).not.toContain(SECRET);
  });
});
