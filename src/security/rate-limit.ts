/**
 * D1-backed fixed-window abuse limiter (spec 02 F29, spec 15 F231).
 *
 * This is an ABUSE control, not a quota or billing counter: rows live in `api_rate_limits`
 * and are pruned by age. Never read these counts for accounting (F29, F231).
 *
 * One UPSERT both counts and reads, so concurrent requests cannot all observe a stale
 * count; D1 serialises writes, so the limit holds across Worker instances and locations
 * (unlike the per-location Workers Rate Limiting binding, AR-8).
 */

export type HitResult = {
  readonly count: number;
  readonly limited: boolean;
  /** Whole seconds until the current window ends; always at least 1. */
  readonly retryAfterSeconds: number;
};

type Db = Pick<D1Database, 'prepare'>;

/** Record one hit against `key` and report whether `limit` for this window is exceeded. */
export async function hit(
  db: Db,
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): Promise<HitResult> {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const row = await db
    .prepare(
      `INSERT INTO api_rate_limits(key,window_start,count) VALUES(?,?,1)
       ON CONFLICT(key,window_start) DO UPDATE SET count=count+1
       RETURNING count`,
    )
    .bind(key, windowStart)
    .first<{ count: number }>();
  const count = row?.count ?? 0;
  return {
    count,
    limited: count > limit,
    retryAfterSeconds: Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)),
  };
}

/** Counters older than this are pruned by the `rate_limit_prune` cron job. */
export const RATE_LIMIT_RETENTION_MS = 60 * 60 * 1000;

/** Delete windows that ended before `olderThan`. Bounded so one cron tick stays cheap. */
export async function pruneRateLimits(db: Db, olderThan: number, batch = 500): Promise<number> {
  const res = await db
    .prepare(
      `DELETE FROM api_rate_limits WHERE rowid IN
         (SELECT rowid FROM api_rate_limits WHERE window_start < ? LIMIT ?)`,
    )
    .bind(olderThan, batch)
    .run();
  return res.meta?.changes ?? 0;
}

/**
 * Per-installation webhook flood control (F29).
 *
 * Call it AFTER the signature has been verified and the installation id read from the
 * verified payload, so an unauthenticated caller cannot burn another installation's
 * budget. The key is the installation id because that is the only tenant-shaped
 * identifier a GitHub App event carries before tenant resolution; once resolved,
 * prefer `(organization_id, connection_id)`.
 *
 * Do NOT apply it to lifecycle events (`installation`, `installation_repositories`,
 * `ping`): a revocation or removal is a security signal, and answering 429 would make
 * GitHub's retry policy delay it. Those events change state, route nothing, and are
 * cheap. Apply it only on the notification-routing path.
 *
 * The limit is deliberately generous: a legitimate burst (mass push, bot-driven PR
 * churn) must not drop notifications, and a 429 means GitHub may not redeliver
 * automatically (GitHub does not retry failed deliveries on its own; an operator
 * redelivers them). The goal is bounding a runaway sender, not shaping normal traffic.
 */
export const INGRESS_LIMIT_PER_MINUTE = 600;
const INGRESS_WINDOW_MS = 60_000;

export type IngressDecision =
  { readonly limited: false } | { readonly limited: true; readonly retryAfterSeconds: number };

export async function ingressLimiter(
  env: { readonly DB: Db },
  installationId: number,
  now: number = Date.now(),
): Promise<IngressDecision> {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) return { limited: false };
  const result = await hit(
    env.DB,
    `ingress:github:${installationId}`,
    INGRESS_LIMIT_PER_MINUTE,
    INGRESS_WINDOW_MS,
    now,
  );
  return result.limited ? { limited: true, retryAfterSeconds: result.retryAfterSeconds } : { limited: false };
}

/**
 * Per-source flood control for the generic webhook source (ADR 0012). Same discipline as
 * `ingressLimiter`: call it only AFTER the signature verified, so an unauthenticated caller
 * cannot burn a source's budget. The key is the source row id (a server-minted uuid), never
 * the public endpoint id.
 */
export const SOURCE_INGRESS_LIMIT_PER_MINUTE = 600;

export async function sourceIngressLimiter(
  env: { readonly DB: Db },
  sourceId: string,
  now: number = Date.now(),
): Promise<IngressDecision> {
  const result = await hit(
    env.DB,
    `ingress:source:${sourceId}`,
    SOURCE_INGRESS_LIMIT_PER_MINUTE,
    INGRESS_WINDOW_MS,
    now,
  );
  return result.limited ? { limited: true, retryAfterSeconds: result.retryAfterSeconds } : { limited: false };
}
