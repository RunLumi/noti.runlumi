import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function readDirRecursive(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? readDirRecursive(full) : [full];
  });
}

function sourceFiles(): string[] {
  return readDirRecursive(join(root, 'src')).filter((f) => f.endsWith('.ts'));
}

/** Every `env.NAME` / `c.env.NAME` referenced in application source. */
function envKeysInSource(): Set<string> {
  const keys = new Set<string>();
  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\b(?:c\.)?env\.([A-Z][A-Z0-9_]*)/g)) {
      const key = m[1];
      if (key) keys.add(key);
    }
  }
  return keys;
}

/**
 * Strip `//` and block comments from JSONC without damaging `//` inside string
 * literals (e.g. the `https://` in wrangler's APP_ORIGIN). A naive regex would delete
 * the closing quote and produce a parse error.
 */
function stripJsonComments(input: string): string {
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < input.length; i++) {
    const c = input.charAt(i);
    const next = input.charAt(i + 1);

    if (inLineComment) {
      if (c === '\n') {
        inLineComment = false;
        out += c;
      }
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    out += c;
  }

  // Trailing commas are legal in JSONC but not in JSON.
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** Bindings and vars declared in wrangler.jsonc, which never appear in .dev.vars. */
function wranglerProvidedKeys(): Set<string> {
  const keys = new Set<string>();
  const config = JSON.parse(stripJsonComments(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'))) as Record<
    string,
    unknown
  >;

  // Binding arrays declare their binding under different keys: queue consumers use
  // `binding`, `queues.producers` use `name` + `queue`, and `send_email` uses only `name`.
  // Collect by walking with the parent key so all three shapes are covered.
  const collect = (node: unknown, parentKey = '') => {
    if (Array.isArray(node)) return node.forEach((entry) => collect(entry, parentKey));
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      if (typeof obj.binding === 'string') keys.add(obj.binding);
      if (typeof obj.name === 'string' && (typeof obj.queue === 'string' || parentKey === 'send_email')) {
        keys.add(obj.name);
      }
      for (const [key, value] of Object.entries(obj)) collect(value, key);
    }
  };
  collect(config);

  const vars = config.vars as Record<string, unknown> | undefined;
  for (const name of Object.keys(vars ?? {})) keys.add(name);

  return keys;
}

function devVarKeys(): Set<string> {
  const text = readFileSync(join(root, '.dev.vars.example'), 'utf8');
  const keys = new Set<string>();
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    if (match?.[1]) keys.add(match[1]);
  }
  return keys;
}

describe('configuration contract', () => {
  it('declares every secret the source reads in .dev.vars.example', () => {
    const fromSource = envKeysInSource();
    const provided = wranglerProvidedKeys();
    const declared = devVarKeys();

    // Secrets must be discoverable by a developer setting up locally. If one is missing,
    // the failure mode is a runtime throw on first request — exactly defect D1.
    const missing = [...fromSource].filter((k) => !provided.has(k) && !declared.has(k)).sort();

    expect(missing, `secrets used in src/ but absent from .dev.vars.example and wrangler.jsonc`).toEqual([]);
  });

  it('declares nothing in .dev.vars.example that the app never reads', () => {
    const fromSource = envKeysInSource();
    const provided = wranglerProvidedKeys();
    const declared = devVarKeys();

    // A stale entry here is the other half of D1: it sends developers to set a variable
    // that has no effect, which is how ENCRYPTION_KEY_BASE64 survived for months.
    const stale = [...declared].filter((k) => !fromSource.has(k) && !provided.has(k)).sort();

    expect(stale, `entries in .dev.vars.example that nothing reads`).toEqual([]);
  });

  it('names the encryption key the way src/index.ts expects', () => {
    // Regression guard for the concrete D1 defect: the example file declared
    // ENCRYPTION_KEY_BASE64 while the code reads ENCRYPTION_KEY and requires 64 hex chars.
    const declared = devVarKeys();
    expect(declared.has('ENCRYPTION_KEY')).toBe(true);
    expect(declared.has('ENCRYPTION_KEY_BASE64')).toBe(false);
  });
});
