import { describe, expect, it } from 'vitest';
import {
  DELIVERY_REASONS,
  capabilitiesFor,
  classifyDeliveryResponse,
  classifyTransportError,
  deliver,
  discordAdapter,
  genericWebhookAdapter,
  larkAdapter,
  prepareDelivery,
  sendRequest,
  slackAdapter,
  teamsAdapter,
  validateDestinationConfig,
  type DestinationKind,
  type Fetcher,
} from '../../src/connectors/destinations';
import { runLadder } from '../../src/connectors/destinations/render';
import { generateSigningSecret } from '../../src/connectors/sources/generic/encoding';
import { BASE, DISCORD_URL, GENERIC_URL, LARK_URL, NOW, SLACK_URL, TEAMS_URL, response } from './fixtures';

const ADAPTERS = [slackAdapter, teamsAdapter, larkAdapter, discordAdapter, genericWebhookAdapter] as const;
const URLS: Record<DestinationKind, string> = {
  slack: SLACK_URL,
  teams: TEAMS_URL,
  lark: LARK_URL,
  discord: DISCORD_URL,
  generic_webhook: GENERIC_URL,
};
const META = { deliveryId: 'delivery-fixture-1', organizationId: 'org-fixture-1' } as const;

function validConfig(kind: DestinationKind) {
  const r = validateDestinationConfig({
    kind,
    webhookUrl: URLS[kind],
    // A custom webhook has no unsigned mode, so its config needs a secret (built at runtime).
    ...(kind === 'generic_webhook' ? { signingSecret: generateSigningSecret() } : {}),
  });
  if (!r.ok) throw new Error('config');
  return r.config;
}

describe('capability matrix (DESTINATION_API_REFERENCE.md §7)', () => {
  it('matches the verified provider limits', () => {
    const golden = Object.fromEntries(
      (['slack', 'teams', 'lark', 'discord', 'generic_webhook'] as const).map((k) => {
        const c = capabilitiesFor(k);
        return [
          k,
          [
            c.maxBodyBytes,
            c.successSemantics,
            c.canUpdate,
            c.canReply,
            c.supportsServerSideIdempotency,
            c.signing,
          ],
        ];
      }),
    );
    expect(golden).toEqual({
      slack: [40_000, 'delivered', false, false, false, 'none'],
      teams: [28_000, 'accepted', false, false, false, 'none'],
      lark: [20_000, 'delivered', false, false, false, 'lark_hmac_sha256'],
      discord: [40_000, 'delivered', false, false, false, 'none'],
      generic_webhook: [64_000, 'delivered', false, false, false, 'standard_webhooks_v1'],
    });
  });

  it('suppresses mentions and callbacks on every destination', () => {
    for (const k of ['slack', 'teams', 'lark', 'discord', 'generic_webhook'] as const) {
      expect(capabilitiesFor(k).supportsMentions).toBe(false);
      expect(capabilitiesFor(k).supportsCallbacks).toBe(false);
    }
  });
});

describe.each(ADAPTERS)('$kind adapter conformance', (adapter) => {
  const caps = capabilitiesFor(adapter.kind);

  it('render is deterministic and does not mutate its input', () => {
    const input = structuredClone(BASE);
    const frozen = Object.freeze({ ...input });
    expect(adapter.render(frozen, caps)).toEqual(adapter.render(frozen, caps));
    expect(frozen).toEqual(input);
  });

  it('renders every rung in the declared ladder', () => {
    for (const startAt of caps.formats) {
      const r = adapter.render(BASE, caps, { startAt });
      expect(r.ok && r.message.format).toBe(startAt);
    }
  });

  it('renders an empty title as a visible placeholder', () => {
    const r = adapter.render({ ...BASE, title: '   ' }, caps);
    expect(r.ok && JSON.stringify(r.message.payload)).toContain('Untitled event');
  });

  it('classification is total over status codes and never echoes bodies', () => {
    for (let status = 100; status <= 599; status++) {
      const r = adapter.classifyResponse(response(status, 'https://secret.example/token'), NOW);
      expect(['delivered', 'accepted', 'retryable', 'permanent']).toContain(r.outcome);
      expect(DELIVERY_REASONS).toContain(r.reason);
      expect(JSON.stringify(r)).not.toContain('secret');
    }
  });

  it('never reports a delivery the provider cannot confirm', () => {
    const outcomes = [200, 201, 202, 204].map(
      (s) => adapter.classifyResponse(response(s, 'ok'), NOW).outcome,
    );
    if (caps.successSemantics === 'accepted') expect(outcomes).not.toContain('delivered');
  });
});

describe('degradation ladder', () => {
  it('steps down a rung when the richer one does not fit, and reports it', () => {
    const caps = { ...capabilitiesFor('slack'), maxBodyBytes: 30 };
    const r = runLadder({
      kind: 'slack',
      caps,
      redactedFields: [],
      rungs: {
        card: () => ({ payload: { text: 'x'.repeat(100) }, truncatedFields: [] }),
        markdown: () => ({ payload: { text: 'x'.repeat(50) }, truncatedFields: [] }),
        plain: () => ({ payload: { text: 'short' }, truncatedFields: [] }),
      },
    });
    expect(r).toMatchObject({ ok: true, message: { format: 'plain', degradedFrom: ['card', 'markdown'] } });
  });

  it('fails with payload_too_large rather than dropping silently', () => {
    const caps = { ...capabilitiesFor('slack'), maxBodyBytes: 5 };
    const r = runLadder({
      kind: 'slack',
      caps,
      redactedFields: [],
      rungs: { plain: () => ({ payload: { text: 'too long' }, truncatedFields: [] }) },
    });
    expect(r).toEqual({ ok: false, reason: 'payload_too_large' });
    expect(runLadder({ kind: 'slack', caps, redactedFields: [], rungs: {} })).toEqual({
      ok: false,
      reason: 'render_failed',
    });
  });
});

describe('prepare, send and classify', () => {
  it('prepareDelivery builds a request for every kind', async () => {
    for (const kind of ['slack', 'teams', 'lark', 'discord', 'generic_webhook'] as const) {
      const r = await prepareDelivery(validConfig(kind), BASE, { now: NOW, meta: META });
      // Discord's request URL is the documented versioned endpoint with `wait=true` added.
      const expected = kind === 'discord' ? new URL(URLS[kind]) : new URL(URLS[kind]);
      if (kind === 'discord') {
        expected.pathname = expected.pathname.replace('/api/', '/api/v10/');
        expected.searchParams.set('wait', 'true');
      }
      expect(r.ok && r.request.url).toBe(expected.href);
    }
  });

  it('classifyDeliveryResponse dispatches per kind', () => {
    expect(classifyDeliveryResponse('teams', response(202), NOW).outcome).toBe('accepted');
    expect(classifyDeliveryResponse('slack', response(200, 'ok'), NOW).outcome).toBe('delivered');
    expect(classifyDeliveryResponse('lark', response(200, '{"code":0}'), NOW).outcome).toBe('delivered');
    expect(classifyDeliveryResponse('discord', response(200, '{}'), NOW).outcome).toBe('delivered');
    expect(classifyDeliveryResponse('generic_webhook', response(202), NOW).outcome).toBe('accepted');
  });

  it('sends with redirect: manual and a timeout signal, and reads a bounded body', async () => {
    let seen: RequestInit | undefined;
    const fetcher: Fetcher = (_url, init) => {
      seen = init;
      return Promise.resolve(new Response('ok' + 'x'.repeat(10_000), { status: 200 }));
    };
    const r = await deliver(validConfig('slack'), BASE, { fetch: fetcher, now: () => NOW });
    expect(seen?.redirect).toBe('manual');
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
    // The oversized body is not a bare `ok`, so it is not counted as delivered.
    expect(r.classification).toMatchObject({ outcome: 'retryable', unmapped: true });
  });

  it('reports Teams success as accepted end to end', async () => {
    const fetcher: Fetcher = () => Promise.resolve(new Response(null, { status: 202 }));
    const r = await deliver(validConfig('teams'), BASE, { fetch: fetcher });
    expect(r.classification).toEqual({ outcome: 'accepted', reason: 'ok' });
  });

  it('re-checks the URL policy at send time', async () => {
    let called = false;
    const fetcher: Fetcher = () => {
      called = true;
      return Promise.resolve(new Response('ok'));
    };
    const r = await sendRequest(
      { kind: 'slack', url: 'https://evil.example/services/x', method: 'POST', headers: {}, body: '{}' },
      () => ({ outcome: 'delivered', reason: 'ok' }),
      { fetch: fetcher },
    );
    expect(called).toBe(false);
    expect(r).toEqual({ outcome: 'permanent', reason: 'destination_url_rejected' });
  });

  it('does not retry a 2xx whose body then errors, which would duplicate the message', async () => {
    const broken = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('stream reset');
      },
    });
    const fetcher: Fetcher = () => Promise.resolve(new Response(broken, { status: 200 }));
    const r = await sendRequest(
      { kind: 'slack', url: SLACK_URL, method: 'POST', headers: {}, body: '{}' },
      (res) => ({ outcome: res.status === 200 ? 'delivered' : 'retryable', reason: 'ok' }),
      { fetch: fetcher },
    );
    expect(r.outcome).toBe('delivered');
  });

  it('classifies transport failures', async () => {
    const fetcher: Fetcher = () => Promise.reject(new TypeError('network down'));
    const r = await deliver(validConfig('lark'), BASE, { fetch: fetcher });
    expect(r.classification).toEqual({ outcome: 'retryable', reason: 'network_error' });
    expect(classifyTransportError(new DOMException('t', 'TimeoutError'))).toMatchObject({
      reason: 'destination_timeout',
    });
    expect(classifyTransportError('weird')).toMatchObject({ reason: 'internal_error' });
  });
});
