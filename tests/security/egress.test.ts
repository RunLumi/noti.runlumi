import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * F228 static proof: the Workers runtime has no egress filter, so the only thing standing
 * between a tenant-chosen URL and the network is our own code. Exactly one module may issue
 * an outbound request to a customer-configured URL (`send.ts`, after the URL policy), and the
 * small set of other outbound calls is listed here, each with a reason and a marker comment in
 * the file. Like the other static guards this is a heuristic over source text: it catches the
 * common regression, not a determined evasion, and each detector is exercised against samples.
 */
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return filesUnder(full);
    return /\.(ts|tsx|mts|js|mjs)$/.test(full) ? [full] : [];
  });
}

/** Source text with comments and string/template contents blanked, so prose cannot trigger a match. */
export function stripNonCode(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i] ?? '';
    const next = source[i + 1] ?? '';
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += quote;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i++;
        if (source[i] === '\n' && quote !== '`') break;
        i++;
      }
      out += quote;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const OUTBOUND_PATTERNS: readonly { readonly name: string; readonly re: RegExp }[] = [
  // `fetch(...)`, `await fetch(...)`; not `x.fetch(` (a binding or handler method) and not a
  // method definition at the start of a line (`fetch(request, env) {`).
  { name: 'global fetch call', re: /(?<![.\w$])(?<!^\s*)fetch\s*\(/m },
  { name: 'globalThis/self fetch', re: /\b(?:globalThis|self)\s*\.\s*fetch\b/ },
  // `const f = fetch`, `?? fetch`, `: fetch,` references that would alias the global.
  { name: 'fetch reference', re: /(?:=|\?\?|\|\||\(|,)\s*fetch\s*(?:[,;)\]}]|$)/m },
  { name: 'XMLHttpRequest', re: /\bXMLHttpRequest\b/ },
  { name: 'WebSocket client', re: /\bnew\s+WebSocket\s*\(/ },
  { name: 'raw sockets', re: /cloudflare:sockets/ },
  { name: 'node http client', re: /(?:from|require\()\s*['"](?:node:)?https?['"]/ },
];

export function outboundUses(source: string): string[] {
  const code = stripNonCode(source);
  const hits: string[] = [];
  for (const { name, re } of OUTBOUND_PATTERNS) {
    if (re.test(code)) hits.push(name);
  }
  // The string-blanking above removes `'cloudflare:sockets'` and import specifiers, so check
  // module specifiers on the raw text with comments only removed.
  const noComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  if (/cloudflare:sockets/.test(noComments) && !hits.includes('raw sockets')) hits.push('raw sockets');
  if (/from\s*['"](?:node:)?https?['"]/.test(noComments) && !hits.includes('node http client')) {
    hits.push('node http client');
  }
  return hits;
}

/**
 * Every file in `src/` that may make an outbound request. Adding a row is a security review:
 * say what the destination is and why it cannot be a customer-chosen URL.
 */
const ALLOWED_OUTBOUND: Readonly<Record<string, string>> = {
  'src/connectors/destinations/send.ts':
    'THE destination send path: the URL policy runs in the same function, redirect is manual, body and time are bounded.',
  'src/connectors/sources/github/install.ts':
    'GitHub App install verification against fixed GitHub hosts (control plane, our own OAuth client); no tenant-supplied URL.',
  'src/connectors/destinations/dns-check.ts':
    'Save-time DNS-over-HTTPS lookup against one fixed, hard-coded resolver (DOH_ENDPOINT); the customer controls only the query name, never the URL.',
};

/** The comment every allowed file carries, so a reader of the file sees the rule. */
const MARKER = 'EGRESS-ALLOWED:';

const srcFiles = filesUnder(join(root, 'src'));
const rel = (f: string): string => relative(root, f);

describe('egress detectors', () => {
  it.each([
    ['await fetch(url)', true],
    ['const r = await fetch(url, { method: "POST" });', true],
    ['const f = options.fetch ?? fetch;', true],
    ['const send = (input, init) => fetch(input, init);', true],
    ['globalThis.fetch(url)', true],
    ['self.fetch(url)', true],
    ['new XMLHttpRequest()', true],
    ['const ws = new WebSocket(u)', true],
    ["import { connect } from 'cloudflare:sockets';", true],
    ["import https from 'node:https';", true],
    ['assets.fetch(request)', false],
    ['return app.fetch(request, env, ctx);', false],
    ['  fetch(request: Request, env: Bindings): Response {', false],
    ['readonly fetch?: Fetcher;', false],
    ['// we call fetch(url) here', false],
    ['/* fetch(url) */ const x = 1;', false],
    ["const s = 'fetch(url)';", false],
    ['const s = `fetch(${x})`;', false],
    ['prefetch(url); refetch(url);', false],
  ] as const)('%s -> %s', (source, flagged) => {
    expect(outboundUses(source).length > 0).toBe(flagged);
  });
});

describe('only_one_module_constructs_destination_requests (F228)', () => {
  it('src/ contains no outbound request outside the listed files', () => {
    const offenders = srcFiles
      .filter((f) => !(rel(f) in ALLOWED_OUTBOUND))
      .map((f) => ({ file: rel(f), uses: outboundUses(readFileSync(f, 'utf8')) }))
      .filter((o) => o.uses.length > 0);
    expect(
      offenders,
      'Outbound requests must go through src/connectors/destinations/send.ts (F228). If a new control-plane call is truly needed, list it in ALLOWED_OUTBOUND with a reason.',
    ).toEqual([]);
  });

  it('every listed file exists, still makes an outbound call, and carries the marker comment', () => {
    for (const file of Object.keys(ALLOWED_OUTBOUND)) {
      const text = readFileSync(join(root, file), 'utf8');
      expect(
        outboundUses(text).length,
        `${file} no longer makes an outbound call: remove it from the list`,
      ).toBeGreaterThan(0);
      expect(text, `${file} must carry a ${MARKER} comment`).toContain(MARKER);
    }
  });

  it('exactly one listed file takes a customer-configured URL', () => {
    const sendsToCustomerUrls = Object.keys(ALLOWED_OUTBOUND).filter((f) => f.endsWith('/send.ts'));
    expect(sendsToCustomerUrls).toEqual(['src/connectors/destinations/send.ts']);
  });

  it('the send path re-checks the URL policy before any request is built', () => {
    const text = readFileSync(join(root, 'src/connectors/destinations/send.ts'), 'utf8');
    const policy = text.indexOf('checkDestinationUrl(');
    const request = text.search(/doFetch\(/);
    expect(policy).toBeGreaterThan(-1);
    expect(request).toBeGreaterThan(policy);
    expect(text).toContain("redirect: 'manual'");
  });

  it('the control-plane DNS lookup targets a constant, not a variable URL', () => {
    const text = readFileSync(join(root, 'src/connectors/destinations/dns-check.ts'), 'utf8');
    expect(text).toMatch(/export const DOH_ENDPOINT = 'https:\/\/cloudflare-dns\.com\/dns-query'/);
    // Every fetcher call is built from DOH_ENDPOINT.
    expect(text).toMatch(/fetcher\(`\$\{DOH_ENDPOINT\}\?name=/);
  });
});
