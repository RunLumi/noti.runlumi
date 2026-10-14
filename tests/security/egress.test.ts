import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  callsTo,
  enclosingFunction,
  findOutbound,
  parse,
  startsWithConstant,
  statementIndex,
  topLevelStringConst,
} from '../support/egress-ast';

/**
 * F228 regression guard: the Workers runtime has no egress filter, so the only thing between a
 * tenant-chosen URL and the network is our own code. This test parses every file under `src/`
 * with the TypeScript compiler and fails when outbound-capable code appears outside a short,
 * reasoned list. It is a guard against regressions, NOT a proof that no other path exists: see
 * the header of tests/support/egress-ast.ts for what it cannot follow (value aliasing). The
 * allowed files are additionally pinned to an exact call-site count and shape, so widening one
 * of them is a visible test change.
 */
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return filesUnder(full);
    return /\.(ts|tsx|mts|js|mjs)$/.test(full) ? [full] : [];
  });
}

const rel = (f: string): string => relative(root, f).split('\\').join('/');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

/** Every file in `src/` that may make an outbound request, and why. Adding a row is a review. */
const ALLOWED_OUTBOUND: Readonly<Record<string, string>> = {
  'src/connectors/destinations/send.ts':
    'THE destination send path: the URL policy runs in the same function, redirect is manual, body and time are bounded.',
  'src/connectors/sources/github/install.ts':
    'GitHub App install verification against fixed GitHub hosts (control plane, our own OAuth client); no tenant-supplied URL.',
  'src/connectors/destinations/dns-check.ts':
    'Save-time DNS-over-HTTPS lookup against one fixed, hard-coded resolver (DOH_ENDPOINT); the customer controls only the query name, never the URL.',
};

const MARKER = 'EGRESS-ALLOWED:';
const srcFiles = filesUnder(join(root, 'src'));

describe('egress detector: constructs that must be flagged', () => {
  it.each([
    ['await fetch(url)'],
    ['const r = await fetch(url, { method: "POST" });'],
    ['fetch(url).catch(() => undefined);'], // line-start statement call
    ['ctx.waitUntil(\n  fetch(u)\n);'], // multi-line, line-start argument
    ['fetch\n(u)'], // call split across lines
    ['const s = `${fetch(u)}`;'], // inside a template interpolation
    ['tag`x${fetch(u)}`;'], // tagged template with interpolation
    ['const re = /[\'"]/; await fetch(u);'], // a regex literal with a quote before the call
    ["const a = /'/g, b = 1; fetch(u);"],
    ['const f = fetch;'],
    ['const send = (i, n) => fetch(i, n);'],
    ['const g = options.fetch ?? fetch;'],
    ['fetch.bind(globalThis)(u)'],
    ['const { fetch } = globalThis;'],
    ['const { fetch: f } = globalThis;'],
    ["globalThis['fetch'](u)"],
    ["self['fetch'](u)"],
    ['globalThis.fetch(u)'],
    ['window.fetch(u)'],
    ['self.fetch(u)'],
    ['const f = x ? fetch : null;'],
    ['export default { fetch };'], // handler shorthand: must not be the global
    ['function run(f = fetch) { f(u); }'], // default parameter
    ['const g = globalThis;'],
    ['const k = "fe" + "tch"; globalThis[k](u);'],
    ['new WebSocket(u)'],
    ['new EventSource(u)'],
    ['new XMLHttpRequest()'],
    ['navigator.sendBeacon(u, d)'],
    ["navigator['sendBeacon'](u)"],
    ["import { connect } from 'cloudflare:sockets';"],
    ["import https from 'node:https';"],
    ["import net from 'net';"],
    ["import axios from 'axios';"],
    ["export * from 'node:http';"],
    ["const m = await import('node:http');"],
    ["const m = await import('cloudflare:sockets');"],
    ['const m = await import(name);'],
    ["const h = require('https');"],
    ['eval("fetch(u)")'],
    ['new Function("return fetch")()'],
    ['x.somethingElse.fetch(u)'], // unrecognised receiver
  ] as const)('flags %j', (source) => {
    expect(findOutbound(source, 'src/x.ts').length).toBeGreaterThan(0);
  });
});

describe('egress detector: constructs that must not be flagged', () => {
  it.each([
    ['// we call fetch(url) here'],
    ['/* fetch(url) */ const x = 1;'],
    ["const s = 'fetch(url)';"],
    ['const s = `fetch(${x})`;'],
    ['prefetch(url); refetch(url);'],
    ['const o = { fetch: 1 };'],
    ['interface Deps { readonly fetch?: Fetcher; }'],
    ['type Fetch = typeof fetch;'],
    ['export default { fetch(request: Request) { return new Response(); } };'],
    ['class A { fetch() {} }'],
    ['function f(fetch: Fn) {}'],
    ['const { retry_after: seconds, global } = parsed; const x = { global: global === true };'],
    ['const x = { window: 60 }; x.window;'],
    ['globalThis.crypto.randomUUID();'],
    ['const p = Promise.resolve();'],
    ['env.ASSETS.fetch(request)'],
    ['c.env.SERVICE.fetch(request)'],
    ['await import("@tanstack/react-start/server-entry")'],
    ["import { Hono } from 'hono';"],
  ] as const)('does not flag %j', (source) => {
    expect(findOutbound(source, 'src/x.ts')).toEqual([]);
  });

  it('exempts X.fetch only for an env binding or a per-file in-process receiver', () => {
    expect(findOutbound('assets.fetch(r)', 'src/web/shell.ts')).toEqual([]);
    expect(findOutbound('assets.fetch(r)', 'src/other.ts').length).toBe(1);
    expect(findOutbound('app.fetch(r, env, ctx)', 'src/worker.ts')).toEqual([]);
    expect(findOutbound('app.fetch(r, env, ctx)', 'src/other.ts').length).toBe(1);
    expect(findOutbound('env.DB_PROXY.fetch(r)', 'src/other.ts')).toEqual([]);
    expect(findOutbound('globalThis.fetch(r)', 'src/worker.ts').length).toBe(1);
  });

  it('reports the line of the finding', () => {
    expect(findOutbound('const a = 1;\n\nfetch(u);', 'src/x.ts')).toEqual([
      { kind: 'global fetch reference', line: 3 },
    ]);
  });
});

describe('only listed modules make outbound requests (F228 regression guard)', () => {
  it('src/ contains no outbound-capable code outside the listed files', () => {
    const offenders = srcFiles
      .filter((f) => !(rel(f) in ALLOWED_OUTBOUND))
      .map((f) => ({ file: rel(f), findings: findOutbound(readFileSync(f, 'utf8'), rel(f)) }))
      .filter((o) => o.findings.length > 0);
    expect(
      offenders,
      'Outbound requests must go through src/connectors/destinations/send.ts (F228). If a new control-plane call is truly needed, list it in ALLOWED_OUTBOUND with a reason and pin its call sites below.',
    ).toEqual([]);
  });

  it('every listed file exists, still makes an outbound call, and carries the marker comment', () => {
    for (const file of Object.keys(ALLOWED_OUTBOUND)) {
      const text = read(file);
      expect(
        findOutbound(text, file).length,
        `${file} makes no outbound call: remove it from the list`,
      ).toBeGreaterThan(0);
      expect(text, `${file} must carry a ${MARKER} comment`).toContain(MARKER);
    }
  });

  it('pins the exact outbound constructs in each allowed file', () => {
    // One reference to the global `fetch` per file (a default parameter or an injected default),
    // and nothing else: no sockets, no WebSocket, no second reference.
    for (const file of Object.keys(ALLOWED_OUTBOUND)) {
      expect(
        findOutbound(read(file), file).map((f) => f.kind),
        file,
      ).toEqual(['global fetch reference']);
    }
  });
});

describe('send.ts: the policy decision and the request are one function (F228)', () => {
  const sf = parse(read('src/connectors/destinations/send.ts'), 'src/connectors/destinations/send.ts');
  const fetchRef = (() => {
    let found: ts.Identifier | undefined;
    const visit = (n: ts.Node): void => {
      if (
        ts.isIdentifier(n) &&
        n.text === 'fetch' &&
        ts.isCallExpression(n.parent) &&
        n.parent.expression === n
      ) {
        found = n;
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return found;
  })();

  it('has exactly one reference to the global fetch, inside sendRequest', () => {
    expect(fetchRef).toBeDefined();
    expect(enclosingFunction(fetchRef as ts.Node)?.name?.text).toBe('sendRequest');
  });

  it('a rejecting policy check precedes, at the top level of the function, every use of the fetch', () => {
    const fn = enclosingFunction(fetchRef as ts.Node);
    if (!fn?.body) throw new Error('sendRequest not found');
    const checks = fn.body.statements
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => ts.isIfStatement(s) && /checkDestinationUrl\(/.test(s.expression.getText(sf)));
    expect(checks).toHaveLength(1);
    const { s: guard, i: guardIndex } = checks[0] as { s: ts.IfStatement; i: number };
    // `if (!check(...).ok) return ...;` dominates what follows: a failure returns.
    expect(guard.expression.getText(sf)).toMatch(
      /^!checkDestinationUrl\(request\.kind, request\.url, [^)]*\)\.ok$/,
    );
    const thenStatement = ts.isBlock(guard.thenStatement)
      ? guard.thenStatement.statements.at(-1)
      : guard.thenStatement;
    expect(thenStatement && ts.isReturnStatement(thenStatement)).toBe(true);
    expect(guardIndex).toBeLessThan(statementIndex(fn, fetchRef as ts.Node));
    // The request goes to the URL that was checked: same expression, no reassignment between.
    const calls = callsTo(sf, 'doFetch');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.arguments[0]?.getText(sf)).toBe('request.url');
    expect(statementIndex(fn, calls[0] as ts.Node)).toBeGreaterThan(guardIndex);
    expect(fn.body.getText(sf)).not.toMatch(/\brequest\s*=[^=]|request\.url\s*=[^=]/);
    expect(fn.body.getText(sf)).toContain("redirect: 'manual'");
  });
});

describe('dns-check.ts: the lookup URL is built from the constant (F228)', () => {
  const file = 'src/connectors/destinations/dns-check.ts';
  const sf = parse(read(file), file);

  it('DOH_ENDPOINT is a fixed https string', () => {
    expect(topLevelStringConst(sf, 'DOH_ENDPOINT')).toBe('https://cloudflare-dns.com/dns-query');
  });

  it('the single call through `fetcher` starts with ${DOH_ENDPOINT}', () => {
    const calls = callsTo(sf, 'fetcher');
    expect(calls).toHaveLength(1);
    expect(startsWithConstant(calls[0]?.arguments[0], ['DOH_ENDPOINT'])).toBe('DOH_ENDPOINT');
  });
});

describe('github/install.ts: every request URL starts from a GitHub constant (F228)', () => {
  const file = 'src/connectors/sources/github/install.ts';
  const sf = parse(read(file), file);

  it('the host constants are fixed https strings', () => {
    expect(topLevelStringConst(sf, 'GITHUB_API')).toBe('https://api.github.com');
    expect(topLevelStringConst(sf, 'GITHUB_WEB')).toBe('https://github.com');
  });

  it('there are exactly three calls through `f`, each starting with a GitHub constant', () => {
    const calls = callsTo(sf, 'f');
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(
        startsWithConstant(c.arguments[0], ['GITHUB_API', 'GITHUB_WEB']),
        c.getText(sf).slice(0, 60),
      ).toBeDefined();
    }
  });
});
