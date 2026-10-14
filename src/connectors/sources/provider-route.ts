import type { Context } from 'hono';
import { CryptoError } from '../../crypto/envelope';
import { keyringFromEnv } from '../../crypto/keyring-env';
import { newLeaseToken } from '../../delivery/claim';
import { dedupKey, deliveryId as deriveDeliveryId, toHex } from '../../delivery/ids';
import type { Bindings, DeliveryMessage } from '../../env';
import { displayOf } from '../../events/canonical';
import { boundedEventId } from '../../events/id';
import { buildCanonical } from './build';
import { validateCanonicalEvent } from '../../events/validate';
import { readBodyCapped } from '../../lib/body';
import { log } from '../../platform/log';
import { ingressBatch } from '../../db/retry';
import { dispatchOutbox } from '../../pipeline/outbox';
import { createNoisePlanner } from '../../routing/noise-ingress';
import { decisionStatement } from '../../routing/provenance';
import { hit, sourceIngressLimiter } from '../../security/rate-limit';
import { DECOY_MAX_BODY_BYTES } from './generic/route';
import { openSourceSecretText, type SourceCredentialRow } from './generic/secret';
import { connectorFor } from './registry';
import type { AuthMode, Display, ProviderKind } from './types';

/**
 * `POST /webhooks/<kind>/:endpointId` for the registered provider connectors (ADR 0015).
 *
 * The discipline is the generic route's (ADR 0012), with the provider-specific parts behind
 * `SourceConnector`: content type and capped body first; the source row selected by the public
 * endpoint id (the only place a tenant comes from); authentication over the RAW bytes BEFORE
 * any JSON parsing; an identical 404 for unknown, malformed or disabled endpoints; the flood
 * limit only after authentication; durable acceptance (delivery and outbox rows in one D1
 * batch) before the 2xx.
 */

const ENDPOINT_ID = /^[A-Za-z0-9_-]{22,64}$/;
const MAX_SUMMARY_SOURCE = 4096;

type SourceRow = SourceCredentialRow & {
  enabled: number;
  auth_mode: AuthMode | null;
  livemode: number | null;
};

function isJson(contentType: string | undefined): boolean {
  return /^application\/json\s*(;|$)/i.test(contentType ?? '');
}

const notFound = (c: Context<{ Bindings: Bindings }>): Response => c.text('Not found', 404);

/**
 * The stored event types of an integration. `[]` means "every event the source can send"
 * (`null`). A value that cannot be read is NOT "everything": it is `'invalid'` and delivers
 * nothing, so a corrupted selection can never widen what a chat receives.
 */
export function subscribed(json: string): ReadonlySet<string> | null | 'invalid' {
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed) && parsed.every((v): v is string => typeof v === 'string'))
      return parsed.length === 0 ? null : new Set(parsed);
  } catch {
    // Falls through to invalid.
  }
  return 'invalid';
}

/**
 * Coarse guard in front of the secret unwrap: one counter per endpoint id, above the post-auth
 * limit so an honest sender is never near it. It bounds the DEK unwrap and HMAC work an
 * unauthenticated caller can force. Residual: someone who knows the public endpoint id can fill
 * it and make the real sender wait (THREAT_MODEL AR-22).
 */
export const ENDPOINT_PREAUTH_LIMIT_PER_MINUTE = 1200;

/** Drop empty optional fields so a message never carries `summary: ''`. */
function toMessage(
  base: Pick<DeliveryMessage, 'id' | 'integrationId' | 'organizationId'>,
  display: Display,
): DeliveryMessage {
  const { summary, repo, actor, ...rest } = display;
  return {
    ...base,
    ...rest,
    ...(summary ? { summary: summary.slice(0, MAX_SUMMARY_SOURCE) } : {}),
    ...(repo ? { repo } : {}),
    ...(actor ? { actor } : {}),
  };
}

/** Best-effort provenance for an update noise control delayed or let through (ADR 0016). */
async function recordNoiseDecision(
  db: D1Database,
  r: {
    id: string;
    organizationId: string;
    integrationId: string;
    eventType: string;
    reason: Parameters<typeof decisionStatement>[1]['reason'];
    decidedAt: number;
  },
): Promise<void> {
  try {
    await decisionStatement(db, { ...r, outcome: 'delivered', filterId: null, unknown: false }, [
      r.id,
      r.id,
    ]).run();
  } catch {
    log('warn', 'routing_provenance_failed', { records: 1 });
  }
}

export function providerWebhook(kind: ProviderKind) {
  const connector = connectorFor(kind);
  return async (c: Context<{ Bindings: Bindings }>): Promise<Response> => {
    if (!isJson(c.req.header('content-type'))) return c.text('Expected application/json', 415);
    const read = await readBodyCapped(c.req.raw, connector.maxBodyBytes);
    if (!read.ok) return c.text('Too large', 413);
    const raw = read.bytes;
    const nowMs = Date.now();
    const nowSeconds = Math.floor(nowMs / 1000);
    const endpointId = c.req.param('endpointId') ?? '';

    const source = ENDPOINT_ID.test(endpointId)
      ? await c.env.DB.prepare(
          `SELECT id,organization_id,enabled,secret_envelope,key_salt,dek_wrapped,kek_version,auth_mode,livemode
           FROM sources WHERE endpoint_id=? AND kind=?`,
        )
          .bind(endpointId, kind)
          .first<SourceRow>()
      : null;
    if (!source || source.enabled !== 1) {
      // Best-effort timing parity with a live endpoint, skipped for large bodies (ADR 0012).
      if (raw.length <= DECOY_MAX_BODY_BYTES)
        await connector.verify({
          secret: connector.decoy.secret,
          authMode: connector.decoy.authMode,
          headers: c.req.raw.headers,
          raw,
          nowSeconds,
        });
      return notFound(c);
    }

    // A limiter fault must not take ingestion down: it fails open and the post-auth limit still applies.
    const coarse = await hit(
      c.env.DB,
      `ingress:endpoint:${endpointId}`,
      ENDPOINT_PREAUTH_LIMIT_PER_MINUTE,
      60_000,
      nowMs,
    ).catch(() => null);
    if (coarse?.limited)
      return c.text('Too many requests', 429, { 'retry-after': String(coarse.retryAfterSeconds) });

    let secret: string;
    try {
      secret = await openSourceSecretText(source, keyringFromEnv(c.env));
    } catch (e) {
      log('error', 'provider_source_secret_unavailable', {
        source_id: source.id,
        kind,
        code: e instanceof CryptoError ? e.code : 'internal_error',
      });
      return c.text('Temporarily unavailable', 500);
    }

    const verdict = await connector.verify({
      secret,
      authMode: source.auth_mode,
      headers: c.req.raw.headers,
      raw,
      nowSeconds,
    });
    if (!verdict.ok) return c.text('Unauthorized', 401);

    const limit = await sourceIngressLimiter(c.env, source.id, nowMs);
    if (limit.limited) {
      if (connector.onFlood === 'retry')
        return c.text('Too many requests', 429, { 'retry-after': String(limit.retryAfterSeconds) });
      // Absorb: a 4xx would count toward the provider disabling the webhook. The drop is logged
      // (source id only) and is the documented trade-off of this kind.
      log('warn', 'provider_source_flood_dropped', { source_id: source.id, kind });
      try {
        await c.env.DB.prepare(
          `UPDATE sources SET dropped_events=dropped_events+1,last_dropped_at=CURRENT_TIMESTAMP
           WHERE id=? AND organization_id=?`,
        )
          .bind(source.id, source.organization_id)
          .run();
      } catch {
        // Display-only counter; the drop already happened and is logged.
      }
      return c.json({ accepted: false, dropped: 'rate_limited' }, 200);
    }

    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const mapped = connector.map({
      headers: c.req.raw.headers,
      body: json,
      source: { livemode: source.livemode === null ? null : source.livemode === 1 },
    });
    if (mapped.outcome === 'reject') {
      log('warn', 'provider_event_rejected', { source_id: source.id, kind, reason: mapped.reason });
      return c.json({ error: mapped.reason }, mapped.status);
    }
    const organizationId = source.organization_id;
    const touch = async () => {
      try {
        await c.env.DB.prepare(
          'UPDATE sources SET last_received_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?',
        )
          .bind(source.id, organizationId)
          .run();
      } catch {
        log('warn', 'provider_source_touch_failed', { source_id: source.id, kind });
      }
    };
    if (mapped.outcome === 'ignore') {
      await touch();
      return c.json({ accepted: true, ignored: mapped.reason }, 200);
    }

    // Identity: the provider's own id. A signature or timestamp is never identity (it changes
    // on every retry). Without any id (GitLab secret-token mode on an older instance) the body
    // hash stands in: a retry re-sends the same bytes.
    const providerId =
      verdict.eventId ??
      mapped.eventId ??
      `body:${toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)))}`;
    const dedup = await dedupKey({
      orgId: organizationId,
      connectionId: source.id,
      source: kind,
      eventId: providerId,
    });

    // Normalise before routing (ADR 0020). A mapper/validator mismatch is OUR fault: a 4xx would
    // count as a failed delivery (GitLab disables the webhook after repeated ones, Stripe retries for
    // days), so the event is acknowledged with 2xx, logged loudly with field names only, and counted
    // on the source (`dropped_events`, the same visible counter a flood drop uses).
    const normalised = validateCanonicalEvent(
      buildCanonical({
        provider: kind,
        display: mapped.display,
        id: await boundedEventId(providerId),
      }),
    );
    if (!normalised.ok) {
      log('error', 'canonical_event_invalid', {
        source_id: source.id,
        kind,
        fields: normalised.errors.map((e) => `${e.field}:${e.reason}`).slice(0, 10),
      });
      try {
        await c.env.DB.prepare(
          `UPDATE sources SET dropped_events=dropped_events+1,last_dropped_at=CURRENT_TIMESTAMP
           WHERE id=? AND organization_id=?`,
        )
          .bind(source.id, organizationId)
          .run();
      } catch {
        // Display-only counter; the error line above already records it.
      }
      return c.json({ accepted: false, ignored: 'schema_invalid' }, 200);
    }
    const display = displayOf(normalised.event);

    const rows = await c.env.DB.prepare(
      'SELECT id,event_types,noise_json FROM integrations WHERE organization_id=? AND source_id=? AND enabled=1',
    )
      .bind(organizationId, source.id)
      .all<{ id: string; event_types: string; noise_json: string | null }>();
    const targets = rows.results.filter((row) => {
      const selection = subscribed(row.event_types);
      if (selection === 'invalid') {
        log('warn', 'provider_integration_event_types_unreadable', { integration_id: row.id, kind });
        return false;
      }
      return selection === null || (display.eventType !== undefined && selection.has(display.eventType));
    });

    let queued = 0;
    let held = 0;
    const planner = createNoisePlanner(c.env.DB, organizationId, nowMs);
    for (const row of targets) {
      const id = (await deriveDeliveryId(dedup.hex, row.id)).hex;
      const message = toMessage({ id, integrationId: row.id, organizationId }, display);
      // Noise control (ADR 0016): deliver now or hold; never drop.
      const plan = await planner.plan({
        integrationId: row.id,
        noiseJson: row.noise_json,
        deliveryId: id,
        eventType: display.eventType ?? 'notification',
        subject: '',
        display,
      });
      if (plan.action === 'hold' || plan.reason !== null) {
        await recordNoiseDecision(c.env.DB, {
          id,
          organizationId,
          integrationId: row.id,
          eventType: display.eventType ?? 'notification',
          reason: plan.action === 'hold' ? plan.reason : (plan.reason ?? 'critical_bypass'),
          decidedAt: nowMs,
        });
      }
      if (plan.action === 'hold') {
        const [stored] = await c.env.DB.batch([plan.statement]);
        if (stored?.meta.changes) held++;
        continue;
      }
      const results = await ingressBatch(c.env.DB, [
        // Not when this event is already waiting in `held_events` (ADR 0016).
        c.env.DB.prepare(
          `INSERT OR IGNORE INTO deliveries(id,integration_id,organization_id,state,dedup_key,created_at)
           SELECT ?,?,?,'pending',?,CURRENT_TIMESTAMP
           WHERE NOT EXISTS (SELECT 1 FROM held_events WHERE id=? AND organization_id=?)`,
        ).bind(id, row.id, organizationId, dedup.hex, id, organizationId),
        // Only if the delivery row was new: a repeat after outbox retention must not send again.
        c.env.DB.prepare(
          `INSERT OR IGNORE INTO notification_outbox(id,organization_id,payload_json)
           SELECT ?,?,? WHERE changes() > 0`,
        ).bind(id, organizationId, JSON.stringify(message)),
      ]);
      if (results[1]?.meta.changes) queued++;
    }
    await touch();

    if (queued > 0)
      c.executionCtx.waitUntil(
        dispatchOutbox(c.env, { now: () => Date.now(), newLeaseToken, organizationId }),
      );
    return c.json(
      {
        accepted: true,
        persisted: queued,
        ...(held > 0 ? { held } : {}),
        ...(targets.length > 0 && queued === 0 && held === 0 ? { duplicate: true } : {}),
      },
      202,
    );
  };
}
