/**
 * Alert sinks (docs/specs/13-observability.md F200, F201): where a state change is announced.
 *
 *  - `logSink`: always on. One structured line per event at `error` (firing, renotify) or `info`
 *    (resolved), so a log search finds every alert even when nothing else is configured.
 *  - `webhookSink`: optional, from the secret `ALERT_WEBHOOK_URL`. A chat webhook for Slack, Discord, Lark
 *    or Microsoft Teams Workflows, validated by the SAME destination URL policy as a customer's
 *    destination (host allow-list for those four, https, no userinfo or port, provider path shape) and
 *    sent through the same `sendRequest` (policy re-checked, no redirects, 10 s timeout). One attempt, no
 *    retry: the engine re-tries on a later tick at most every NOTIFY_RETRY_MS, never in a loop.
 *
 * NOT built: paging a human (PagerDuty, Opsgenie, a phone call) and email. A chat webhook is a message,
 * not an acknowledgement-tracked page (docs/RUNBOOK.md, ADR 0024).
 *
 * The text is ids and numbers only. The webhook URL is a bearer secret and is never logged or echoed.
 */
import {
  checkDestinationUrl,
  classifyDeliveryResponse,
  sendRequest,
  type DestinationKind,
  type Fetcher,
} from '../../connectors/destinations';
import { ownHostsOf } from '../../connectors/destinations/url-policy';
import { log } from '../../platform/log';
import { runbookAnchor, type AlertId, type AlertSeverity, type AlertUnit } from './registry';

export type AlertEventKind = 'firing' | 'renotify' | 'resolved';

export interface AlertEvent {
  readonly kind: AlertEventKind;
  readonly alertId: AlertId;
  readonly severity: AlertSeverity;
  readonly summary: string;
  readonly value: number | null;
  readonly threshold: number;
  readonly unit: AlertUnit;
  /** Stable for one incident; a receiver may collapse repeats on it. */
  readonly dedupeKey: string;
  /** How long it has been firing (ms), for renotify and resolved. */
  readonly firingForMs: number;
  /** `production`, `staging` or `development`. */
  readonly environment: string;
}

export interface AlertSink {
  readonly name: string;
  /** Rejects on failure; the engine contains it. */
  notify(event: AlertEvent): Promise<void>;
}

function figure(value: number | null, unit: AlertUnit): string {
  if (value === null) return 'n/a';
  return unit === 'ms' ? `${Math.round(value / 60_000)} min` : String(value);
}

const LABEL: Readonly<Record<AlertEventKind, string>> = {
  firing: 'FIRING',
  renotify: 'STILL FIRING',
  resolved: 'RESOLVED',
};

/** Ids, severity, numbers and the runbook anchor. Nothing tenant-derived can reach it. */
export function formatAlertText(e: AlertEvent): string {
  const head = `[lumi-noti ${e.environment}] ${LABEL[e.kind]} ${e.alertId} (${e.severity})`;
  const body = `${e.summary} Value ${figure(e.value, e.unit)}, threshold ${figure(e.threshold, e.unit)}.`;
  const tail =
    e.kind === 'firing'
      ? `Runbook: docs/RUNBOOK.md#${runbookAnchor(e.alertId)}`
      : `Firing for ${Math.round(e.firingForMs / 60_000)} min. Runbook: docs/RUNBOOK.md#${runbookAnchor(e.alertId)}`;
  return `${head} ${body} ${tail} Key ${e.dedupeKey}`;
}

export const logSink: AlertSink = {
  name: 'log',
  notify(e) {
    log(e.kind === 'resolved' ? 'info' : 'error', `alert_${e.kind}`, {
      alert: e.alertId,
      severity: e.severity,
      value: e.value,
      threshold: e.threshold,
      incident: e.dedupeKey,
      firing_for_ms: e.firingForMs,
      runbook: runbookAnchor(e.alertId),
    });
    return Promise.resolve();
  },
};

/** The chat kinds an alert webhook may be. Generic webhooks are not allowed: the host is the operator's to name, but not ours to widen. */
export const ALERT_WEBHOOK_KINDS = [
  'slack',
  'discord',
  'lark',
  'teams',
] as const satisfies readonly DestinationKind[];

export interface WebhookTarget {
  readonly kind: (typeof ALERT_WEBHOOK_KINDS)[number];
  readonly url: string;
}

/** The first kind whose URL policy accepts the URL, or null. Never echoes the URL. */
export function resolveWebhookTarget(raw: string | undefined, appOrigin?: string): WebhookTarget | null {
  if (!raw) return null;
  for (const kind of ALERT_WEBHOOK_KINDS) {
    if (checkDestinationUrl(kind, raw, { ownHosts: ownHostsOf(appOrigin) }).ok) return { kind, url: raw };
  }
  return null;
}

function bodyFor(kind: WebhookTarget['kind'], text: string): string {
  switch (kind) {
    case 'slack':
      return JSON.stringify({ text });
    case 'discord':
      return JSON.stringify({ content: text.slice(0, 1900) });
    case 'lark':
      return JSON.stringify({ msg_type: 'text', content: { text } });
    case 'teams':
      return JSON.stringify({
        type: 'message',
        attachments: [
          {
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: {
              $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
              type: 'AdaptiveCard',
              version: '1.4',
              body: [{ type: 'TextBlock', text, wrap: true }],
            },
          },
        ],
      });
  }
}

export const ALERT_WEBHOOK_TIMEOUT_MS = 10_000;

export function webhookSink(target: WebhookTarget, options: { readonly fetch?: Fetcher } = {}): AlertSink {
  return {
    name: 'webhook',
    async notify(e) {
      const result = await sendRequest(
        {
          kind: target.kind,
          url: target.url,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: bodyFor(target.kind, formatAlertText(e)),
        },
        (res, at) => classifyDeliveryResponse(target.kind, res, at),
        { timeoutMs: ALERT_WEBHOOK_TIMEOUT_MS, ...(options.fetch ? { fetch: options.fetch } : {}) },
      );
      if (result.outcome !== 'delivered' && result.outcome !== 'accepted') {
        // The reason is from our closed taxonomy, never provider text; the URL never appears.
        throw new Error(`alert_webhook_${result.outcome}:${result.reason}`);
      }
    },
  };
}

/** The sinks for this deployment: the log always, the webhook when configured and valid. */
export function sinksFromEnv(
  env: { readonly ALERT_WEBHOOK_URL?: string; readonly APP_ORIGIN?: string },
  options: { readonly fetch?: Fetcher } = {},
): readonly AlertSink[] {
  const target = resolveWebhookTarget(env.ALERT_WEBHOOK_URL, env.APP_ORIGIN);
  return target ? [logSink, webhookSink(target, options)] : [logSink];
}
