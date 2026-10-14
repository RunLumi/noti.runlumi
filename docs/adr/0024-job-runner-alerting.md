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

1. **`job_state` and `job_runs` (migration 0027), written by `runCronJobs`.** `job_state` is ONE row per
   job, upserted every tick: first seen, last start and finish, last outcome, last healthy and failed
   time, last counters (at most eight integers, rows processed) and an error CLASS from a closed list
   (`database`, `crypto`, `config`, `timeout`, `internal`) chosen from the error's shape. `job_runs` is the
   HISTORY: a row only for a failure, a first run or a change of outcome, so a quiet healthy job writes no
   history. No message, tenant id or payload is stored; the redacted log line has the text. The state of
   all jobs is read in one 13-row query. Runs are buffered per tick and written in ONE batch (one D1 round
   trip); a write failure is logged and swallowed, so recording never fails or skips a job. The `alerts`
   job sets `flushBefore` so it sees this tick's state. **Write volume** (review M4): about 13 upserts a
   minute, roughly 19,000 rows a day, no secondary index (the first design appended a row per job per tick
   with two indexes, about 56,000 a day). ASSUMPTION, UNVERIFIED: the D1 plan's daily rows-written
   allowance covers that on top of the product's own writes (the Free plan's is 100,000 a day). History is
   kept 14 days, drained by the hourly `retention_purge`. Under MAINTENANCE_MODE the cron writes only one
   `ops_state` marker (see 6).
2. **One cadence table** (`src/observability/cadence.ts`) types the job names; `src/index.ts` types its
   job list with them; staleness, the summary and the runbook read the same table (tests enforce it).
   Stale means no healthy run for three cadences. A throttled job (hourly retention) returns `skipped`,
   which counts as alive. **A job with no record has no deadline** (review M5): it is not stale until it
   first runs, so a job added by a later release never reads stale on deploy; a job that ran but was never
   healthy is stale from ITS OWN first run. A scheduled job that never executes is caught statically (the
   scheduler is tied to the table by a test), not at run time.
3. **Summary** (`GET /api/observability/summary`): admins get `jobs` (`name, lastOk, lastFailed, stale`)
   and `alerting` (webhook configured, last success, last failure, consecutive failures); every member
   gets only `jobsStatus` (`ok | degraded | unknown`). Platform operations detail is not shown to tenants
   (review LOW).
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
   `dlq_consumer_no_progress`. A pure state machine fires once with an incident key, repeats at a cadence
   (critical 1 h, warning 6 h) and resolves once. Hysteresis (review M1): `job_stale` and
   `cron_heartbeat_missing` need two consecutive breaches to fire, and EVERY alert needs three consecutive
   clear evaluations before RESOLVED, so a flapping signal does not flap the channel. An unreadable signal
   is `null`: it neither fires nor resolves. The engine runs third in the tick (heartbeat, stall detection,
   alerts; detection survives a later hang) and also in the failed-boot tick, so `key_config_fault` fires
   from a Worker that cannot serve.
   - **Signals are bounded** (review H2). Every count is capped at its threshold with
     `SELECT COUNT(*) FROM (SELECT 1 ... LIMIT cap)`, every query is an index seek, and migration 0027
     adds partial indexes (`integrations_quarantined`, `sources_dropped`, `delivery_attempts_dead`).
     `tests/observability/alert-plans.test.ts` asserts the plan of every signal query (no scan of
     `deliveries`, `integrations`, `sources`, `delivery_attempts`, `destination_health`, the outbox or
     `job_runs`), with a negative control. The stall counts are read once per tick and shared by the stall
     detector and `outbox_stall`.
   - **Maintenance** (review H1). `scheduled()` returns early under MAINTENANCE_MODE and writes no
     heartbeat; it now makes ONE write, an `ops_state` marker (`cron_maintenance`: a from/to range), in a
     table no migration rebuilds, so the write freeze is otherwise intact. `writeHeartbeat` compares each
     heartbeat with the previous one and records a gap (`cron_gap`) only when it is five minutes or more
     AND no maintenance marker overlaps it; `cron_heartbeat_missing` reads that record (it no longer needs
     one `job_runs` row per heartbeat).
   - **stall.ts is not merged into the engine on purpose.** It logs a `warn` line existing log searches
     and the runbook key on, with its own `ops_state` key; the engine adds hysteresis, sinks and retries
     for the same counts, which it now reads from the same single query. Merging would change the log
     contract for no new signal.
   - **No legitimate row feeds the DLQ proxy** (review LOW), checked in the code: a retry waiting for a
     future time is not overdue (breaker deferral is at most 24 h and then dead-letters); a disabled or
     deleted integration's delivery is still dispatched and then dead-lettered by the consumer; the outbox
     purge only removes rows of finished deliveries; tests are excluded.
7. **Sinks** (`AlertSink`): the log (always; error for firing, info for resolved) and an optional webhook
   from the secret `ALERT_WEBHOOK_URL` (surrounding whitespace trimmed). The URL must pass the destination
   URL policy for Slack, Discord, Lark or Teams (the four chat hosts; no generic hosts), is sent through
   `sendRequest` (policy re-checked, no redirects) once per attempt. Review M2: a notice a sink refused
   stays on its alert row (`unsent`, `retry_at`, `notify_failures`) and is re-sent AS THE SAME KIND (a
   FIRING stays a FIRING; a RESOLVED is retried) about ten minutes later, up to six tries, then dropped
   with a log line; a newer transition supersedes it. All sinks share a 15 s budget per evaluation (each
   call gets what is left, capped at 10 s), so a hung webhook cannot delay the later jobs. The webhook's
   health (last success, last failure, consecutive failures) is an `ops_state` record shown to admins in the
   summary; it is not on `/health`, which deliberately touches no dependency (a deviation from the
   request, for that reason). A set-but-unusable URL logs `alert_webhook_unusable` every tick and is a
   `/health` warning. The text is the alert id, severity, numbers, incident key and runbook anchor only.
   `ALERT_WEBHOOK_URL` is declared in `.dev.vars.example` and `Bindings` and, being a bearer secret, is NOT a
   `wrangler.jsonc` var (a var and a secret of one name collide on deploy).
8. **Runbook entry per alert** (`### Alert: <id>` with `What it means`, `Check` and `What to do`
   labels), a cron job table, a correlation lookup and a deploy-order note, and a test that fails when an
   alert has no entry or a label is missing, an entry has no alert, the anchor drifts, or a new SQL block
   does not run against the schema.
9. **Deploy order.** Apply migration 0027 before the Worker (it adds tables, partial indexes and three
   nullable columns; an `ADD COLUMN ... CHECK` validates existing rows once, a full scan per table, so use a
   quiet window on a large database). The previous Worker ignores all of it.

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
- `dead_letter_spike` does not count dead letters from the DLQ consumer (they write no attempt row); the
  DLQ proxy covers that path.
- The webhook's health is not on `/health` (it must stay dependency-free).

## Verification

`tests/observability/job-runner.test.ts`, `alerts.test.ts`, `alerts-hardening.test.ts`,
`alert-plans.test.ts`, `alert-runbook.test.ts`,
`tests/sources/correlation.test.ts`, `tests/migration-0027.test.ts`, plus the retention matrix, tenant
scope and configuration contract tests, over the Node SQLite D1 fake only.
