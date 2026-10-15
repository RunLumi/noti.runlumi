import { describe, expect, it, vi, afterEach, beforeEach, type Mock } from 'vitest';
import type { Bindings, DeliveryMessage } from '../../src/env';
import {
  classifyDeliveryResponse,
  checkDestinationUrl,
  deliver,
  sendRequest,
  validateDestinationConfig,
  type DestinationKind,
  type Fetcher,
  type ValidatedDestinationConfig,
} from '../../src/connectors/destinations';
import { DOH_ENDPOINT, checkResolvedHost } from '../../src/connectors/destinations/dns-check';
import { isAllowedHost, registryEntryFor } from '../../src/connectors/destinations/provider-registry';
import { generateSigningSecret } from '../../src/connectors/sources/generic/encoding';
import { hostVerificationError } from '../../src/api/destination-host';
import { ALERT_IDS } from '../../src/observability/alerts/registry';
import { resolveWebhookTarget, webhookSink, type AlertEvent } from '../../src/observability/alerts/sinks';
import { consumeDeliveries, type ConsumerDeps } from '../../src/pipeline/consumer';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';
import { legacySeal } from '../support/legacy';
import { BASE, NOW } from '../destinations/fixtures';

/**
 * credential_is_never_sent_to_a_host_other_than_its_own (spec 15, F228).
 *
 * A destination's credential is its URL (Slack, Teams, Lark, Discord, the custom webhook) or a signing
 * secret (Lark, the custom webhook). Each one is validated against the host it belongs to, and this file
 * drives every real outbound path with a planted, unique marker in the credential and records every
 * request the code would put on the wire:
 *
 *   - `deliver` (render, build, send, classify) for every destination kind;
 *   - `sendRequest` with a URL registered for a different kind;
 *   - the redirect path;
 *   - the alert webhook sink (the operator's credential, same policy);
 *   - the save-time DNS lookup for a custom host (`hostVerificationError`);
 *   - the delivery consumer, with a stored credential that does not belong to the integration's kind.
 *
 * The invariant checked on every recorded request: if a planted marker appears anywhere on the wire
 * (URL, header or body), the request goes to the host that marker was registered for, and a signing
 * secret never appears on the wire at all (it is only used to compute a signature).
 *
 * Every value is a fixture built here. No provider is contacted; `fetch` is replaced by a recorder.
 */

type Kind = Extract<DestinationKind, 'slack' | 'teams' | 'lark' | 'discord' | 'generic_webhook'>;
const REGISTRY_KINDS = ['slack', 'teams', 'lark', 'discord'] as const;

const MARK = {
  slack: 'BindFixtureSlackPath',
  teams: 'BindFixtureTeamsSig',
  lark: 'BindFixtureLarkPath',
  discord: 'BindFixtureDiscordToken',
  generic: 'BindFixtureGenericPath',
} as const;

const URL_OF: Record<Kind, string> = {
  slack: `https://hooks.slack.com/services/T0BIND01/B0BIND01/${MARK.slack}`,
  teams: `https://prod-12.westus.logic.azure.com/workflows/bindfixture/triggers/manual/paths/invoke?sig=${MARK.teams}`,
  lark: `https://open.larksuite.com/open-apis/bot/v2/hook/${MARK.lark}`,
  discord: `https://discord.com/api/webhooks/123456789012345678/${MARK.discord}`,
  generic_webhook: `https://hooks.example.com/noti/inbound/${MARK.generic}?channel=ci`,
};

const HOST_OF: Record<Kind, string> = {
  slack: 'hooks.slack.com',
  teams: 'prod-12.westus.logic.azure.com',
  lark: 'open.larksuite.com',
  discord: 'discord.com',
  generic_webhook: 'hooks.example.com',
};

const META = { deliveryId: 'delivery-binding-1', organizationId: 'org-binding' } as const;

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly redirect: unknown;
}

/** A fetch stand-in that records each request and answers with the given response. */
function recorder(respond: () => Response = () => new Response('ok', { status: 200 })) {
  const sent: Sent[] = [];
  const fetch: Fetcher = (input, init) => {
    sent.push({
      url: input,
      method: String(init.method),
      headers: headerRecord(init.headers),
      body: typeof init.body === 'string' ? init.body : '',
      redirect: init.redirect,
    });
    return Promise.resolve(respond());
  };
  return { fetch, sent };
}

/** Everything a request puts on the wire, as one string. */
/** A plain record of a request's headers (the DOM lib in this project has no Headers iteration). */
function headerRecord(init: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

const surfaceOf = (c: Sent): string => [c.url, ...Object.values(c.headers), c.body].join('\n');

interface Planted {
  readonly label: string;
  readonly marker: string;
  readonly host: string;
}

/**
 * The binding invariant. A marker that appears on the wire must be on a request to its own host; a
 * `hidden` value (a signing secret) must not appear on the wire at all.
 */
function expectBound(
  sent: readonly Sent[],
  planted: readonly Planted[],
  hidden: readonly string[] = [],
): void {
  for (const call of sent) {
    const host = new URL(call.url).hostname;
    const surface = surfaceOf(call);
    for (const p of planted) {
      if (surface.includes(p.marker)) expect(host, `${p.label} was sent to ${host}`).toBe(p.host);
    }
    for (const secret of hidden) expect(surface, 'a signing secret reached the wire').not.toContain(secret);
  }
}

const classifierFor =
  (kind: DestinationKind) => (res: Parameters<typeof classifyDeliveryResponse>[1], at: number) =>
    classifyDeliveryResponse(kind, res, at);

function configFor(kind: Kind, signingSecret?: string): ValidatedDestinationConfig {
  const r = validateDestinationConfig({
    kind,
    webhookUrl: URL_OF[kind],
    ...(signingSecret !== undefined ? { signingSecret } : {}),
  });
  if (!r.ok) throw new Error(`fixture config for ${kind} was refused: ${JSON.stringify(r)}`);
  return r.config;
}

describe('credential_is_never_sent_to_a_host_other_than_its_own: the send path', () => {
  it.each(['slack', 'teams', 'lark', 'discord', 'generic_webhook'] as const)(
    '%s: the stored credential travels only to the host it was registered for',
    async (kind) => {
      const signingSecret =
        kind === 'lark' || kind === 'generic_webhook' ? generateSigningSecret() : undefined;
      const rec = recorder();
      const result = await deliver(configFor(kind, signingSecret), BASE, {
        now: () => NOW,
        meta: META,
        fetch: rec.fetch,
      });

      expect(result.rendered).toBe(true);
      expect(rec.sent).toHaveLength(1);
      // The marker must actually be on the wire, or the negative checks below prove nothing.
      expect(surfaceOf(rec.sent[0] as Sent)).toContain(MARK[kind === 'generic_webhook' ? 'generic' : kind]);
      expect(new URL(rec.sent[0]?.url ?? '').hostname).toBe(HOST_OF[kind]);
      expectBound(
        rec.sent,
        [
          {
            label: `${kind} URL`,
            marker: MARK[kind === 'generic_webhook' ? 'generic' : kind],
            host: HOST_OF[kind],
          },
        ],
        signingSecret ? [signingSecret] : [],
      );
    },
  );

  it('every registry kind is refused for a URL registered for any other kind, without a network call', async () => {
    for (const requested of REGISTRY_KINDS) {
      for (const stored of REGISTRY_KINDS) {
        if (requested === stored) continue;
        const rec = recorder();
        const result = await sendRequest(
          { kind: requested, url: URL_OF[stored], method: 'POST', headers: {}, body: '{}' },
          classifierFor(requested),
          { fetch: rec.fetch },
        );
        expect(result, `${stored} URL sent as ${requested}`).toMatchObject({
          outcome: 'permanent',
          reason: 'destination_url_rejected',
        });
        expect(rec.sent, `${stored} URL sent as ${requested}`).toHaveLength(0);
      }
    }
  });

  it('the registry, not the URL, decides: an allowed host for another kind is still refused', () => {
    expect(checkDestinationUrl('discord', URL_OF.slack).ok).toBe(false);
    expect(checkDestinationUrl('slack', URL_OF.discord).ok).toBe(false);
    expect(isAllowedHost('slack', 'hooks.slack.com')).toBe(true);
    expect(isAllowedHost('slack', 'discord.com')).toBe(false);
    expect(registryEntryFor('lark').hosts).toEqual(['open.larksuite.com', 'open.feishu.cn']);
  });

  it('a custom webhook is the one kind whose host is the customer’s choice, and its signing secret stays home', async () => {
    const signingSecret = generateSigningSecret();
    const rec = recorder();
    await deliver(configFor('generic_webhook', signingSecret), BASE, {
      now: () => NOW,
      meta: META,
      fetch: rec.fetch,
    });
    const headerValues = Object.values(rec.sent[0]?.headers ?? {}).join('\n');
    expect(headerValues).not.toContain(signingSecret);
    expect(rec.sent[0]?.body).not.toContain(signingSecret);
    expect(rec.sent[0]?.headers['webhook-signature']).toMatch(/^v1,/);
  });

  it('a redirect is never followed, and the credential is not sent to the redirect target', async () => {
    const rec = recorder(
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example.net/capture' } }),
    );
    const result = await deliver(configFor('slack'), BASE, { now: () => NOW, meta: META, fetch: rec.fetch });
    expect(rec.sent).toHaveLength(1);
    expect(rec.sent[0]?.redirect).toBe('manual');
    expect(rec.sent.some((c) => new URL(c.url).hostname === 'evil.example.net')).toBe(false);
    expect(result).toMatchObject({
      rendered: true,
      classification: { outcome: 'permanent', reason: 'destination_redirected' },
    });
  });

  it('the alert webhook sink (the operator credential, same policy) sends only to its own host', async () => {
    const target = resolveWebhookTarget(URL_OF.slack, 'https://noti.test');
    if (!target) throw new Error('the fixture alert webhook was refused');
    expect(target.kind).toBe('slack');
    const rec = recorder();
    const event: AlertEvent = {
      kind: 'firing',
      alertId: ALERT_IDS[0],
      severity: 'warning',
      summary: 'Fixture alert.',
      value: 2,
      threshold: 1,
      unit: 'count',
      dedupeKey: 'binding-fixture',
      firingForMs: 0,
      environment: 'staging',
    };
    await webhookSink(target, { transport: rec.fetch }).notify(event);
    expect(rec.sent).toHaveLength(1);
    expectBound(rec.sent, [{ label: 'alert webhook', marker: MARK.slack, host: 'hooks.slack.com' }]);
  });

  it('the save-time DNS lookup gives the resolver only the query name, never the URL or its credential', async () => {
    // A public answer for the A query only, so the host passes the check and the lookup is the only request.
    const rec = recorder(
      () =>
        new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] }), {
          status: 200,
          headers: { 'content-type': 'application/dns-json' },
        }),
    );
    const error = await hostVerificationError(
      'generic_webhook',
      URL_OF.generic_webhook,
      undefined,
      rec.fetch,
    );
    expect(error).toBeNull();
    expect(rec.sent).toHaveLength(2);
    for (const call of rec.sent) {
      expect(call.url.startsWith(`${DOH_ENDPOINT}?`)).toBe(true);
      const params = new URL(call.url).searchParams;
      expect([...params.keys()].sort()).toEqual(['name', 'type']);
      expect(params.get('name')).toBe(HOST_OF.generic_webhook);
      expect(call.url).not.toContain(MARK.generic);
      expect(call.url).not.toContain('channel=ci');
    }
    // The only host that ever receives a request is the resolver: the custom host is not contacted here.
    expect(rec.sent.every((c) => new URL(c.url).hostname === 'cloudflare-dns.com')).toBe(true);
    expect(await checkResolvedHost(HOST_OF.generic_webhook, rec.fetch)).toMatchObject({ ok: true });
  });
});

describe('credential_is_never_sent_to_a_host_other_than_its_own: the delivery consumer', () => {
  const K_LEGACY = 'bb'.repeat(32);
  const NOW_MS = Date.UTC(2026, 9, 15, 12, 0, 0);
  let db: FakeD1;
  let env: Bindings;
  let fetchMock: Mock<typeof fetch>;
  let claims = 0;

  const deps = (): ConsumerDeps => ({
    random: () => 0.999999,
    now: () => NOW_MS,
    newClaimToken: () => `binding-claim-${++claims}`,
  });

  /**
   * An integration whose stored credential is `storedUrl`, whatever kind the row says it is.
   * (The same sealing the pre-envelope rows use; see tests/pipeline/destinations.test.ts.)
   */
  async function integrationRow(id: string, destination: string, storedUrl: string): Promise<void> {
    db.raw
      .prepare(
        'INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,organization_id) VALUES(?,?,?,?,?,?)',
      )
      .run(
        id,
        'acme/web',
        '["workflow_run.failure"]',
        destination,
        await legacySeal(storedUrl, K_LEGACY),
        'org-a',
      );
  }

  function enqueue(id: string, integrationId: string): DeliveryMessage {
    const message: DeliveryMessage = {
      id,
      integrationId,
      organizationId: 'org-a',
      title: 'Build failed',
      url: 'https://github.com/acme/web/actions/runs/1',
      repo: 'acme/web',
      actor: 'octocat',
      status: 'failure',
      eventType: 'workflow_run.failure',
      summary: 'main · failure',
    };
    db.raw
      .prepare(
        "INSERT INTO deliveries(id,integration_id,organization_id,state,created_at) VALUES(?,?,?,?,'2026')",
      )
      .run(id, integrationId, 'org-a', 'pending');
    db.raw
      .prepare('INSERT INTO notification_outbox(id,organization_id,payload_json) VALUES(?,?,?)')
      .run(id, 'org-a', JSON.stringify(message));
    return message;
  }

  async function consume(message: DeliveryMessage): Promise<void> {
    const msg = { body: message, attempts: 1, ack: vi.fn(), retry: vi.fn() };
    await consumeDeliveries(
      { messages: [msg], retryAll: () => undefined } as unknown as MessageBatch<unknown>,
      env,
      deps(),
    );
  }

  const deliveryRow = (id: string) =>
    db.raw.prepare('SELECT state,last_error_code FROM deliveries WHERE id=?').get(id) as {
      state: string;
      last_error_code: string | null;
    };

  beforeEach(() => {
    db = createFakeD1();
    seedOrganization(db.raw, 'org-a');
    env = {
      DB: db.d1,
      DELIVERY_QUEUE: { send: () => Promise.resolve() } as unknown as Queue<DeliveryMessage>,
      GITHUB_WEBHOOK_SECRET: 'unused',
      GITHUB_APP_ID: '777',
      ENCRYPTION_KEY: K_LEGACY,
      KEK_V1: '11'.repeat(32),
      KEK_V2: '',
      KMS_ACTIVE_VERSION: '1',
      ENVIRONMENT_NAME: 'staging',
      KEK_CHECK_V1: '4464ea2121d3a99ebd188370f1ef6cd0',
    } as Bindings;
    fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(new Response('ok', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('a Slack URL stored on a Discord integration is refused before any request is made', async () => {
    await integrationRow('int-crossed', 'discord', URL_OF.slack);
    await consume(enqueue('d-crossed', 'int-crossed'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deliveryRow('d-crossed')).toMatchObject({
      state: 'dead_lettered',
      last_error_code: 'destination_url_rejected',
    });
  });

  it.each(REGISTRY_KINDS)(
    'a %s integration sends its stored credential only to its own host',
    async (kind) => {
      await integrationRow(`int-${kind}`, kind, URL_OF[kind]);
      await consume(enqueue(`d-${kind}`, `int-${kind}`));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const sent: Sent[] = fetchMock.mock.calls.map(([input, init]) => ({
        url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        method: 'POST',
        headers: headerRecord(init?.headers),
        body: typeof init?.body === 'string' ? init.body : '',
        redirect: init?.redirect,
      }));
      expect(new URL(sent[0]?.url ?? '').hostname).toBe(HOST_OF[kind]);
      expectBound(sent, [{ label: kind, marker: MARK[kind], host: HOST_OF[kind] }]);
    },
  );
});
