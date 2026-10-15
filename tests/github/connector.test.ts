import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { githubConnector } from '../../src/connectors/sources/github';
import { LIFECYCLE_EVENTS } from '../../src/connectors/sources/github/lifecycle';

/**
 * GitHub behind the one connector interface (spec 05 F71, ADR 0057). The route behaviour is pinned
 * by the route suites (ingress-contract, ingress-codes, conformance), which this refactor did not
 * change; these tests pin the connector's own steps and that the route cannot bypass them.
 */

/** Verbatim from GitHub's webhook validation documentation. Do not regenerate. */
const KNOWN_ANSWER = {
  secret: "It's a Secret to Everybody",
  body: 'Hello, World!',
  signature: 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
} as const;

const enc = (s: string) => new TextEncoder().encode(s);
const sign = (secret: string, bytes: Uint8Array) =>
  `sha256=${createHmac('sha256', secret).update(bytes).digest('hex')}`;

async function verify(raw: Uint8Array, signature: string | null, secret: string = KNOWN_ANSWER.secret) {
  const headers = new Headers(signature === null ? {} : { 'x-hub-signature-256': signature });
  return githubConnector.verify({ secret, authMode: null, headers, raw, nowSeconds: 0 });
}

describe('githubConnector.verify', () => {
  it('accepts the documented known-answer vector and vouches for no identity', async () => {
    expect(await verify(enc(KNOWN_ANSWER.body), KNOWN_ANSWER.signature)).toEqual({ ok: true, eventId: null });
  });

  it('refuses a missing, malformed, foreign-secret or altered signature', async () => {
    expect((await verify(enc(KNOWN_ANSWER.body), null)).ok).toBe(false);
    expect((await verify(enc(KNOWN_ANSWER.body), 'sha256=abc')).ok).toBe(false);
    expect((await verify(enc(KNOWN_ANSWER.body), KNOWN_ANSWER.signature, 'wrong')).ok).toBe(false);
    expect((await verify(enc(`${KNOWN_ANSWER.body} `), KNOWN_ANSWER.signature)).ok).toBe(false);
  });

  it('verifies over the exact raw bytes, including a body that is not valid UTF-8 or starts with a BOM', async () => {
    // A decoded-then-re-encoded copy would differ from these bytes (U+FFFD for 0xff, the BOM stripped), so
    // only an HMAC over the raw bytes verifies them; the parser refuses such a body afterwards.
    const raw = new Uint8Array([0x7b, 0xff, 0x7d]);
    expect((await verify(raw, sign(KNOWN_ANSWER.secret, raw))).ok).toBe(true);
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('{}')]);
    expect((await verify(bom, sign(KNOWN_ANSWER.secret, bom))).ok).toBe(true);
    // A signature over the re-encoded copy is NOT accepted for the raw bytes.
    const reencoded = enc(new TextDecoder().decode(raw));
    expect((await verify(raw, sign(KNOWN_ANSWER.secret, reencoded))).ok).toBe(false);
  });
});

describe('githubConnector.appCredential', () => {
  it('is null without a webhook secret (503) and carries the App id unchanged', () => {
    expect(githubConnector.appCredential({ GITHUB_WEBHOOK_SECRET: '', GITHUB_APP_ID: '777' })).toBeNull();
    expect(githubConnector.appCredential({ GITHUB_WEBHOOK_SECRET: 's', GITHUB_APP_ID: '777' })).toEqual({
      secret: 's',
      appId: '777',
    });
  });
});

describe('githubConnector.classify', () => {
  const h = (event: string | null, delivery: string | null = 'd-1') =>
    new Headers({
      ...(event === null ? {} : { 'x-github-event': event }),
      ...(delivery === null ? {} : { 'x-github-delivery': delivery }),
    });
  const repository = { full_name: 'o/r', id: 42 };

  it('needs the event header', () => {
    expect(githubConnector.classify(h(null), { repository })).toEqual({ kind: 'invalid' });
    expect(githubConnector.classify(h(''), { repository })).toEqual({ kind: 'invalid' });
  });

  it('classifies the ping and every installation lifecycle event before any repository check', () => {
    expect(githubConnector.classify(h('ping', null), {})).toEqual({ kind: 'ping' });
    for (const name of LIFECYCLE_EVENTS)
      expect(githubConnector.classify(h(name, null), {})).toEqual({ kind: 'lifecycle', name });
  });

  it('a routable event needs a repository and a delivery id', () => {
    expect(githubConnector.classify(h('push'), {})).toEqual({ kind: 'invalid' });
    expect(githubConnector.classify(h('push', null), { repository })).toEqual({ kind: 'invalid' });
    expect(githubConnector.classify(h('push', ''), { repository })).toEqual({ kind: 'invalid' });
  });

  it('names the catalogue type, or null outside the closed catalogue', () => {
    const merged = githubConnector.classify(h('pull_request'), {
      action: 'closed',
      pull_request: { merged: true },
      repository,
    });
    expect(merged).toEqual({
      kind: 'event',
      name: 'pull_request',
      eventType: 'pull_request.merged',
      repo: 'o/r',
      repositoryId: 42,
      deliveryId: 'd-1',
    });
    const outside = githubConnector.classify(h('star'), { action: 'created', repository });
    expect(outside).toMatchObject({ kind: 'event', eventType: null });
  });
});

describe('the GitHub route reaches GitHub only through the connector', () => {
  const route = readFileSync('src/connectors/sources/github/route.ts', 'utf8');

  it('imports none of the steps the connector owns', () => {
    for (const module of ['./events', './tenant', './lifecycle', './catalog', './map'])
      expect(route, module).not.toMatch(new RegExp(`from '${module.replace('.', '\\.')}'`));
  });

  it('checks the verdict before the first parse, then classifies, then resolves the tenant', () => {
    const at = (needle: string) => {
      const i = route.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      at('connector.appCredential('),
      at('connector.verify('),
      at('if (!verdict.ok)'),
      at('JSON.parse('),
      at('connector.classify('),
      at('connector.resolveTenant('),
      at('connector.repositoryInScope('),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
