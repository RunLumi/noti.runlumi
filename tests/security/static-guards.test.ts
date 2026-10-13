import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Static security guards (docs/specs/15-security-and-compliance.md F233, F239, F240).
 * They are heuristics over source text: they catch the common regression, not a determined
 * evasion. Each detector is exercised against a known-bad sample so a guard cannot pass
 * vacuously, and every failure message names the file so the fix is obvious.
 */
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function filesUnder(dir: string, ext: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? filesUnder(full, ext) : full.endsWith(ext) ? [full] : [];
  });
}

const srcFiles = filesUnder(join(root, 'src'), '.ts');
const rel = (f: string): string => relative(root, f);

// ---------------------------------------------------------------- console logging

/** Return the argument text of every `console.<method>(...)` call, parens balanced. */
export function consoleCalls(source: string): { method: string; args: string }[] {
  const out: { method: string; args: string }[] = [];
  for (const m of source.matchAll(/\bconsole\.(\w+)\s*\(/g)) {
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    const start = i;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') depth--;
    }
    out.push({ method: m[1] ?? '', args: source.slice(start, i - 1) });
  }
  return out;
}

const SENSITIVE_ARG =
  /\b(body|rawBody|headers?|payload|authorization|cookie|c\.req|req\.|request\b|env\.[A-Z_]*(SECRET|KEY|TOKEN))/i;

describe('console logging', () => {
  it('detector flags bodies and headers', () => {
    expect(consoleCalls('console.log(await c.req.text())')[0]?.args).toMatch(SENSITIVE_ARG);
    expect(consoleCalls('console.error("x", req.headers)')[0]?.args).toMatch(SENSITIVE_ARG);
    expect(consoleCalls("console.error(JSON.stringify({ event: 'ok', kind }))")[0]?.args).not.toMatch(
      SENSITIVE_ARG,
    );
  });

  it('src never uses console.log (use platform/log.ts, which redacts)', () => {
    const offenders = srcFiles.filter((f) =>
      consoleCalls(readFileSync(f, 'utf8')).some((c) => c.method === 'log'),
    );
    expect(offenders.map(rel)).toEqual([]);
  });

  it('no console call in src passes a request body, headers, cookies or secrets', () => {
    const offenders: string[] = [];
    for (const f of srcFiles) {
      for (const call of consoleCalls(readFileSync(f, 'utf8'))) {
        if (SENSITIVE_ARG.test(call.args)) offenders.push(`${rel(f)}: console.${call.method}(${call.args})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------- CSRF / Origin on mutations

const MUTATING = /\.\s*(post|put|patch|delete)\s*\(\s*['"`/]/;
const ORIGIN_CHECK = /\b(mutationRejected|originRejected|mutationGate)\b|\bheader\(\s*['"]origin['"]\s*\)/i;

export function mutatesWithoutOriginCheck(source: string): boolean {
  return MUTATING.test(source) && !ORIGIN_CHECK.test(source);
}

describe('mutating routes check Origin (F23)', () => {
  it('detector flags a mutating route file with no origin check', () => {
    expect(mutatesWithoutOriginCheck("app.post('/x', (c) => c.json({}))")).toBe(true);
    expect(mutatesWithoutOriginCheck("app.post('/x', async (c) => { if (originRejected(c)) return })")).toBe(
      false,
    );
    expect(mutatesWithoutOriginCheck("app.get('/x', (c) => c.json({}))")).toBe(false);
  });

  it('every file under src/api and src/auth that registers a mutating route checks Origin', () => {
    const routeFiles = [
      ...filesUnder(join(root, 'src/api'), '.ts'),
      ...filesUnder(join(root, 'src/auth'), '.ts'),
    ];
    const offenders = routeFiles.filter((f) => mutatesWithoutOriginCheck(readFileSync(f, 'utf8')));
    expect(offenders.map(rel)).toEqual([]);
  });
});

// ---------------------------------------------------------------- config secrets

const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PASSPHRASE|PRIVATE|API_?KEY|ENCRYPTION|^KEK|_KEK|CLIENT_SECRET)/i;
const SECRET_VALUE =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----|\bghp_[A-Za-z0-9]{20,}|\bgithub_pat_\w{20,}|\bxox[abprs]-[\w-]{10,}|\bsk_(live|test)_\w{10,}|\bAKIA[0-9A-Z]{16}\b|\b[0-9a-f]{64}\b)/;

/** The `"vars": { ... }` entries of wrangler.jsonc, without parsing JSONC. */
export function wranglerVars(text: string): Record<string, string> {
  const start = text.search(/"vars"\s*:\s*\{/);
  if (start < 0) return {};
  const vars: Record<string, string> = {};
  for (const line of text.slice(start).split('\n').slice(1)) {
    if (/^\s*\}/.test(line)) break;
    const m = /^\s*"([A-Za-z0-9_]+)"\s*:\s*"([^"]*)"/.exec(line);
    if (m?.[1] !== undefined) vars[m[1]] = m[2] ?? '';
  }
  return vars;
}

describe('wrangler.jsonc carries no secrets', () => {
  const text = readFileSync(join(root, 'wrangler.jsonc'), 'utf8');
  const vars = wranglerVars(text);

  it('parser finds the vars block (guard is not vacuous)', () => {
    expect(vars.APP_ORIGIN).toMatch(/^https:\/\//);
    expect(wranglerVars('{ "vars": {\n "A_SECRET": "x",\n } }')).toEqual({ A_SECRET: 'x' });
  });

  it('no var is named like a secret (secrets belong in `wrangler secret put`)', () => {
    expect(Object.keys(vars).filter((k) => SECRET_NAME.test(k))).toEqual([]);
  });

  it('nothing in the file looks like a key, token or private key', () => {
    expect(SECRET_VALUE.exec(text)?.[0]).toBeUndefined();
  });
});

describe('.dev.vars.example holds placeholders only', () => {
  const lines = readFileSync(join(root, '.dev.vars.example'), 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()] as const);

  it('parses entries', () => {
    expect(lines.length).toBeGreaterThan(3);
  });

  it('secret-named keys are empty or an explicit `replace…` placeholder', () => {
    const bad = lines.filter(([k, v]) => SECRET_NAME.test(k) && v !== '' && !/^replace/i.test(v));
    expect(bad.map(([k]) => k)).toEqual([]);
  });

  it('no value looks like a real credential', () => {
    expect(lines.filter(([, v]) => SECRET_VALUE.test(v)).map(([k]) => k)).toEqual([]);
  });

  it('secret detector recognises real-looking values', () => {
    expect(SECRET_VALUE.test('g'.repeat(64))).toBe(false);
    expect(SECRET_VALUE.test('0123456789abcdef'.repeat(4))).toBe(true);
    expect(SECRET_VALUE.test('ghp_' + 'A'.repeat(36))).toBe(true);
    expect(SECRET_VALUE.test('replace-with-64-hex-characters')).toBe(false);
  });
});

// ---------------------------------------------------------------- XSS sinks

describe('XSS sinks (security rules: never inject unsanitized HTML)', () => {
  const sink = /\b(dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/;

  it('detector recognises the sinks', () => {
    expect(sink.test('<div dangerouslySetInnerHTML={{ __html: x }} />')).toBe(true);
    expect(sink.test('el.innerHTML = x')).toBe(true);
    expect(sink.test('textContent = x')).toBe(false);
  });

  it('neither the Worker nor the SPA source uses an HTML-injection sink', () => {
    const files = [
      ...srcFiles,
      ...filesUnder(join(root, 'web/src'), '.ts'),
      ...filesUnder(join(root, 'web/src'), '.tsx'),
    ].filter((f) => !/\.test\.tsx?$/.test(f));
    expect(files.filter((f) => sink.test(readFileSync(f, 'utf8'))).map(rel)).toEqual([]);
  });
});
