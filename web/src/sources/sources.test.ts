import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseCreateIntegration } from '../../../src/api/integration-input';
import { verifyStandardWebhook } from '../../../src/connectors/sources/generic/signature';
import { generateSigningSecret } from '../../../src/connectors/sources/generic/encoding';
import { t, tp } from '../i18n';
import { ApiError, parseIntegration } from '../lib/api';
import { isoOf, parseSource, parseSourceWithSecret, sourcesApi } from './api';
import { defaultChatName, toConnectBody, validateConnect, type ConnectDraft } from './connect';
import { SAMPLE_BODY, SECRET_ENV, bashSnippet, nodeSnippet } from './snippets';

const URL_ = 'https://noti.example/webhooks/generic/AbCdEfGhIjKlMnOpQrStUvWx';
const SLACK = 'https://hooks.slack.com/services/T000/B000/XXXX';
const SOURCE_ID = '3f2b8a52-8d3e-4c1f-9a77-0d1e5b6a7c90';
const row = {
  id: 's1',
  name: 'CI',
  kind: 'generic',
  authMode: null,
  livemode: null,
  endpointId: 'AbCdEfGhIjKlMnOpQrStUvWx',
  endpointUrl: URL_,
  enabled: true,
  createdAt: '2026-10-13 12:00:00',
  updatedAt: '2026-10-13 12:00:00',
  lastReceivedAt: null,
  secretRotatedAt: null,
  reusedIdRejections: 0,
  droppedEvents: 0,
  lastDroppedAt: null,
  integrationCount: 0,
  credentialFingerprint: null,
  revoked: false,
  keyDestroyed: false,
};

describe('parsing API responses', () => {
  it('narrows a source and rejects a malformed one loudly', () => {
    expect(parseSource(row)).toMatchObject({ id: 's1', endpointUrl: URL_, integrationCount: 0 });
    for (const bad of [
      null,
      [],
      { ...row, enabled: 'yes' },
      { ...row, integrationCount: '1' },
      { ...row, id: 1 },
    ])
      expect(() => parseSource(bad)).toThrow(ApiError);
  });

  it('only accepts a create/rotate response that carries a whsec_ secret', () => {
    const secret = generateSigningSecret();
    expect(parseSourceWithSecret({ source: row, secret }).secret).toBe(secret);
    for (const bad of [{ source: row }, { source: row, secret: 'nope' }, { source: row, secret: 5 }])
      expect(() => parseSourceWithSecret(bad)).toThrow(ApiError);
  });

  it('reads the credential fingerprint and revoked state, and refuses a row without them (F39, F40)', () => {
    expect(parseSource({ ...row, credentialFingerprint: 'P4Q2WJ7N' })).toMatchObject({
      credentialFingerprint: 'P4Q2WJ7N',
      revoked: false,
      keyDestroyed: false,
    });
    expect(parseSource({ ...row, revoked: true, keyDestroyed: true })).toMatchObject({
      revoked: true,
      keyDestroyed: true,
    });
    // A destroyed key without a revoke is not a state the server produces; it is never shown as destroyed.
    expect(parseSource({ ...row, keyDestroyed: true }).keyDestroyed).toBe(false);
    for (const field of ['credentialFingerprint', 'revoked', 'keyDestroyed'] as const) {
      const { [field]: _omit, ...without } = row;
      void _omit;
      expect(() => parseSource(without)).toThrow(ApiError);
    }
    expect(() => parseSource({ ...row, revoked: 'yes' })).toThrow(ApiError);
    expect(() => parseSource({ ...row, credentialFingerprint: 7 })).toThrow(ApiError);
  });

  it('reads sourceId on integrations and defaults old rows to null', () => {
    const base = {
      id: 'i',
      name: 'n',
      repo: '',
      eventTypes: [],
      destination: 'slack',
      destinationHost: null,
      enabled: true,
      credentials: 'ok',
      createdAt: null,
      updatedAt: null,
    };
    expect(parseIntegration({ ...base, sourceId: 's1' }).sourceId).toBe('s1');
    expect(parseIntegration(base).sourceId).toBeNull();
  });

  it('turns SQLite timestamps into ISO for <time>', () => {
    expect(isoOf('2026-10-13 12:00:00')).toBe('2026-10-13T12:00:00Z');
    expect(isoOf('2026-10-13T12:00:00Z')).toBe('2026-10-13T12:00:00Z');
  });
});

describe('connect-a-chat form', () => {
  const draft = (over: Partial<ConnectDraft> = {}): ConnectDraft => ({
    destination: 'slack',
    name: 'CI → Slack',
    webhookUrl: SLACK,
    signingSecret: '',
    ...over,
  });

  it('accepts a valid draft and builds the body the server expects', () => {
    expect(validateConnect(draft())).toEqual({});
    const body = toConnectBody(SOURCE_ID, draft({ webhookUrl: `  ${SLACK}  ` }));
    expect(body).toEqual({
      name: 'CI → Slack',
      sourceId: SOURCE_ID,
      destination: 'slack',
      webhookUrl: SLACK,
    });
    // The server accepts exactly this body.
    expect(parseCreateIntegration(body).ok).toBe(true);
  });

  it('requires a destination, a name and a URL on the right host', () => {
    expect(validateConnect(draft({ destination: null }))).toHaveProperty('destination');
    expect(validateConnect(draft({ name: '  ' }))).toHaveProperty('name');
    expect(validateConnect(draft({ webhookUrl: '' }))).toHaveProperty('webhookUrl');
    expect(validateConnect(draft({ webhookUrl: 'https://evil.example/hook' }))).toHaveProperty('webhookUrl');
    expect(toConnectBody(SOURCE_ID, draft({ destination: null }))).toBeNull();
  });

  it('only sends a signing secret for Lark and validates its shape', () => {
    const lark = draft({
      destination: 'lark',
      webhookUrl: 'https://open.larksuite.com/open-apis/bot/v2/hook/abc',
      signingSecret: 'abc def',
    });
    expect(validateConnect(lark)).toHaveProperty('signingSecret');
    const ok = toConnectBody(SOURCE_ID, { ...lark, signingSecret: 'abcdef' });
    expect(ok).toMatchObject({ signingSecret: 'abcdef' });
    expect(parseCreateIntegration(ok).ok).toBe(true);
    expect(toConnectBody(SOURCE_ID, draft({ signingSecret: 'ignored' }))).not.toHaveProperty('signingSecret');
  });

  it('proposes a bounded default name', () => {
    expect(defaultChatName('CI', 'teams')).toBe('CI → Microsoft Teams');
    expect(defaultChatName('x'.repeat(200), 'slack')).toHaveLength(80);
  });
});

describe('copy-paste examples', () => {
  it('never contain a secret, only a reference to an environment variable', () => {
    for (const code of [bashSnippet(URL_), nodeSnippet(URL_)]) {
      expect(code).toContain(SECRET_ENV);
      expect(code).not.toMatch(/whsec_[A-Za-z0-9+/]{20,}/);
      expect(code).toContain(URL_);
    }
  });

  it('the node example signs a request that the Worker verifies', async () => {
    const secret = generateSigningSecret();
    const dir = mkdtempSync(join(tmpdir(), 'noti-snippet-'));
    const file = join(dir, 'send.mjs');
    const stub =
      "globalThis.fetch = async (u, init) => { process.stdout.write(JSON.stringify({ u, h: init.headers, b: init.body }) + '\\n'); return new Response('ok'); };\n";
    writeFileSync(file, stub + nodeSnippet(URL_));
    const run = spawnSync(process.execPath, [file], {
      env: { ...process.env, [SECRET_ENV]: secret },
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    const sent = JSON.parse(run.stdout.split('\n')[0] ?? '') as {
      u: string;
      h: Record<string, string>;
      b: string;
    };
    expect(sent.u).toBe(URL_);
    expect(sent.b).toBe(SAMPLE_BODY);
    const key = Uint8Array.from(atob(secret.slice(6)), (c) => c.charCodeAt(0));
    const verdict = await verifyStandardWebhook(
      key,
      {
        id: sent.h['webhook-id'] ?? null,
        timestamp: sent.h['webhook-timestamp'] ?? null,
        signature: sent.h['webhook-signature'] ?? null,
      },
      new TextEncoder().encode(sent.b),
      Math.floor(Date.now() / 1000),
    );
    expect(verdict).toEqual({ ok: true });
  });

  const haveTools = ['openssl', 'xxd', 'bash'].every((tool) => spawnSync('which', [tool]).status === 0);
  it.skipIf(!haveTools)('the shell example signs a request that the Worker verifies', async () => {
    const secret = generateSigningSecret();
    // Run everything up to (not including) the curl line, then print what curl would send.
    const lines = bashSnippet(URL_).split('\n');
    const until = lines.findIndex((l) => l.startsWith('curl'));
    const script = `${lines.slice(0, until).join('\n')}\nprintf '%s|%s|%s|%s' "$ID" "$TS" "$SIG" "$BODY"`;
    const run = spawnSync('bash', ['-c', script], {
      env: { ...process.env, [SECRET_ENV]: secret },
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    const [id, ts, sig, body] = run.stdout.split('|');
    const key = Uint8Array.from(atob(secret.slice(6)), (c) => c.charCodeAt(0));
    const verdict = await verifyStandardWebhook(
      key,
      { id: id ?? null, timestamp: ts ?? null, signature: `v1,${sig ?? ''}` },
      new TextEncoder().encode(body ?? ''),
      Math.floor(Date.now() / 1000),
    );
    expect(verdict).toEqual({ ok: true });
    // The remaining lines are the curl call with the three headers.
    const curl = lines.slice(until).join('\n');
    for (const header of ['webhook-id', 'webhook-timestamp', 'webhook-signature'])
      expect(curl).toContain(header);
  });
});

describe('secret handling in the Sources UI', () => {
  const dir = new URL('.', import.meta.url).pathname;
  const sources = readdirSync(dir)
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.test.ts') && f !== 'snippets.ts')
    .map((f) => [f, readFileSync(join(dir, f), 'utf8')] as const);

  it('never writes anything to browser storage or the console', () => {
    for (const [file, text] of sources)
      expect(text, file).not.toMatch(/localStorage|sessionStorage|indexedDB|console\.|document\.cookie/);
  });

  it('the one-time secret is read from component state only (no cache write, no URL)', () => {
    const page = sources.find(([f]) => f === 'SourcesPage.tsx')?.[1] ?? '';
    expect(page).toMatch(/useState<Reveal \| null>/);
    expect(page).not.toMatch(/setQueryData|navigate\(|history\./);
    const hooks = sources.find(([f]) => f === 'hooks.ts')?.[1] ?? '';
    expect(hooks).not.toMatch(/setQueryData/);
    expect(hooks.match(/gcTime: 0/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('the source page (ADR 0056) holds a rotated secret the same way and navigates only to the list', () => {
    const page = sources.find(([f]) => f === 'SourceDetailPage.tsx')?.[1] ?? '';
    expect(page).toMatch(/useSourceOutcome\(\)/);
    expect([...page.matchAll(/navigate\(([^)]*)\)/g)].map((m) => m[1])).toEqual(["{ to: '/sources' }"]);
    expect(page).not.toMatch(/setQueryData|history\.|search:/);
  });
});

describe('copy', () => {
  it('states the one-time rule and the consequence of rotating in plain words', () => {
    expect(t('sources.secret.warning')).toMatch(/only time/);
    expect(t('sources.rotate.body')).toMatch(/stops working immediately/);
    expect(t('sources.delete.bodyNoChats')).toMatch(/cannot be undone/);
  });
});

describe('review hardening in the UI', () => {
  it('reads the reused-id counter and rejects a response without it', () => {
    expect(parseSource({ ...row, reusedIdRejections: 3 }).reusedIdRejections).toBe(3);
    const { reusedIdRejections: _omit, ...without } = row;
    void _omit;
    expect(() => parseSource(without)).toThrow(ApiError);
  });

  it('states the reuse rule in plain words, with a plural count', () => {
    expect(tp('sources.card.reused', 1)).toBe('1 event was rejected because its id was reused.');
    expect(tp('sources.card.reused', 4)).toBe('4 events were rejected because their id was reused.');
    expect(t('sources.card.reusedHelp')).toMatch(/409/);
    expect(t('sources.guide.sign')).toMatch(/unique per event/);
  });

  it('only sends cascade=true when chats are connected', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(url);
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    await sourcesApi.remove('org-a', 's1', false);
    await sourcesApi.remove('org-a', 's1', true);
    vi.unstubAllGlobals();
    expect(calls).toEqual(['/api/sources/s1?org=org-a', '/api/sources/s1?org=org-a&cascade=true']);
  });

  it('revokes with the chosen reason in the body, scoped to the workspace, and reads back the source', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(
        new Response(JSON.stringify({ source: { ...row, enabled: false, revoked: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    const source = await sourcesApi.revokeCredentials('org-a', 's1', 'no_longer_used');
    vi.unstubAllGlobals();
    expect(calls.map((c) => c.url)).toEqual(['/api/sources/s1/revoke-credentials?org=org-a']);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({ reason: 'no_longer_used' });
    expect(source).toMatchObject({ id: 's1', revoked: true, enabled: false });
  });

  it('hides rotate and delete from non-admins and tells them why', () => {
    const card = readFileSync(join(new URL('.', import.meta.url).pathname, 'SourceCard.tsx'), 'utf8');
    expect(card).toMatch(/isAdmin \?/);
    expect(t('sources.adminOnly')).toMatch(/admins/);
  });
});
