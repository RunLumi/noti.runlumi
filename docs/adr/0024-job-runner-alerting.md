# ADR 0024: Job runner, correlation ids and alerting

Status: Accepted · Date: 2026-10-14 · Implements slices 1.9, 1.10 and 1.11 of
[`docs/specs/REMAINING.md`](../specs/REMAINING.md) in part: F192, F193, F200, F201 (and the DLQ part of
F180). Spec 13 is authoritative; "Not done" lists what this leaves out. Builds on
[ADR 0011](0011-observability.md), [ADR 0022](0022-credential-lifecycle-and-boot.md) and
[ADR 0023](0023-delivery-ledger-depth.md).

## Context

Seven background jobs ran every minute and nothing recorded whether any had run: a job that stopped at
a deploy was indistinguishable from a job with nothing to do. The correlation id existed only inside
the request that minted it, so "what happened to this request" could not be answered from a delivery.
Stall detection wrote a log line and nobody was told.

## Decisions

1. **`job_runs` (migration 0027), written by `runCronJobs`.** One row per execution: job, start,
   finish, outcome `ok | failed | skipped`, integer counters (at most eight, rows processed), and an
   error CLASS from a closed list (`database`, `crypto`, `config`, `timeout`, `internal`) chosen from the
   error's shape. No message, tenant id or payload is stored; the redacted log line has the text.
   `healthy` (1 for ok and skipped) makes the freshness check one index point-lookup per job.
   Rows are buffered per tick and written in ONE batch, so recording costs one D1 round trip, and a
   write failure is logged and swallowed: recording never fails or skips a job. The `alerts` job sets
   `flushBefore` so it sees this tick's rows. Cost: about 13 rows a minute, 3-day retention, drained by
   the existing hourly `retention_purge`. No rows are written in maintenance mode (the write freeze holds).
2. **One cadence table** (`src/observability/cadence.ts`) types the job names; `src/index.ts` types its
   job list with them; staleness, the summary and the runbook read the same table (tests enforce it).
   Stale means no healthy run for three cadences. A throttled job (hourly retention) returns
   `skipped`, which counts as alive. A job that never ran is stale only once the table has been
   collecting for longer than three cadences, so a fresh deploy does not alert.
3. **Summary `jobs`** (`name, lastOk, lastFailed, stale`) in `GET /api/observability/summary`. It is
   platform-wide (names and times only) and visible to any workspace member; accepted, recorded in
   the threat model.
4. **DLQ health, honestly.** The dead-letter consumer writes an `ops_state` run record. Queue depth
   is not available to the Worker, so the alert `dlq_consumer_no_progress` is a ledger proxy: rows
   non-terminal for six hours. A stopped dispatcher leaves the same footprint; `outbox_stall` fires
   first then. Real DLQ depth needs the Queues API and is UNVERIFIED/not built.
5. **Correlation everywhere.** `correlation_id` (nullable, at most 64 characters) on `deliveries`,
   `notification_outbox` and `delivery_attempts`; `deliveries` is indexed on
   `(correlation_id, organization_id)` (partial). It is in `DeliveryMessage.correlationId` (dropped if
   malformed; legacy messages still deliver). The three ingress routes, test-send and replay stamp
   it; a replay carries the replay request's id, never the original's. The consumers bind the message's
   id with AsyncLocalStorage (`withMessageCorrelation`) so every log line names it. Attempt rows copy
   it from the delivery row in SQL. `GET /api/deliveries?correlationId=` is workspace-scoped (member or
   admin, 422 on a malformed id) and the view carries `correlationId`. Idempotency and dedup keys are
   unchanged. A notification released from noise control gets a fresh id at release (held events do not
   store the ingress id).
6. **`alert_state` and an engine** (`src/observability/alerts/`). A registry of ten alerts, each reading
   one signal from D1 or the boot report: `job_stale`, `outbox_stall`, `dead_letter_spike`,
   `breaker_open_many`, `key_config_fault`, `credentials_quarantined_nonzero`, `queue_backlog` (age of
   the oldest pending delivery, not depth), `ingress_drop_rate`, `cron_heartbeat_missing`,
   `dlq_consumer_no_progress`. A pure state machine fires once with an incident key, repeats at a
   cadence (critical 1 h, warning 6 h), resolves once. `job_stale` needs two consecutive breaches so the
   tick after a maintenance window cannot notify. An unreadable signal is `null`: it neither fires nor
   resolves. The engine runs second in the tick (detection survives a later hang) and also in the
   failed-boot tick, so `key_config_fault` fires from a Worker that cannot serve.
7. **Sinks.** `AlertSink`: the log (always; error for firing, info for resolved) and an optional webhook
   from the secret `ALERT_WEBHOOK_URL`. The URL must pass the destination URL policy for Slack, Discord,
   Lark or Teams (the four chat hosts; no generic hosts), is sent through `sendRequest` (policy
   re-checked, no redirects, 10 s timeout) once per notification, and a failure is retried at most ten
   minutes later by the engine, never in a loop. An unusable value is a `/health` warning. The text is
   the alert id, severity, numbers, incident key and runbook anchor only. `ALERT_WEBHOOK_URL` is
   declared in `.dev.vars.example` and `Bindings` and, being a bearer secret, is NOT a `wrangler.jsonc`
   var (a var and a secret of one name collide on deploy).
8. **Runbook entry per alert** (`### Alert: <id>`), a cron job table, a correlation lookup, and a test
   that fails when an alert has no entry, an entry has no alert, the anchor drifts, or a new SQL block
   does not run against the schema.

## Not done

- Paging a human (PagerDuty, Opsgenie, phone); acknowledgement and escalation. A chat webhook is a message.
- Job leases, resumable cursors, `cpu_ms`, `partial`, `job_failing`; the missing jobs (GitHub
  delivery-failure poll, reconciliation).
- Real DLQ depth and alerts needing the Queues API or Analytics Engine (`dlq_growth`, `d1_overloaded`,
  `ingress_gap`). A cron that stopped entirely cannot report itself; `cron_heartbeat_missing` fires on
  the first tick after a gap and nothing external watches for silence.
- Locking alert evaluation across overlapping ticks (worst case: one duplicate message, same key).
- Threshold tuning: every threshold is a starting value, unmeasured.
- Nothing was sent to a real Slack, Discord, Lark or Teams endpoint; request shapes follow the documented
  webhook formats and are tested against fakes. Lark bots with signature verification enabled would reject
  the unsigned alert body.
- A correlation id row in the dashboard detail dialog; ids on held events; ids in error bodies.

## Verification

`tests/observability/job-runner.test.ts`, `alerts.test.ts`, `alert-runbook.test.ts`,
`tests/sources/correlation.test.ts`, `tests/migration-0027.test.ts`, plus the retention matrix, tenant
scope and configuration contract tests, over the Node SQLite D1 fake only.
