import { createHmac, randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import { GITHUB_EVENT_TYPES } from '../../src/connectors/sources/github/catalog';
import type { SourceId } from '../../src/events/catalog';
import type { DeliveryMessage } from '../../src/env';
import { parseFilters, serializeFilters } from '../../src/routing/filter-input';
import { SLACK, caller, setup, signHeaders, type Harness } from '../sources/harness';
import { newSigningToken, newStripeSecret, stripeSignature } from '../sources/provider-harness';

/**
 * One uniform way to drive each source's real ingress route over the fake D1: create the tenant
 * state, sign a request the way the provider does (independently of the code under test, with
 * secrets generated at run time), post it, and read back what was durably accepted. Used by the
 * fixture replay suite and the connector conformance suite.
 */
export const GITHUB_APP_ID = '777';
export const GITHUB_INSTALLATION = 1001;
export const ORG = 'org-a';
/** Every GitHub event type the integrations below subscribe to is the whole catalogue (set per rig). */
export const GITHUB_REPO = 'Codertocat/Hello-World';

type Worker = {
  fetch: (req: Request, env: Harness['env'], ctx: ExecutionContext) => Promise<Response> | Response;
};

export type SignatureMode = 'valid' | 'forged' | 'none';

export interface PostOptions {
  /** Headers that name the event (`x-github-event`, `x-gitlab-event`, ...). */
  readonly headers?: Record<string, string>;
  readonly signature?: SignatureMode;
  /** Content type; `null` sends none. Default `application/json`. */
  readonly contentType?: string | null;
  /** The provider's delivery or message id, where the protocol has a header for it. */
  readonly deliveryId?: string;
  /** Signed timestamp, seconds (providers that sign one). */
  readonly timestamp?: number;
  /** Sign THIS text instead of the body actually sent (a truncated or altered body). */
  readonly signedText?: string;
  /** Post to this path instead of the rig's own endpoint (an unknown endpoint). */
  readonly path?: string;
}

export interface Rig {
  readonly kind: SourceId;
  readonly h: Harness;
  /** Route path of the source's ingress. */
  readonly path: string;
  /** The integrations that subscribe to everything, by name. */
  readonly integrations: Readonly<Record<string, string>>;
  /** The post-authentication flood counter of this rig's tenant (`api_rate_limits.key`). */
  readonly floodKey: string;
  /** Make a fixture body deliverable to this rig (GitHub: add the installation block). */
  encode(json: Record<string, unknown>): string;
  post(body: string | Uint8Array, options?: PostOptions): Promise<Response>;
  /** Outbox messages written so far, oldest first. */
  messages(): DeliveryMessage[];
  count(table: string, where?: string): number;
}

let counter = 0;
const nextId = (): string => `rig-${++counter}-${randomBytes(4).toString('hex')}`;

function ctx(h: Harness): ExecutionContext {
  return { waitUntil: h.waitUntil, passThroughOnException: () => undefined } as unknown as ExecutionContext;
}

function githubIntegration(h: Harness, name: string, filters: unknown, repo: string): string {
  const parsed = parseFilters(filters);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const id = `int-${name}`;
  h.db.raw
    .prepare(
      `INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,organization_id,filters_json)
       VALUES(?,?,?,?,?,?,?)`,
    )
    .run(id, repo, JSON.stringify(allGithubTypes), 'slack', '', ORG, serializeFilters(parsed.value));
  return id;
}

const allGithubTypes = [...GITHUB_EVENT_TYPES];

/** The four GitHub integrations every GitHub rig has: no filter, and one filter each that bites. */
export const GITHUB_FILTERS: Readonly<Record<string, unknown>> = {
  all: null,
  'master-only': { branch: { allow: ['master'] } },
  'humans-only': { actor: { bots: 'exclude' } },
  'actor-allow': { actor: { allow: ['Codertocat'] } },
  'ready-only': { draft: 'exclude' },
  'bug-label': { labels: { include: ['bug'] } },
};

export async function createRig(
  kind: SourceId,
  worker: Worker,
  options: { readonly repo?: string } = {},
): Promise<Rig> {
  const h = setup();
  const call = caller(worker, () => h);
  const integrations: Record<string, string> = {};

  const read = {
    messages: (): DeliveryMessage[] =>
      (
        h.db.raw.prepare('SELECT payload_json FROM notification_outbox ORDER BY rowid').all() as {
          payload_json: string;
        }[]
      ).map((r) => JSON.parse(r.payload_json) as DeliveryMessage),
    count: (table: string, where = '1=1'): number =>
      (h.db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n,
  };

  async function send(path: string, body: string | Uint8Array, headers: Headers): Promise<Response> {
    return worker.fetch(
      new Request(`https://noti.test${path}`, {
        method: 'POST',
        headers,
        body: typeof body === 'string' ? body : body.slice().buffer,
      }),
      h.env,
      ctx(h),
    );
  }

  if (kind === 'github') {
    const secret = randomBytes(24).toString('hex');
    const forgedSecret = randomBytes(24).toString('hex');
    h.env = { ...h.env, GITHUB_APP_ID, GITHUB_WEBHOOK_SECRET: secret };
    h.db.raw
      .prepare(
        `INSERT INTO github_installations(id,organization_id,installation_id,app_id,account_login,account_type,repository_selection,status)
         VALUES('gi-1',?,?,?,?,?,?,'active')`,
      )
      .run(ORG, String(GITHUB_INSTALLATION), GITHUB_APP_ID, 'Codertocat', 'Organization', 'all');
    for (const [name, filters] of Object.entries(GITHUB_FILTERS))
      integrations[name] = githubIntegration(h, name, filters, options.repo ?? GITHUB_REPO);
    return {
      kind,
      h,
      path: '/webhooks/github',
      integrations,
      floodKey: `ingress:github:${GITHUB_INSTALLATION}`,
      // App deliveries carry an `installation` block; the documented examples have a placeholder
      // one or none. The tenant must be ours, so the id (and the app id, where the payload has
      // one) is replaced. Everything else is the fixture as published.
      encode: (json) => {
        const documented = (json.installation ?? {}) as Record<string, unknown>;
        return JSON.stringify({
          ...json,
          installation: {
            ...documented,
            id: GITHUB_INSTALLATION,
            ...('app_id' in documented ? { app_id: Number(GITHUB_APP_ID) } : {}),
          },
        });
      },
      async post(body, o = {}) {
        const headers = new Headers({ 'x-github-delivery': o.deliveryId ?? nextId(), ...o.headers });
        if (o.contentType !== null) headers.set('content-type', o.contentType ?? 'application/json');
        const signed = o.signedText !== undefined ? Buffer.from(o.signedText) : Buffer.from(body);
        const key = o.signature === 'forged' ? forgedSecret : secret;
        if (o.signature !== 'none')
          headers.set(
            'x-hub-signature-256',
            `sha256=${createHmac('sha256', key).update(signed).digest('hex')}`,
          );
        return send(o.path ?? '/webhooks/github', body, headers);
      },
      ...read,
    };
  }

  // Endpoint sources: created through the real API, so the secret is sealed exactly as in production.
  const secret = kind === 'gitlab' ? newSigningToken() : kind === 'stripe' ? newStripeSecret() : '';
  const create = await call('POST', '/api/sources', {
    as: 'alice',
    body: {
      name: `${kind} fixture source`,
      kind,
      ...(kind === 'generic' ? {} : { secret }),
      ...(kind === 'gitlab' ? { authMode: 'signing_token' } : {}),
      ...(kind === 'stripe' ? { livemode: false } : {}),
    },
  });
  expect(create.status).toBe(201);
  const created = await create.json<{ source: { id: string; endpointId: string }; secret?: string }>();
  const key = kind === 'generic' ? (created.secret as string) : secret;
  const path = `/webhooks/${kind}/${created.source.endpointId}`;
  const connect = await call('POST', '/api/integrations', {
    as: 'alice',
    body: { name: 'to slack', sourceId: created.source.id, destination: 'slack', webhookUrl: SLACK },
  });
  expect(connect.status).toBe(201);
  integrations.all = (await connect.json<{ integration: { id: string } }>()).integration.id;
  const otherKey =
    kind === 'stripe'
      ? newStripeSecret()
      : kind === 'gitlab'
        ? newSigningToken()
        : // A different, well-formed generic secret.
          'whsec_' + Buffer.from(randomBytes(32)).toString('base64');

  return {
    kind,
    h,
    path,
    integrations,
    floodKey: `ingress:source:${created.source.id}`,
    encode: (json) => JSON.stringify(json),
    async post(body, o = {}) {
      const headers = new Headers(o.headers);
      if (o.contentType !== null) headers.set('content-type', o.contentType ?? 'application/json');
      const signedText = o.signedText ?? (typeof body === 'string' ? body : Buffer.from(body));
      const useKey = o.signature === 'forged' ? otherKey : key;
      if (o.signature !== 'none') {
        const id = o.deliveryId ?? nextId();
        const ts = o.timestamp ?? Math.floor(Date.now() / 1000);
        if (kind === 'stripe') {
          const text = typeof signedText === 'string' ? signedText : Buffer.from(signedText).toString('utf8');
          headers.set('stripe-signature', stripeSignature(useKey, text, { ts }));
        } else {
          for (const [k, v] of Object.entries(signHeaders(useKey, signedText, { id, ts }))) headers.set(k, v);
        }
      }
      return send(o.path ?? path, body, headers);
    },
    ...read,
  };
}
