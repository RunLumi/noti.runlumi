# ADR 0011: Observability core (D1-derived SLIs, correlation, stall detection, retention)

Status: Accepted · Date: 2026-10-13 · Implements part of F193, F194 (key set), F197, F198, F200 and F201 in docs/specs/13-observability.md, and the retention/bounded-purge pieces of F204 and F192's "chunked" rule

## Context

Spec 13 says D1 is the ledger of record and Cloudflare's logs and analytics are a view,
because log ingestion can stop or sample exactly when it is needed. Nothing was measured
before this slice: there was no way to answer "how many deliveries failed, how late are they,
is anything stuck" without reading rows by hand, no operator procedures, and operational rows
grew without bound.

## Decision

1. **Correlation** (`src/platform/correlation.ts`). One middleware mints a v4 UUID per request
   before any parsing, echoes it as `x-request-id`, and stores it with `AsyncLocalStorage`
   (the Worker runs with `nodejs_compat`). `log()` merges `correlation_id`, and when present
   `external_request_id` and `cf_ray`, into every line; the existing redaction still runs
   over the merged object. A caller-supplied `x-request-id` is **not adopted**: spec F193
   says our id is never replaced, because a caller could choose a value that collides with a
   real one. A sane inbound value (4-64 chars of `[A-Za-z0-9._:-]`) is logged beside ours as
   `external_request_id`. This departs from "accept a sane inbound id" in the slice brief on
   purpose; the spec is authoritative.
2. **SLIs from the ledger** (`src/observability/slis.ts`, `GET /api/observability/summary`).
   Exact figures for one workspace and one window (1 hour to 30 days, else HTTP 400), behind
   `delivery.read` so members can read their own workspace. Latency is `last_attempt_at`
   minus `created_at` for `sent`/`accepted` rows, with percentiles by nearest rank in SQL
   (`ORDER BY … LIMIT 1 OFFSET`), never an average. `created_at` is a one-second-resolution
   text timestamp, so the response says `resolutionMs: 1000`. Empty windows return `null`,
   not 0 or 1. Teams is reported with `outcomeKind: "accepted"`. Anything the schema cannot
   support is listed in `notMeasurable` with the missing data named: acceptance and routing
   rates (no events table), ack and attempt latency (not timestamped), unmapped provider
   errors (the adapters flag them per attempt but the flag is not persisted), duplicates
   dropped at ingress (`INSERT OR IGNORE` does not count), end-user receipt (unobservable).
3. **Stall detection** (`src/observability/stall.ts`, called from `scheduled()`). Counts
   due outbox rows older than 5 minutes, deliveries claimed for over 10 minutes (twice the
   lease), and retries overdue by 15 minutes. A pure `decideStall` turns counts plus the
   previous state into raise, renotify (hourly), recover or nothing, so a persistent stall
   logs once, not every minute. State is one JSON row in the new `ops_state` table
   (migration 0016) instead of the spec's `alert_state` plus `job_runs`; this slice builds
   neither. The log line carries counts only. It detects; it does not page.
4. **Retention** (`src/pipeline/retention.ts`, called from `scheduled()`).
   `DELIVERY_RETENTION_DAYS` (default **90**, 30-365) and `AUDIT_RETENTION_DAYS` (default
   365, 30-3650) are wrangler vars; bad values fall back to the default. 90 days is the
   spec's stated delivery-metadata horizon (F197); the slice brief suggested 30 as an
   example. The 30-day floor keeps the SLI window cap answerable. Only terminal delivery rows
   are deleted; a dead-lettered row also needs `dead_lettered_at` past the cutoff; outbox rows
   are deleted only when orphaned (no delivery row remains), so replay keeps working for
   retained rows. Deletes are age-based, tenant-agnostic, 500 rows per statement and at most 5
   rounds per tick, so a backlog drains over several ticks. Migration 0016 adds the two
   indexes those scans need.
5. **Runbook** (`docs/RUNBOOK.md`). Procedures tied to real tables and columns, with
   unverified Cloudflare behaviour marked.

## Consequences

- Operators can answer the basic delivery questions from D1, and see a persistent stall as a
  single warn line. Nobody is paged and no UI shows the summary.
- The queue message and the delivery/outbox rows do not carry the correlation id, because
  that needs edits to `src/pipeline/consumer.ts` and the GitHub route that other slices were
  editing. Until then the id finds request logs, not deliveries (spec F193 gap).
- A failing `detectStalls` or purge throws from `scheduled()` and fails that invocation
  visibly; they run last so earlier jobs are unaffected.
- The summary endpoint runs about a dozen queries per call, each reading one workspace's rows (the `organization_id` index) within the window. The one-minute cron pays one
  read for stall detection when healthy.

## Not done

`job_runs`/`job_cursors` and the job runner (F192), `alert_state` and the other alerts
(F200), Analytics Engine (F191), the event catalogue and key-set enforcement (F194),
redaction enforcement points beyond the existing layer (F195), log cost control (F196),
product analytics (F199), the evidence bundle (F202), the refusal list and publication gate
(F203), capability gates for recovery actions (F204 beyond the existing `delivery.*`
capabilities), the dashboard view of the summary, propagation to queue and rows, and any
rehearsal of the runbook.

## Review follow-ups (post-review amendments)

- **Isolated cron jobs.** `scheduled()` now runs a heartbeat upsert and stall detection first,
  then each job inside its own try/catch (`src/observability/cron.ts`). A failure logs a
  redacted `cron_job_failed` line and the invocation still rejects after every job has run.
- **Retention cost.** The purge statements range-seek `deliveries_state_created` (the
  `COALESCE(created_at, updated_at)` form could not), with a separate rare statement for rows
  with no `created_at`. The purge runs at most hourly, throttled through `ops_state`
  (`last_retention_at`, advanced only when a pass completes). If `ops_state` is unreadable the
  purge runs anyway. Invalid retention vars log `retention_config_invalid` (name only). An
  EXPLAIN QUERY PLAN test covers each statement. Real-D1 `meta.changes` semantics for the
  drain loops are unverified.
- **Summary cost.** Per-user limit of 30 reads a minute (the `hit()` limiter used by the
  deliveries API). It relies on `deliveries_org_created` from migration 0013 (not redefined
  here). Each latency summary is one statement returning the sample count, p50, p95 and
  terminal count, so the figures come from one snapshot. Ratios are a cohort by creation time
  and the definitions say so. The outbox age is over due rows only.
- **Heartbeat.** One UPSERT per tick (`ops_state.cron_heartbeat`) backs the runbook's cron
  liveness check.
- **Audit retention and workspace deletion.** The `workspace.purged` audit row has a NULL
  organization and therefore ages out with `AUDIT_RETENTION_DAYS` like any other audit row.
  `workspace_deletions` is the permanent evidence that a purge happened and when; it is not
  subject to this retention.

