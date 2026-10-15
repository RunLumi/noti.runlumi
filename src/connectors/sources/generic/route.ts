import type { Context } from 'hono';
import { CryptoError } from '../../../crypto/envelope';
import { keyringFromEnv } from '../../../crypto/keyring-env';
import { newLeaseToken } from '../../../delivery/claim';
import { dedupStatements } from '../../../delivery/dedup';
import { dedupKey, deliveryId as deriveDeliveryId, toHex } from '../../../delivery/ids';
import type { Bindings, DeliveryMessage } from '../../../env';
import { isJsonContentType, readBodyCapped } from '../../../lib/body';
import { correlationField, currentCorrelationId } from '../../../platform/correlation';
import { log } from '../../../platform/log';
import { settleBackground } from '../../../platform/background';
import { ingressBatch } from '../../../db/retry';
import { dispatchOutbox } from '../../../pipeline/outbox';
import { createNoisePlanner } from '../../../routing/noise-ingress';
import { decisionStatement } from '../../../routing/provenance';
import { sourceIngressLimiter } from '../../../security/rate-limit';
import { recordIngressUsage } from '../../../security/ingress-usage';
import { displayOf } from '../../../events/canonical';
import { validateCanonicalEvent } from '../../../events/validate';
import { boundedEventId } from '../../../events/id';
import { buildCanonical } from '../build';
import { GENERIC_MAX_BODY_BYTES } from './contract';
import { parseGenericEvent } from './event';
import { openSourceSecret, type SourceCredentialRow } from './secret';
import { verifyStandardWebhook } from './signature';

/**
 * `POST /webhooks/generic/:endpointId` — the generic inbound source (ADR 0012, spec 06).
 *
 * Order matters and mirrors the GitHub route (spec 05 F58/F63/F64): cheap, endpoint-agnostic
 * checks first (content type, size), then the source lookup, then signature verification
 * over the RAW bytes, and only then flood limiting, JSON parsing and routing. The tenant
 * comes only from the source row the endpoint id selects; the payload cannot name one.
 * 202 is returned only after the delivery and outbox rows have committed.
 */

/** Hard cap on an inbound body (256 KiB). Generic events are small by contract (./contract.ts). */
export const MAX_BODY_BYTES = GENERIC_MAX_BODY_BYTES;

const ENDPOINT_ID = /^[A-Za-z0-9_-]{22,64}$/;

type SourceRow = SourceCredentialRow & { enabled: number };

/** One shape for every "no such endpoint" outcome: unknown or malformed id. */
function notFound(c: Context<{ Bindings: Bindings }>): Response {
  return c.text('Not found', 404);
}

// A fixed throwaway key so the unknown/disabled path performs the same HMAC work over the
// same bytes as a real verification (best-effort timing parity; see ADR 0012).
/** Bodies larger than this skip the decoy HMAC. */
export const DECOY_MAX_BODY_BYTES = 16 * 1024;
const DECOY_KEY = new Uint8Array(new ArrayBuffer(32)).fill(0x5a);

export async function genericWebhook(c: Context<{ Bindings: Bindings }>): Promise<Response> {
  if (!isJsonContentType(c.req.header('content-type'))) return c.text('Expected application/json', 415);
  // Counts bytes as they arrive, so a chunked or lying request is cut off at the cap instead
  // of being buffered first (review M1).
  const read = await readBodyCapped(c.req.raw, MAX_BODY_BYTES);
  if (!read.ok) return c.text('Too large', 413);
  const raw = read.bytes;

  const headers = {
    id: c.req.header('webhook-id') ?? null,
    timestamp: c.req.header('webhook-timestamp') ?? null,
    signature: c.req.header('webhook-signature') ?? null,
  };
  const nowMs = Date.now();
  const endpointId = c.req.param('endpointId') ?? '';

  const source = ENDPOINT_ID.test(endpointId)
    ? await c.env.DB.prepare(
        `SELECT id,organization_id,enabled,secret_envelope,key_salt,dek_wrapped,kek_version
         FROM sources WHERE endpoint_id=? AND kind='generic'`,
      )
        .bind(endpointId)
        .first<SourceRow>()
    : null;
  // F50/F76: a disabled endpoint is 410 Gone, which tells a well-behaved sender to stop and disable its
  // webhook. It needs the unguessable endpoint id, so it reveals nothing to someone without it (ADR 0028).
  if (source && source.enabled !== 1) return c.text('Gone', 410);
  if (!source) {
    // Timing parity is best effort and only worth its CPU for ordinary bodies: above the
    // threshold the decoy is skipped so an unauthenticated 256 KiB body costs one D1 read
    // and no HMAC (review M2, ADR 0012).
    if (raw.length <= DECOY_MAX_BODY_BYTES)
      await verifyStandardWebhook(DECOY_KEY, headers, raw, Math.floor(nowMs / 1000));
    return notFound(c);
  }

  let key: Uint8Array<ArrayBuffer>;
  try {
    key = await openSourceSecret(source, keyringFromEnv(c.env));
  } catch (e) {
    // A deployment or row fault, not the sender's: 5xx so a retrying sender recovers once
    // fixed. Category only; never the row, the secret or the body.
    log('error', 'generic_source_secret_unavailable', {
      source_id: source.id,
      code: e instanceof CryptoError ? e.code : 'internal_error',
    });
    return c.text('Temporarily unavailable', 500);
  }

  const verdict = await verifyStandardWebhook(key, headers, raw, Math.floor(nowMs / 1000));
  if (!verdict.ok) return c.text('Unauthorized', 401);

  // After verification, so an unauthenticated caller cannot burn this source's budget.
  const limit = await sourceIngressLimiter(c.env, source.id, nowMs);
  if (limit.limited) {
    await recordIngressUsage(c.env.DB, source.organization_id, 'generic', { rateLimited: 1 }, nowMs);
    return c.text('Too many requests', 429, { 'retry-after': String(limit.retryAfterSeconds) });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
  const parsed = parseGenericEvent(parsedJson);
  if (!parsed.ok) return c.json({ error: 'Invalid event', fields: parsed.errors }, 400);

  // Normalise before routing (ADR 0020). The sender's own text passed the generic parser; the
  // canonical validator additionally refuses what no renderer should ever see (unpaired
  // surrogates, noncharacters, invisible formatting), so such a SENDER-supplied event is a 400 and
  // nothing is written. Unlike the provider routes this is the sender's own contract, and our mappers
  // cut to their bounds, so a refusal here is never our mismatch.
  const normalised = validateCanonicalEvent(
    buildCanonical({
      provider: 'generic',
      event: parsed.event,
      id: await boundedEventId(headers.id ?? ''),
    }),
  );
  if (!normalised.ok)
    return c.json(
      {
        error: 'Invalid event',
        fields: normalised.errors.map((e) => ({ field: e.field, message: 'Not accepted.' })),
      },
      400,
    );

  const organizationId = source.organization_id;
  const rows = await c.env.DB.prepare(
    'SELECT id,noise_json FROM integrations WHERE organization_id=? AND source_id=? AND enabled=1',
  )
    .bind(organizationId, source.id)
    .all<{ id: string; noise_json: string | null }>();

  // F170: tenant-bound transport identity. A sender retry or replay inside the tolerance
  // window repeats `webhook-id`, so the same event is accepted once per destination.
  const dedup = await dedupKey({
    orgId: organizationId,
    connectionId: source.id,
    source: 'generic',
    eventId: headers.id ?? '',
  });
  const display = displayOf(normalised.event);

  // A webhook-id must be unique per event. If this id was already accepted with a DIFFERENT
  // body, the event would be silently dropped as a "duplicate": refuse it loudly instead
  // (review M3). Same id and same body stays an idempotent 202.
  const bodyHash = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)));
  const earlier = await c.env.DB.prepare(
    'SELECT body_hash FROM deliveries WHERE dedup_key=? AND organization_id=? LIMIT 1',
  )
    .bind(dedup.hex, organizationId)
    .first<{ body_hash: string | null }>();
  if (earlier && earlier.body_hash !== null && earlier.body_hash !== bodyHash) {
    try {
      await c.env.DB.prepare(
        `UPDATE sources SET reused_id_rejections=reused_id_rejections+1,last_reuse_rejected_at=CURRENT_TIMESTAMP
         WHERE id=? AND organization_id=?`,
      )
        .bind(source.id, organizationId)
        .run();
    } catch {
      // Display-only counter; the rejection stands either way.
    }
    // Counts and ids of ours only: never the webhook-id (sender controlled) or the body.
    log('warn', 'generic_webhook_id_reused', { source_id: source.id });
    return c.json({ error: 'webhook_id_reused', message: 'webhook-id must be unique per event.' }, 409);
  }

  let queued = 0;
  let held = 0;
  const planner = createNoisePlanner(c.env.DB, organizationId, nowMs);
  for (const row of rows.results) {
    const id = (await deriveDeliveryId(dedup.hex, row.id)).hex;
    const message: DeliveryMessage = {
      id,
      integrationId: row.id,
      organizationId,
      ...display,
      ...correlationField(),
    };
    // Noise control (ADR 0016): deliver now or hold; never drop. A failure-class event
    // (severity error or critical) bypasses every hold.
    const plan = await planner.plan({
      integrationId: row.id,
      noiseJson: row.noise_json,
      deliveryId: id,
      eventType: display.eventType ?? 'notification',
      subject: '',
      display,
    });
    if (plan.action === 'hold' || plan.reason !== null) {
      try {
        await decisionStatement(
          c.env.DB,
          {
            id,
            organizationId,
            integrationId: row.id,
            eventType: display.eventType ?? 'notification',
            outcome: 'delivered',
            filterId: null,
            reason: plan.action === 'hold' ? plan.reason : (plan.reason ?? 'critical_bypass'),
            unknown: false,
            decidedAt: nowMs,
          },
          [id, id],
        ).run();
      } catch {
        log('warn', 'routing_provenance_failed', { records: 1 });
      }
    }
    if (plan.action === 'hold') {
      const [stored] = await c.env.DB.batch([
        ...plan.statements,
        ...dedupStatements(c.env.DB, {
          organizationId,
          integrationId: row.id,
          deliveryId: id,
          dedupKey: dedup.hex,
          nowMs,
        }),
      ]);
      if (stored?.meta.changes) held++;
      continue;
    }
    const results = await ingressBatch(c.env.DB, [
      // Not when this event is already waiting in `held_events` (ADR 0016).
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO deliveries(id,integration_id,organization_id,state,dedup_key,body_hash,created_at,correlation_id)
         SELECT ?,?,?,'pending',?,?,CURRENT_TIMESTAMP,?
         WHERE NOT EXISTS (SELECT 1 FROM held_events WHERE id=? AND organization_id=?)`,
      ).bind(id, row.id, organizationId, dedup.hex, bodyHash, currentCorrelationId(), id, organizationId),
      // Only if the delivery row above was NEW (`changes()` is the previous statement's row
      // count). Otherwise a repeat after the outbox row was purged (retention drops dispatched
      // outbox rows after 7 days while the delivery lives on) would send the event again.
      c.env.DB.prepare(
        `INSERT INTO notification_outbox(id,organization_id,payload_json,correlation_id)
         SELECT ?,?,?,? WHERE changes() > 0
         ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json, state='pending', lease_token=NULL,
           claimed_at=NULL, lease_expires_at=NULL, not_before=NULL, dispatched_at=NULL,
           correlation_id=excluded.correlation_id
         WHERE notification_outbox.organization_id=excluded.organization_id`,
      ).bind(id, organizationId, JSON.stringify(message), currentCorrelationId()),
      // A repeat is recorded as suppressed, not dropped (F171, F185).
      ...dedupStatements(c.env.DB, {
        organizationId,
        integrationId: row.id,
        deliveryId: id,
        dedupKey: dedup.hex,
        nowMs,
      }),
    ]);
    if (results[1]?.meta.changes) queued++;
  }

  try {
    await c.env.DB.prepare(
      'UPDATE sources SET last_received_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?',
    )
      .bind(source.id, organizationId)
      .run();
  } catch {
    // Display-only bookkeeping; the event itself is already durable.
    log('warn', 'generic_source_touch_failed', { source_id: source.id });
  }

  if (queued > 0)
    c.executionCtx.waitUntil(
      settleBackground(
        dispatchOutbox(c.env, { now: () => Date.now(), newLeaseToken, organizationId }),
        'outbox_dispatch',
      ),
    );
  // F50: an exact duplicate is 200, not 202 and never 4xx.
  const duplicate = rows.results.length > 0 && queued === 0 && held === 0;
  await recordIngressUsage(
    c.env.DB,
    organizationId,
    'generic',
    duplicate ? { duplicate: 1 } : queued + held > 0 ? { accepted: 1 } : {},
    nowMs,
  );
  return c.json(
    {
      accepted: true,
      persisted: queued,
      ...(held > 0 ? { held } : {}),
      ...(duplicate ? { duplicate: true } : {}),
    },
    duplicate ? 200 : 202,
  );
}
