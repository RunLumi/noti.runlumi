import { vi } from 'vitest';
import worker from '../../src/index';
import type { Bindings, DeliveryMessage } from '../../src/env';
import { serializeNoise, type NoiseSettings } from '../../src/routing/noise';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

/**
 * Shared harness for noise-control tests: the real Worker entry point over the real migrations
 * and a node:sqlite D1 fake, with only `Date` faked so a test chooses what time ingress and the
 * release job see.
 */
export const HMAC_FIXTURE = ['test', 'fixture', 'hmac'].join('-');
export const APP_ID = '777';

export interface Harness {
  readonly db: FakeD1;
  readonly env: Bindings;
  readonly sent: DeliveryMessage[];
}

export function createHarness(): Harness {
  const db = createFakeD1();
  const sent: DeliveryMessage[] = [];
  seedOrganization(db.raw, 'org-a');
  seedOrganization(db.raw, 'org-b');
  for (const [org, installationId] of [
    ['org-a', '1001'],
    ['org-b', '1002'],
  ] as const) {
    db.raw
      .prepare(
        `INSERT INTO github_installations(id,organization_id,installation_id,app_id,account_login,account_type,repository_selection,status)
         VALUES(?,?,?,?,?,?,?,'active')`,
      )
      .run(`gi-${installationId}`, org, installationId, APP_ID, org, 'Organization', 'all');
  }
  const env = {
    DB: db.d1,
    DELIVERY_QUEUE: {
      send: (m: DeliveryMessage) => {
        sent.push(m);
        return Promise.resolve();
      },
    } as unknown as Queue<DeliveryMessage>,
    GITHUB_WEBHOOK_SECRET: HMAC_FIXTURE,
    GITHUB_APP_ID: APP_ID,
    ENCRYPTION_KEY: '',
    KEK_V1: '11'.repeat(32),
    KEK_V2: '',
    KMS_ACTIVE_VERSION: '1',
  } as unknown as Bindings;
  return { db, env, sent };
}

export function setNow(iso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

export function insertIntegration(
  h: Harness,
  id: string,
  org: string,
  noise: NoiseSettings | null | string,
  options: {
    eventTypes?: string[];
    repo?: string;
    filters?: string | null;
    sourceId?: string | null;
  } = {},
): void {
  const raw = typeof noise === 'string' ? noise : serializeNoise(noise);
  h.db.raw
    .prepare(
      `INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,organization_id,noise_json,filters_json,source_id,enabled)
       VALUES(?,?,?,?,?,?,?,?,?,1)`,
    )
    .run(
      id,
      options.repo ?? 'acme/web',
      JSON.stringify(
        options.eventTypes ?? [
          'push',
          'issue_comment.created',
          'pull_request.opened',
          'workflow_run.failure',
          'workflow_run.success',
          'issues.opened',
        ],
      ),
      'slack',
      '',
      org,
      raw,
      options.filters ?? null,
      options.sourceId ?? null,
    );
}

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(HMAC_FIXTURE),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return 'sha256=' + Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface PostResult {
  readonly status: number;
  readonly persisted?: number;
  readonly held?: number;
}

export async function postGithub(
  h: Harness,
  kind: string,
  event: Record<string, unknown>,
  deliveryId: string,
  options: { installation?: number; repo?: string } = {},
): Promise<PostResult> {
  const repo = options.repo ?? 'acme/web';
  const body = JSON.stringify({
    installation: { id: options.installation ?? 1001, app_id: Number(APP_ID) },
    repository: { full_name: repo, html_url: `https://github.com/${repo}` },
    ...event,
  });
  const waits: Promise<unknown>[] = [];
  const res = await worker.fetch(
    new Request('https://noti.test/webhooks/github', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': await sign(body),
        'x-github-event': kind,
        'x-github-delivery': deliveryId,
      },
    }),
    h.env,
    {
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext,
  );
  await Promise.all(waits);
  const json = (await res.json().catch(() => ({}))) as { persisted?: number; held?: number };
  return {
    status: res.status,
    ...(json.persisted !== undefined ? { persisted: json.persisted } : {}),
    ...(json.held !== undefined ? { held: json.held } : {}),
  };
}

export const comment = (issue: number, body = 'looks good') => ({
  action: 'created',
  sender: { login: 'octocat', type: 'User' },
  issue: { number: issue, title: `Issue ${issue}`, html_url: `https://github.com/acme/web/issues/${issue}` },
  comment: { body },
});

export const workflowRun = (
  conclusion: 'failure' | 'success',
  over: { name?: string; branch?: string; id?: number } = {},
) => ({
  action: 'completed',
  sender: { login: 'octocat', type: 'User' },
  workflow_run: {
    id: over.id ?? 1,
    name: over.name ?? 'CI',
    conclusion,
    head_branch: over.branch ?? 'main',
    html_url: 'https://github.com/acme/web/actions/runs/1',
  },
});

export interface HeldRowView {
  id: string;
  organization_id: string;
  integration_id: string;
  hold_reason: string;
  state: string;
  release_at: number;
  released_in: string | null;
  title: string;
  resolved: number;
}

export const heldRows = (h: Harness): HeldRowView[] =>
  h.db.raw.prepare('SELECT * FROM held_events ORDER BY held_at, rowid').all() as unknown as HeldRowView[];

export const count = (h: Harness, table: string, where = '1=1'): number =>
  (h.db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;

export interface OutboxPayload extends DeliveryMessage {
  readonly count?: number;
}

export const outboxMessages = (h: Harness): OutboxPayload[] =>
  (
    h.db.raw.prepare('SELECT payload_json FROM notification_outbox ORDER BY rowid').all() as {
      payload_json: string;
    }[]
  ).map((r) => JSON.parse(r.payload_json) as OutboxPayload);
