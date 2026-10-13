import { describe, expect, it } from 'vitest';
import { isBlockedAddress, parseIpv4, parseIpv6 } from '../../src/connectors/destinations/address-policy';
import { capabilitiesFor } from '../../src/connectors/destinations/capabilities';
import {
  validateDestinationConfig,
  type GenericWebhookDestinationConfig,
} from '../../src/connectors/destinations/config';
import { checkResolvedHost, type DnsFetcher } from '../../src/connectors/destinations/dns-check';
import { genericWebhookAdapter } from '../../src/connectors/destinations/generic-webhook/adapter';
import { checkDestinationUrl, ownHostsOf } from '../../src/connectors/destinations/url-policy';
import { fromBase64, generateSigningSecret } from '../../src/connectors/sources/generic/encoding';
import { verifyStandardWebhook } from '../../src/connectors/sources/generic/signature';
import { BASE, GENERIC_URL, NOW, response } from './fixtures';

const caps = capabilitiesFor('generic_webhook');
const META = { deliveryId: 'delivery-abc-123', organizationId: 'org-1' } as const;

function config(url = GENERIC_URL, signingSecret = generateSigningSecret()): GenericWebhookDestinationConfig {
  const r = validateDestinationConfig({ kind: 'generic_webhook', webhookUrl: url, signingSecret });
  if (!r.ok || r.config.kind !== 'generic_webhook') throw new Error('config');
  return r.config;
}

function render(n = BASE) {
  const r = genericWebhookAdapter.render(n, caps);
  if (!r.ok) throw new Error('render failed: ' + r.reason);
  return r.message;
}

describe('customer URL policy (F115): shape rules, before any DNS', () => {
  it.each([
    'https://hooks.example.com/noti',
    'https://a.b.example.co.uk/x?token=abc',
    'https://xn--bcher-kva.de/hook',
    'https://hooks.example.com:443/noti',
  ])('accepts %s', (url) => {
    expect(checkDestinationUrl('generic_webhook', url).ok).toBe(true);
  });

  it.each([
    ['http://hooks.example.com/x', 'scheme'],
    ['ftp://hooks.example.com/x', 'scheme'],
    ['file:///etc/passwd', 'scheme'],
    ['data:text/plain,hi', 'scheme'],
    ['gopher://hooks.example.com/x', 'scheme'],
    ['https://user:pw@hooks.example.com/x', 'userinfo'],
    ['https://user@hooks.example.com/x', 'userinfo'],
    ['https://hooks.example.com/x#frag', 'fragment'],
    ['https://hooks.example.com:8443/x', 'port'],
    ['https://hooks.example.com:80/x', 'port'],
  ])('rejects %s on %s', (url, rule) => {
    expect(checkDestinationUrl('generic_webhook', url)).toMatchObject({ ok: false, rule });
  });

  // Every IP notation. The WHATWG parser normalises all of these to dotted quad, which is
  // then refused as an IP literal; the rest never parse.
  it.each([
    'https://127.0.0.1/x',
    'https://10.0.0.5/x',
    'https://169.254.169.254/latest/meta-data/',
    'https://192.168.1.1/x',
    'https://0.0.0.0/x',
    'https://2130706433/x', // decimal
    'https://0x7f000001/x', // hexadecimal integer
    'https://0x7f.0.0.1/x', // hexadecimal octet
    'https://0177.0.0.1/x', // octal
    'https://127.1/x', // short form
    'https://127.0.1/x',
    'https://017700000001/x', // octal integer
    'https://%31%32%37.0.0.1/x', // percent-encoded
    'https://１２７.０.０.１/x', // fullwidth digits
    'https://[::1]/x',
    'https://[::ffff:127.0.0.1]/x',
    'https://[fe80::1]/x',
    'https://[fd00::1]/x',
    'https://[2001:db8::1]/x',
    'https://[::]/x',
  ])('rejects the IP literal %s', (url) => {
    const r = checkDestinationUrl('generic_webhook', url);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(['ip_literal', 'malformed', 'host']).toContain(r.rule);
  });

  it.each([
    'https://localhost/x',
    'https://LOCALHOST/x',
    'https://localhost./x',
    'https://app.localhost/x',
    'https://printer.local/x',
    'https://metadata.google.internal/computeMetadata/v1/',
    'https://db.internal/x',
    'https://nas.home/x',
    'https://router.lan/x',
    'https://intranet.corp/x',
    'https://wiki.intranet/x',
    'https://x.private/x',
    'https://x.localdomain/x',
    'https://x.test/x',
    'https://x.example/x',
    'https://x.invalid/x',
    'https://x.onion/x',
    'https://1.0.0.127.in-addr.arpa/x',
    'https://x.home.arpa/x',
    'https://metadata/x', // a single label
    'https://intranet/x',
    'https://hooks.example.com./x', // trailing dot evades suffix checks
    'https://127.0.0.1.nip.io/x', // wildcard DNS to an IP
    'https://10.0.0.1.sslip.io/x',
    'https://localtest.me/x',
    'https://anything.lvh.me/x',
    'https://noti.runlumi.app/webhooks/generic/abc', // our own ingress: no loops
    'https://runlumi.app/x',
    'https://svc.account.workers.dev/x', // Cloudflare-hosted infrastructure
    'https://workers.dev/x',
    'https://site.pages.dev/x',
    'https://pages.dev/x',
    'https://abc.cfargotunnel.com/x',
    'https://a.b.cfargotunnel.com/x',
  ])('rejects the internal or self-referential host %s', (url) => {
    const r = checkDestinationUrl('generic_webhook', url);
    expect(r.ok).toBe(false);
  });

  it('also blocks the host of APP_ORIGIN and its parent domain, whatever the deployment is called', () => {
    const own = ownHostsOf('https://noti.example.org');
    expect(own).toEqual(['noti.example.org', 'example.org']);
    for (const url of [
      'https://noti.example.org/x',
      'https://api.noti.example.org/x',
      'https://example.org/x',
      'https://www.example.org/x',
    ])
      expect(checkDestinationUrl('generic_webhook', url, { ownHosts: own })).toMatchObject({
        ok: false,
        rule: 'internal_host',
      });
    // Without the option these are ordinary public hosts, so the option is what blocks them.
    expect(checkDestinationUrl('generic_webhook', 'https://noti.example.org/x').ok).toBe(true);
    expect(checkDestinationUrl('generic_webhook', 'https://notexample.org/x', { ownHosts: own }).ok).toBe(
      true,
    );
    expect(ownHostsOf('https://localhost:8787')).toEqual(['localhost']);
    expect(ownHostsOf(undefined)).toEqual([]);
    expect(ownHostsOf('not a url')).toEqual([]);
  });

  it('applies the own-host rule through validateDestinationConfig (save time and send time)', () => {
    const r = validateDestinationConfig(
      {
        kind: 'generic_webhook',
        webhookUrl: 'https://noti.example.org/x',
        signingSecret: generateSigningSecret(),
      },
      { ownHosts: ownHostsOf('https://noti.example.org') },
    );
    expect(r).toMatchObject({ ok: false, reason: 'destination_url_rejected', rule: 'internal_host' });
  });

  it('does not treat look-alikes of blocked domains as blocked', () => {
    expect(checkDestinationUrl('generic_webhook', 'https://notrunlumi.app/x').ok).toBe(true);
    expect(checkDestinationUrl('generic_webhook', 'https://runlumi.app.example.com/x').ok).toBe(true);
    expect(checkDestinationUrl('generic_webhook', 'https://localhost.example.com/x').ok).toBe(true);
  });

  it('rejects over-long URLs and hostnames, and malformed input', () => {
    expect(
      checkDestinationUrl('generic_webhook', 'https://hooks.example.com/' + 'a'.repeat(2100)),
    ).toMatchObject({
      rule: 'too_long',
    });
    const longHost = Array.from({ length: 5 }, () => 'a'.repeat(60)).join('.') + '.com';
    expect(checkDestinationUrl('generic_webhook', `https://${longHost}/x`).ok).toBe(false);
    expect(checkDestinationUrl('generic_webhook', 'not a url')).toMatchObject({ ok: false });
    expect(checkDestinationUrl('generic_webhook', 'https://hooks.example.com/ x')).toMatchObject({
      rule: 'whitespace_or_control',
    });
  });

  it('is one function for save time and send time: the same verdicts everywhere', () => {
    // `sendRequest` calls `checkDestinationUrl(request.kind, request.url)`; there is no second
    // implementation to diverge. A stored row altered to an internal host is refused there too.
    const cfg = validateDestinationConfig({
      kind: 'generic_webhook',
      webhookUrl: 'https://127.0.0.1/x',
      signingSecret: generateSigningSecret(),
    });
    expect(cfg).toMatchObject({ ok: false, reason: 'destination_url_rejected' });
  });

  it('rejection results never echo the submitted URL', () => {
    const r = checkDestinationUrl('generic_webhook', 'https://user:MARKER@internal.example.internal/x');
    expect(JSON.stringify(r)).not.toContain('MARKER');
  });
});

describe('resolved-address policy', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '169.254.169.254',
    '169.254.0.1',
    '0.0.0.0',
    '0.1.2.3',
    '100.64.0.1',
    '192.0.2.1',
    '198.51.100.1',
    '203.0.113.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '240.0.0.1',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.1.2.3',
    '::ffff:169.254.169.254',
    '::ffff:7f00:1',
    '64:ff9b::a00:1', // NAT64 of 10.0.1.0
    '64:ff9b::7f00:1',
    '2001:db8::1',
    '2001::1',
    '2002:7f00:1::1', // 6to4
    '100::1',
    'not-an-ip',
    '',
    '1.2.3',
    '01.2.3.4',
    '256.1.1.1',
    'fe80::1%eth0',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.15.255.255',
    '172.32.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '169.253.0.1',
    '192.0.3.1',
    '203.0.114.1',
    '2606:4700:4700::1111',
    '2a00:1450:4001:81b::200e',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
  ])('allows the public address %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it('parses IPv4 and IPv6 strictly', () => {
    expect(parseIpv4('1.2.3.4')).toBe(16909060);
    expect(parseIpv4('1.2.3.04')).toBeNull();
    expect(parseIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIpv6('1::2::3')).toBeNull();
    expect(parseIpv6('12345::')).toBeNull();
  });
});

describe('save-time DNS verification', () => {
  function doh(answers: Record<string, { status?: number; data?: string[] } | 'fail'>): DnsFetcher {
    return (input) => {
      const url = new URL(input);
      const key = `${url.searchParams.get('name')}/${url.searchParams.get('type')}`;
      const a = answers[key] ?? { data: [] };
      if (a === 'fail') return Promise.reject(new TypeError('network'));
      const type = url.searchParams.get('type') === 'A' ? 1 : 28;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            Status: a.status ?? 0,
            ...(a.data?.length ? { Answer: a.data.map((data) => ({ name: 'x', type, TTL: 60, data })) } : {}),
          }),
          { status: 200 },
        ),
      );
    };
  }

  it('accepts a host whose A and AAAA records are public', async () => {
    const r = await checkResolvedHost(
      'hooks.example.com',
      doh({ 'hooks.example.com/A': { data: ['93.184.216.34'] }, 'hooks.example.com/AAAA': { data: [] } }),
    );
    expect(r).toEqual({ ok: true, addresses: ['93.184.216.34'] });
  });

  it('refuses a host with any private A record, including the metadata address', async () => {
    for (const bad of ['169.254.169.254', '10.0.0.1', '127.0.0.1']) {
      const r = await checkResolvedHost(
        'x.example.com',
        doh({ 'x.example.com/A': { data: ['8.8.8.8', bad] } }),
      );
      expect(r).toEqual({ ok: false, reason: 'blocked_address' });
    }
  });

  it('refuses a host with a private AAAA record', async () => {
    const r = await checkResolvedHost(
      'x.example.com',
      doh({ 'x.example.com/A': { data: ['8.8.8.8'] }, 'x.example.com/AAAA': { data: ['::1'] } }),
    );
    expect(r).toEqual({ ok: false, reason: 'blocked_address' });
  });

  it('refuses a blocked address even when the other family lookup failed', async () => {
    const r = await checkResolvedHost(
      'x.example.com',
      doh({ 'x.example.com/A': { data: ['10.0.0.1'] }, 'x.example.com/AAAA': 'fail' }),
    );
    expect(r).toEqual({ ok: false, reason: 'blocked_address' });
  });

  it('fails closed when the lookup fails, and says a name that does not exist is unresolvable', async () => {
    expect(await checkResolvedHost('x.example.com', doh({ 'x.example.com/A': 'fail' }))).toEqual({
      ok: false,
      reason: 'lookup_failed',
    });
    expect(
      await checkResolvedHost(
        'x.example.com',
        doh({ 'x.example.com/A': { status: 2 }, 'x.example.com/AAAA': {} }),
      ),
    ).toEqual({ ok: false, reason: 'lookup_failed' });
    expect(
      await checkResolvedHost(
        'x.example.com',
        doh({ 'x.example.com/A': { status: 3 }, 'x.example.com/AAAA': { status: 3 } }),
      ),
    ).toEqual({ ok: false, reason: 'unresolvable' });
  });

  it('refuses a public name that is an alias for an internal or own-infrastructure name', async () => {
    const aliasTo =
      (target: string): DnsFetcher =>
      (input) => {
        const isA = new URL(input).searchParams.get('type') === 'A';
        return Promise.resolve(
          new Response(
            JSON.stringify({
              Status: 0,
              Answer: [
                { name: 'x', type: 5, TTL: 1, data: target },
                ...(isA ? [{ name: target, type: 1, TTL: 1, data: '93.184.216.34' }] : []),
              ],
            }),
          ),
        );
      };
    for (const target of [
      'db.internal.',
      'metadata.google.internal.',
      'printer.local.',
      'localhost.',
      'intranet.',
      'svc.workers.dev.',
      'abc.cfargotunnel.com.',
      'x.nip.io.',
      'noti.example.org.',
      '127.0.0.1.',
    ]) {
      expect(
        await checkResolvedHost('x.example.com', aliasTo(target), {
          ownHosts: ownHostsOf('https://noti.example.org'),
        }),
        target,
      ).toEqual({ ok: false, reason: 'blocked_address' });
    }
    expect(await checkResolvedHost('x.example.com', aliasTo('cdn.example.net.'))).toMatchObject({ ok: true });
  });

  it('ignores CNAME records and does not follow redirects or trust a non-200', async () => {
    const fetcher: DnsFetcher = (_input, init) => {
      expect(init.redirect).toBe('manual');
      return Promise.resolve(new Response('{}', { status: 302 }));
    };
    expect(await checkResolvedHost('x.example.com', fetcher)).toEqual({ ok: false, reason: 'lookup_failed' });
    const cname: DnsFetcher = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ Status: 0, Answer: [{ name: 'x', type: 5, TTL: 1, data: 'y.example.com.' }] }),
        ),
      );
    expect(await checkResolvedHost('x.example.com', cname)).toEqual({ ok: false, reason: 'unresolvable' });
  });
});

describe('payload and signing (F116: Standard Webhooks, producer side)', () => {
  it('renders the canonical JSON event with bounded, un-escaped text', () => {
    const m = render({ ...BASE, summary: 'a < b & `c`', title: 'x'.repeat(5000) });
    const n = (m.payload as { notification: { title: string; summary: string } }).notification;
    expect(n.summary).toBe('a < b & `c`');
    expect(n.title.length).toBeLessThanOrEqual(caps.maxTitleChars);
    expect(n.title.endsWith('…')).toBe(true);
    expect(m.truncatedFields).toContain('title');
    expect(m.payload).toMatchObject({ version: 1, type: 'noti.notification' });
  });

  it('keeps the whole body, envelope included, inside the byte budget', async () => {
    const m = render({ ...BASE, summary: '漢'.repeat(20_000), title: '😀'.repeat(900) });
    const req = await genericWebhookAdapter.buildRequest(m, config(), NOW, META);
    expect(new TextEncoder().encode(req.body).length).toBeLessThanOrEqual(caps.maxBodyBytes);
  });

  it('sends the three Standard Webhooks headers and a signature the receiver verifies', async () => {
    const secret = generateSigningSecret();
    const req = await genericWebhookAdapter.buildRequest(render(), config(GENERIC_URL, secret), NOW, META);
    expect(req.method).toBe('POST');
    expect(req.url).toBe(GENERIC_URL);
    expect(req.headers['content-type']).toContain('application/json');
    expect(req.headers['webhook-id']).toBe(META.deliveryId);
    expect(req.headers['webhook-timestamp']).toBe(String(Math.floor(NOW / 1000)));
    const key = fromBase64(secret.slice('whsec_'.length));
    if (!key) throw new Error('key');
    const verdict = await verifyStandardWebhook(
      key,
      {
        id: req.headers['webhook-id'] ?? null,
        timestamp: req.headers['webhook-timestamp'] ?? null,
        signature: req.headers['webhook-signature'] ?? null,
      },
      new TextEncoder().encode(req.body),
      Math.floor(NOW / 1000),
    );
    expect(verdict).toEqual({ ok: true });
  });

  it('a signature does not verify for a different body, secret or id', async () => {
    const secret = generateSigningSecret();
    const req = await genericWebhookAdapter.buildRequest(render(), config(GENERIC_URL, secret), NOW, META);
    const headers = {
      id: req.headers['webhook-id'] ?? null,
      timestamp: req.headers['webhook-timestamp'] ?? null,
      signature: req.headers['webhook-signature'] ?? null,
    };
    const key = fromBase64(secret.slice(6));
    const other = fromBase64(generateSigningSecret().slice(6));
    if (!key || !other) throw new Error('key');
    const now = Math.floor(NOW / 1000);
    const bytes = (s: string) => new TextEncoder().encode(s);
    expect(await verifyStandardWebhook(key, headers, bytes(req.body + ' '), now)).toMatchObject({
      ok: false,
    });
    expect(await verifyStandardWebhook(other, headers, bytes(req.body), now)).toMatchObject({ ok: false });
    expect(
      await verifyStandardWebhook(key, { ...headers, id: 'other-id' }, bytes(req.body), now),
    ).toMatchObject({
      ok: false,
    });
  });

  it('keeps webhook-id stable across our retries while the timestamp and signature move', async () => {
    const cfg = config();
    const a = await genericWebhookAdapter.buildRequest(render(), cfg, NOW, META);
    const b = await genericWebhookAdapter.buildRequest(render(), cfg, NOW + 90_000, META);
    expect(b.headers['webhook-id']).toBe(a.headers['webhook-id']);
    expect(b.headers['webhook-timestamp']).not.toBe(a.headers['webhook-timestamp']);
    expect(b.headers['webhook-signature']).not.toBe(a.headers['webhook-signature']);
    expect(JSON.parse(b.body)).toMatchObject({ id: META.deliveryId, workspaceId: META.organizationId });
  });

  it('carries our ids and the event type as headers, and no customer-supplied header', async () => {
    const req = await genericWebhookAdapter.buildRequest(render(), config(), NOW, META);
    expect(req.headers['x-noti-delivery-id']).toBe(META.deliveryId);
    expect(req.headers['x-noti-event-type']).toBe('workflow_run.failure');
    expect(Object.keys(req.headers).sort()).toEqual(
      [
        'content-type',
        'user-agent',
        'webhook-id',
        'webhook-signature',
        'webhook-timestamp',
        'x-noti-delivery-id',
        'x-noti-event-type',
      ].sort(),
    );
  });

  it('drops an event type that is not header-safe instead of forwarding it', async () => {
    const req = await genericWebhookAdapter.buildRequest(
      render({ ...BASE, eventType: 'x\r\nInjected: 1' }),
      config(),
      NOW,
      META,
    );
    expect(Object.keys(req.headers)).not.toContain('x-noti-event-type');
    expect(JSON.stringify(req.headers)).not.toContain('Injected');
  });

  it('never sends an unsigned request: a bad secret or delivery id throws before any request exists', async () => {
    const m = render();
    const good = config();
    await expect(
      genericWebhookAdapter.buildRequest(m, { ...good, signingSecret: 'whsec_AAAA' }, NOW, META),
    ).rejects.toThrow('signing_secret_invalid');
    await expect(
      genericWebhookAdapter.buildRequest(m, { ...good, signingSecret: '' }, NOW, META),
    ).rejects.toThrow();
    await expect(genericWebhookAdapter.buildRequest(m, good, NOW)).rejects.toThrow('delivery_id_invalid');
    await expect(
      genericWebhookAdapter.buildRequest(m, good, NOW, { ...META, deliveryId: 'a.b' }),
    ).rejects.toThrow('delivery_id_invalid');
  });

  it('refuses configuration without a well-formed signing secret', () => {
    for (const signingSecret of [undefined, '', 'abc', 'whsec_', 'whsec_AAAA', 'whsec_' + 'A'.repeat(20)]) {
      expect(
        validateDestinationConfig({ kind: 'generic_webhook', webhookUrl: GENERIC_URL, signingSecret }),
      ).toMatchObject({ ok: false, reason: 'config_invalid', field: 'signingSecret' });
    }
  });
});

describe('customer endpoint classifier (F117)', () => {
  const classify = (status: number, body = '', headers = {}) =>
    genericWebhookAdapter.classifyResponse(response(status, body, headers), NOW);

  it.each([
    [200, 'delivered', 'ok'],
    [201, 'delivered', 'ok'],
    [204, 'delivered', 'ok'],
    [202, 'accepted', 'ok'],
    [301, 'permanent', 'destination_redirected'],
    [302, 'permanent', 'destination_redirected'],
    [307, 'permanent', 'destination_redirected'],
    [0, 'permanent', 'destination_redirected'],
    [400, 'permanent', 'payload_rejected'],
    [422, 'permanent', 'payload_rejected'],
    [401, 'permanent', 'destination_unauthorized'],
    [403, 'permanent', 'destination_unauthorized'],
    [404, 'permanent', 'destination_revoked'],
    [410, 'permanent', 'destination_revoked'],
    [405, 'permanent', 'destination_revoked'],
    [501, 'permanent', 'destination_revoked'],
    [413, 'permanent', 'payload_too_large'],
    [408, 'retryable', 'destination_timeout'],
    [425, 'retryable', 'destination_unavailable'],
    [429, 'retryable', 'destination_rate_limited'],
    [500, 'retryable', 'destination_unavailable'],
    [502, 'retryable', 'destination_unavailable'],
    [503, 'retryable', 'destination_unavailable'],
  ])('maps HTTP %i to %s %s', (status, outcome, reason) => {
    expect(classify(status)).toMatchObject({ outcome, reason });
  });

  it('treats an unknown 4xx as permanent (a retry cannot fix it) and flags it for the metric', () => {
    for (const status of [409, 415, 418, 451]) {
      expect(classify(status)).toEqual({ outcome: 'permanent', reason: 'payload_rejected', unmapped: true });
    }
  });

  it('is total: every status maps to a defined outcome and nothing unexpected is silently delivered', () => {
    for (let status = 100; status <= 599; status++) {
      const r = classify(status);
      expect(['delivered', 'accepted', 'retryable', 'permanent']).toContain(r.outcome);
      if (status < 200 || status > 299) expect(['delivered', 'accepted']).not.toContain(r.outcome);
    }
  });

  it('honours Retry-After on 429 and 503 in both forms', () => {
    expect(classify(429, '', { 'retry-after': '12' })).toMatchObject({ retryAfterMs: 12_000 });
    expect(classify(503, '', { 'retry-after': 'Tue, 13 Oct 2026 00:01:00 GMT' })).toMatchObject({
      retryAfterMs: 60_000,
    });
  });

  it('retry class never depends on the response body, and the body is never copied out', () => {
    const hostile = '{"ok":true,"status":"success","note":"https://hooks.example.com/x?token=SECRETTOKEN"}';
    expect(classify(500, hostile)).toMatchObject({ outcome: 'retryable' });
    expect(classify(400, hostile)).toMatchObject({ outcome: 'permanent' });
    expect(JSON.stringify(classify(400, hostile))).not.toContain('SECRETTOKEN');
  });

  it('declares the capabilities it really has', () => {
    expect(caps).toMatchObject({
      signing: 'standard_webhooks_v1',
      formats: ['card'],
      supportsMentions: false,
      canUpdate: false,
      supportsServerSideIdempotency: false,
    });
  });
});
