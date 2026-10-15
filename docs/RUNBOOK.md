# Operations runbook

The availability and delivery-loss runbook (docs/specs/13-observability.md F201). Security
incidents are a different document: if you suspect credential exposure or cross-tenant
access, **stop and escalate** to [`INCIDENT_RESPONSE.md`](INCIDENT_RESPONSE.md) (spec 15 F242).
Do not triage them here.

Status: **written, never rehearsed.** Every command below was derived from the code and
migrations in this repository. None has been run against a production Cloudflare account.
Anything that depends on Cloudflare behaviour that was not verified is marked **UNVERIFIED**.
No security audit has been performed (docs/SECURITY.md).

## Read this first: the delivery model

- Delivery is **at least once**. A notification can arrive twice. It cannot be promised to
  arrive exactly once, and nothing in this product says it does.
- `sent` means the provider confirmed delivery. `accepted` means the provider took the
  request but cannot confirm delivery (Microsoft Teams Workflows returns 202). Never tell a
  customer a Teams message was "delivered".
- D1 is the ledger of record. Logs are a view: Workers Logs can stop ingesting or sample
  (spec 13, "The decision that shapes everything here"; plan limits **UNVERIFIED** here).
  Decide from D1 first, logs second.
- Every request carries an `x-request-id` response header. A customer can quote it and you can
  find the log lines with the same `correlation_id`, and the delivery it created: the id is stored
  on `deliveries`, `notification_outbox` and `delivery_attempts` and carried in the queue message,
  so the consumer's log lines carry it too (ADR 0024, "Find a delivery by correlation id" below).
  Rows older than migration 0027 and notifications released from noise control have no ingress id.

## Access and conventions

- Operator access is `wrangler` authenticated to the Cloudflare account (the same access that
  deploys). The D1 database is `lumi-noti`; queues are `noti-deliveries` and
  `noti-dead-letters` (wrangler.jsonc).
- Run queries with `wrangler d1 execute lumi-noti --remote --command "<SQL>"`. Prefer `SELECT`.
  Production writes below are **break-glass**: they exist because no product action does the
  job yet (a gap, not a design; file it afterwards). Say so in the incident record.
- Select counts and ids, never payloads. `notification_outbox.payload_json` holds display
  text (titles, repo, actor), not credentials, but treat it as customer data.
- Timestamps: `deliveries.created_at`, `notification_outbox.created_at` are SQLite text
  (`YYYY-MM-DD HH:MM:SS`, UTC). `claimed_at`, `next_attempt_at`, `last_attempt_at`,
  `lease_expires_at`, `not_before`, `dead_lettered_at` are epoch **milliseconds**.
- Live logs: `wrangler tail lumi-noti --format json`. Stall and maintenance lines are named
  `delivery_stall`, `delivery_stall_recovered`, `outbox_reconcile`, `outbox_dispatch_incomplete`,
  `credential_maintenance`, `retention_purge`, `workspace_purge`.

## Severity

| Sev | Meaning | Examples | First response |
| --- | --- | --- | --- |
| 1 | Notifications are being lost or are not flowing for many workspaces | outbox not draining (`delivery_stall` renotifying), `/health` returns 503, ingress rejecting valid events, D1 unavailable | Start at "What to check first". Page the owner. Decide the customer message within 30 minutes |
| 2 | One workspace or one destination is affected | one destination failing, a quarantined credential, a missed webhook window | Diagnose per section below. Tell the affected workspace |
| 3 | Degraded but not losing anything | slow delivery, growing but draining backlog, retention not keeping up | Fix in working hours; record |
| Security | Any suspicion of exposure | leaked URL in a log, cross-tenant read | Stop; follow `INCIDENT_RESPONSE.md` (classes S1 to S4 there; a Security row here is S1 or S2 until shown otherwise) |

These tiers are this runbook's own judgement. No on-call rota or paging integration exists, so
today **nobody is paged**: ten alerts are evaluated every minute (see "Alerts" below) and announced
to the log and, when `ALERT_WEBHOOK_URL` is set, to a Slack, Discord, Lark or Teams channel. That
is a message to a channel someone must be watching, not an acknowledged page; PagerDuty or
Opsgenie style paging is not built (ADR 0024).

## What to check first

1. `GET /health` on the Worker. 503 carries a `code` (`config_invalid`, or `kek_environment_mismatch`
   for a KEK from another environment) and nothing else: it no longer names the bindings to an
   anonymous caller (ADR 0036). Read the names from the `config_invalid` log line (`wrangler tail`)
   or as a platform operator from `GET /api/observability/readiness` ("Operator readiness view").
   200 proves the Worker boots with a valid configuration, and says nothing about D1. Then
   `GET /health/ready` (see "Readiness endpoint").
2. Is the cron running? Every tick upserts a heartbeat first:
   `SELECT value AS last_tick_ms, updated_at FROM ops_state WHERE key='cron_heartbeat';`
   Compare with `strftime('%s','now')*1000`; it should be under about two minutes old. The
   cron is `* * * * *` (wrangler.jsonc). If it is stale, the Worker may not be deployed with
   its cron trigger, or D1 is unreachable (check `wrangler tail`). Each job is isolated: a
   failing job logs `cron_job_failed` with the job name and the invocation still fails at the
   end, but the other jobs (stall detection, retention) still run. Every execution updates the job's `job_state` row (history in `job_runs`), and admins see each job's
   last healthy run and whether it is stale in `GET /api/observability/summary` ("Cron jobs" below).
3. Backlog **age**, not depth (spec 13 F198). Platform-wide, in one query:

   ```sql
   SELECT
     (SELECT COUNT(*) FROM notification_outbox WHERE state='pending') AS outbox_pending,
     (SELECT MIN(created_at) FROM notification_outbox WHERE state='pending') AS oldest_outbox_pending,
     (SELECT COUNT(*) FROM notification_outbox WHERE state='claimed') AS outbox_claimed,
     (SELECT COUNT(*) FROM deliveries WHERE state='claimed') AS delivery_claimed,
     (SELECT COUNT(*) FROM deliveries WHERE state='retrying') AS delivery_retrying,
     (SELECT COUNT(*) FROM deliveries WHERE state='dead_lettered') AS dead_lettered;
   ```

4. For one customer, the workspace summary: `GET /api/observability/summary?window=24h` as a
   member of that workspace (see docs/API.md). It reports counts by state, success ratio,
   dead letters by error code, backlog ages and what is not measurable. It is the same data
   the SQL below reads, scoped to one workspace.

## Cron jobs

One table lists the jobs and their cadence: `JOB_CADENCE` in `src/observability/cadence.ts`. The
scheduler, the `job_stale` alert, the summary's `jobs` list and this section read it; a test fails
if a scheduled job is missing from it or from here. Every job runs on the every-minute trigger, so a
job is **stale** when its last healthy run (`ok` or `skipped`) is more than three minutes old.

| Job | What it does |
| --- | --- |
| `heartbeat` | Proves the cron fired (one UPSERT into `ops_state`) and records a gap if ticks were missed. |
| `stall_detection` | Counts stuck outbox, claim and retry rows; logs on entry and recovery. |
| `alerts` | Evaluates the alert registry and notifies the sinks. |
| `outbox_reconcile` | Releases stale claims, publishes due outbox rows, purges the outbox. |
| `noise_release` | Releases held (quiet-hours, digest, grouped) events through the outbox. |
| `credential_maintenance` | Legacy credential migration and KEK rewrap, bounded per tick. |
| `rate_limit_prune` | Drops expired fixed-window rate-limit counters. |
| `workspace_purge` | Purges the next workspace whose deletion window has elapsed. |
| `retention_purge` | Retention for deliveries, audit, attempts, destination health and `job_runs` (hourly throttle: most ticks record `skipped`). |
| `routing_decisions_purge` | Routing provenance retention. |
| `noise_purge` | Released and failed noise-control records. |
| `expired_auth_purge` | Expired sessions, one-time tokens, install states. |
| `dedup_purge` | Expired dedup rows. |

Two tables (migration 0027). `job_state` has ONE row per job, overwritten every run: first seen, last
start and finish, last outcome, last healthy and last failed time, last counters (rows processed) and
last `error_class` (one of `database`, `crypto`, `config`, `timeout`, `internal`; the error text is in the
redacted `cron_job_failed` log line, never in D1). `job_runs` is the history of failures and changes of
outcome only (a steady healthy job writes none), kept 14 days.

```sql
SELECT job, last_outcome, last_counters_json, last_error_class, runs,
       datetime(last_finished_at/1000,'unixepoch') AS finished,
       datetime(last_healthy_at/1000,'unixepoch') AS last_healthy,
       datetime(last_failed_at/1000,'unixepoch') AS last_failed
FROM job_state ORDER BY job;
-- When did a job start failing or recover?
SELECT job, outcome, error_class, datetime(finished_at/1000,'unixepoch') AS at
FROM job_runs ORDER BY id DESC LIMIT 40;
```

Cost: 13 `job_state` upserts a minute, one batch per tick, about 19,000 rows written a day with no secondary
index, plus a few history rows. **Assumption, UNVERIFIED:** the D1 plan's daily rows-written allowance
covers that on top of the product's own writes (the Free plan's is 100,000 a day, a fifth of it). A job
with no `job_state` row has never run and is not stale (it has no deadline until it runs). Not built from
F192: leases between overlapping runs, resumable cursors, `cpu_ms`, `partial` outcomes, `job_failing`
after three consecutive failures (a failing job goes stale instead), a separate `job_never_ran`.

## Alerts

Evaluated by the `alerts` job once a minute from signals in D1 and the boot report
(`src/observability/alerts/`). Every count is capped at its threshold and every query is an index seek
(`tests/observability/alert-plans.test.ts`). An alert fires once (some need two consecutive breaches),
repeats at its re-notify cadence (critical 1 h, warning 6 h) while it keeps firing, and sends RESOLVED once
it has been clear for three evaluations in a row. State is in `alert_state`:

```sql
SELECT alert_id, state, datetime(since/1000,'unixepoch') AS since, last_value, dedupe_key,
       unsent, notify_failures
FROM alert_state ORDER BY state, alert_id;
```

Delivery: every event is a structured log line (`alert_firing`, `alert_renotify`, `alert_resolved`,
searchable with `wrangler tail --format json`), and also a message to `ALERT_WEBHOOK_URL` when that
secret holds a Slack, Discord, Lark or Teams Workflows webhook URL (surrounding whitespace is ignored).
The message carries the alert id, severity, value, threshold, the incident key and the runbook anchor;
never a tenant id or a payload. A notice the webhook refused is kept on its alert row (`unsent`) and re-sent
as the same kind about ten minutes later, up to six tries, then dropped (`alert_notice_dropped` in the log).
All sinks together get 15 seconds per evaluation, so a hung endpoint cannot hold up the jobs after it.

Is the webhook working? A platform operator (a user id on the secret `PLATFORM_OPERATOR_USER_IDS`; nobody by default, and a workspace admin is not one) sees it in `GET /api/observability/summary` under `alerting` (configured,
last success, last failure, consecutive failures), also readable here:

```sql
SELECT value, datetime(updated_at/1000,'unixepoch') AS updated FROM ops_state WHERE key='alert_sink_health';
```

A set but unusable `ALERT_WEBHOOK_URL` logs `alert_webhook_unusable` once an hour and `/health` lists it under
`warnings`. Webhook health is NOT on `/health`, which deliberately touches no dependency. **UNVERIFIED:**
no message has been sent to a real Slack, Discord, Lark or Teams endpoint from this code; the request
shapes follow each provider's documented webhook format and are exercised against fakes only.

Thresholds are starting values from the specification, not measured baselines
(`src/observability/alerts/thresholds.ts`): there is no production traffic to tune them against. Expect
to change them, and to have noise until you do.

**Maintenance windows.** Under `MAINTENANCE_MODE` the cron skips every job and writes exactly one row, a
marker in `ops_state` (`cron_maintenance`), so the silence is not read as a missed cron: a heartbeat gap is
excused only when the marker brackets the WHOLE gap (a marker in the middle of a longer silence excuses
nothing). Nothing else is written during the freeze. For ten minutes after the last skipped tick the alerts
that read backlog or job freshness (`job_stale`, `outbox_stall`, `queue_backlog`,
`dlq_consumer_no_progress`) hold their state: the first ticks after a freeze see every job overdue and the
outbox undrained until the cron catches up, and these alerts also need two consecutive breaches. A backlog
that is still there after that fires; the guard delays, it does not hide. If the marker cannot be written
the gap is reported (a false alarm, never silence). A `MAINTENANCE_MODE` left on logs
`maintenance_mode_prolonged` (error level) once an hour from the first hour: the alert job is skipped too, so
that log line is the only signal.

### Alert: job_stale

**What it means.** A cron job has not completed healthily for more than three cadences (three minutes).
Fires after two consecutive evaluations, so the one tick after a maintenance window (every job is overdue
until its next run) does not notify. Severity critical.

**Check.**

```sql
SELECT job, last_outcome, datetime(last_healthy_at/1000,'unixepoch') AS last_ok,
       datetime(last_failed_at/1000,'unixepoch') AS last_failed
FROM job_state ORDER BY last_healthy_at;
```

**What to do.** A job with `last_failed` newer than `last_ok` is failing: read its `cron_job_failed` log
line. A job with neither recent means the cron did not run it (see `cron_heartbeat_missing`). Fix the
cause, then wait a tick; redeploy if the cron trigger is gone (`npm run deploy`).

### Alert: outbox_stall

**What it means.** Outbox rows pending over five minutes, claims older than two leases, or retries overdue
by 15 minutes (the same counts as the `delivery_stall` log line, read once per tick and shared). Severity
critical; fires after two consecutive evaluations.

**Check.** The queries in "Stuck outbox" and "Queue backlog" below; the stall counts are capped at 1000.

**What to do.** Follow "Stuck outbox" and "Queue backlog".

### Alert: dead_letter_spike

**What it means.** At least 20 delivery attempts dead-lettered in the last 15 minutes (counted from
`delivery_attempts`, platform-wide; test notifications are included). Severity warning. **Blind spot:**
a delivery dead-lettered by the dead-letter queue consumer (its queue retries ran out) writes no attempt
row, so it is not counted here; `dlq_consumer_no_progress` and the `dlq_consumer` record cover that path.

**Check.** Group by code to see whether one destination, one workspace or one fault class is responsible:

```sql
SELECT error_code, COUNT(*) AS n FROM delivery_attempts
WHERE outcome='dead_lettered' AND started_at >= (strftime('%s','now')*1000 - 900000)
GROUP BY error_code ORDER BY n DESC;
```

**What to do.** Follow "Dead-letter inspection and redelivery". Replay only after the cause is fixed.

### Alert: breaker_open_many

**What it means.** Three or more destination circuit breakers are open or half-open. Severity warning. One
breaker is a customer's endpoint failing; several at once usually means our egress, a provider outage or DNS.

**Check.**

```sql
SELECT destination_host, state, consecutive_failures, last_failure_code, opened_count
FROM destination_health WHERE state IN ('open','half_open') ORDER BY updated_at DESC LIMIT 20;
```

**What to do.** If the hosts are all one provider, check the provider's status page before anything else.
See "Per-attempt history, duplicates and the circuit breaker".

### Alert: key_config_fault

**What it means.** The boot report names a missing or invalid required binding (storage, credentials or
queue). Severity critical. Evaluated even when the Worker refuses to serve (`/health` is 503). Nothing is
delivered that needs a credential until it is fixed.

**Check.** `GET /health` names the bindings and a `code`.

**What to do.** Follow "What a configuration fault stops" and "KEK check value and environment mismatch".

### Alert: credentials_quarantined_nonzero

**What it means.** At least one integration has credentials the Worker cannot open and has quarantined.
Severity warning. One integration is a customer-facing fault, not an outage; many at once after a deploy
means a key ring or KEK fault (`key_config_fault` fires too).

**Check.** The queries in "Quarantined credentials".

**What to do.** Follow "Quarantined credentials".

### Alert: queue_backlog

**What it means.** The oldest `pending` delivery is older than 15 minutes (age, not depth). Severity
critical. Queue depth itself is not measurable from the Worker (**UNVERIFIED**: the Queues API was not used).

**Check.**

```sql
SELECT organization_id, COUNT(*) AS n, MIN(created_at) AS oldest
FROM deliveries WHERE state='pending' AND is_test=0 GROUP BY organization_id ORDER BY oldest LIMIT 20;
```

**What to do.** A pending delivery whose outbox row is `dispatched` is waiting in the queue: look at the
consumer (`wrangler tail`). A pending delivery with an outbox row still `pending` is "Stuck outbox".

### Alert: ingress_drop_rate

**What it means.** Three or more provider sources dropped events (the per-source flood limit) in the last
15 minutes. Severity warning. One source dropping is one tenant's flood; several at once suggests abuse
or a provider replaying.

**Check.**

```sql
SELECT id, organization_id, kind, dropped_events, last_dropped_at FROM sources
WHERE last_dropped_at >= datetime('now','-15 minutes') ORDER BY last_dropped_at DESC LIMIT 20;
```

**What to do.** See "Generic source: edge rate rule".

### Alert: cron_heartbeat_missing

**What it means.** A heartbeat came five minutes or more after the one before it, with no maintenance
skip in between, inside the last 30 minutes: the cron missed ticks. Fires after two evaluations. Severity
critical. This is detected **after the fact**, on the first tick that runs again; a cron that has stopped
entirely cannot report itself, and nothing external watches for that (not built: use an external
dead-man's-switch against `ops_state.cron_heartbeat`).

**Check.**

```sql
SELECT key, value, datetime(updated_at/1000,'unixepoch') AS updated FROM ops_state
WHERE key IN ('cron_heartbeat','cron_gap','cron_maintenance');
```

**What to do.** A gap during a deploy or a Cloudflare incident is expected; a recurring gap means the
trigger is missing or the invocation is being cut off. Look for `cron_job_failed` and `job_stale`.

### Alert: dlq_consumer_no_progress

**What it means.** Ledger rows have been non-terminal for six hours or more (pending or claimed since
then, or retrying and overdue by that long): the footprint of messages that exhausted their queue retries
and were never moved to `dead_lettered`. Severity critical. **This is a proxy.** The Worker cannot read the
dead-letter queue's depth (needs the Queues API; **UNVERIFIED**), so it infers from the ledger; a stopped
dispatcher leaves the same footprint (`outbox_stall` fires first in that case). No legitimate row waits that
long: a retry waiting for a future time is not overdue, a disabled or deleted integration's delivery is
still dispatched and then dead-lettered, and test notifications are excluded.

**Check.**

```sql
SELECT value, datetime(updated_at/1000,'unixepoch') AS last_run FROM ops_state WHERE key='dlq_consumer';
SELECT state, COUNT(*) AS n, MIN(created_at) AS oldest FROM deliveries
WHERE is_test=0 AND state IN ('pending','claimed','retrying') AND created_at < datetime('now','-6 hours')
GROUP BY state;
```

**What to do.** `dlq_consumer` is written on every run of the dead-letter consumer
(`{"at":..,"seen":..,"moved":..}`); a stale or absent value with stuck rows suggests the consumer is not
attached (check the `noti-dead-letters` consumer in the Cloudflare dashboard; the queue deletes unconsumed
messages after four days). Fix the consumer, then replay per "Dead-letter inspection and redelivery".

## Find a delivery by correlation id

A customer quotes the `x-request-id` they got back (or a log line shows a `correlation_id`). Workspace
members can look it up in the product: `GET /api/deliveries?correlationId=<id>` (docs/API.md), and the
delivery detail shows it. For an operator, across workspaces:

```sql
SELECT 'delivery' AS kind, id, organization_id, state, created_at FROM deliveries WHERE correlation_id = '<id>'
UNION ALL
SELECT 'outbox', id, organization_id, state, created_at FROM notification_outbox WHERE correlation_id = '<id>'
UNION ALL
SELECT 'attempt', delivery_id, organization_id, outcome, datetime(started_at/1000,'unixepoch')
FROM delivery_attempts WHERE correlation_id = '<id>';
```

**Deploy order.** Apply migration 0027 BEFORE deploying the Worker that writes these columns and tables
(`wrangler d1 migrations apply`, then `npm run deploy`). The previous Worker ignores them, so a rollback
needs no schema change. The `ADD COLUMN ... CHECK` statements make SQLite validate every existing row once
(a full scan of `deliveries`, the outbox and attempts inside the migration): run it in a quiet window on a
large database. It rewrites nothing.

Then the logs: `wrangler tail lumi-noti --format json --search <id>` shows the request's lines and the
consumer's (`delivery_attempt`, `delivery_deferred`, `delivery_dead_lettered_by_queue`) under the same
`correlation_id`. `deliveries` is indexed on `(correlation_id, organization_id)`; the other two tables
are not, so on a large database query them by the delivery id you just found. The id is our own, minted
at ingress; a sender's `x-request-id` is only ever logged as `external_request_id`. A replay gets the id
of the replay request. A notification released from noise control gets a fresh id at release and is not
linked back to its ingress request (held events do not store it).

## Stuck outbox

Symptom: `delivery_stall` warn with `outbox_pending_over_threshold > 0`, or a workspace's
`oldestOutboxPendingAgeMs` keeps growing. Threshold: a pending outbox row older than 5
minutes (`OUTBOX_STALL_MS`, src/observability/stall.ts) that is due (`not_before` empty or past).

Confirm:

```sql
SELECT id, organization_id, state, created_at, claimed_at, lease_expires_at, not_before, last_error_code
FROM notification_outbox WHERE state IN ('pending','claimed') ORDER BY created_at LIMIT 20;
```

Interpretation (src/pipeline/outbox.ts, src/delivery/claim.ts):

- `pending`, `not_before` in the future: parked retry, not stuck. It re-enqueues when due.
- `claimed`, `lease_expires_at` in the past: a dispatcher died mid-send. The next cron tick
  reclaims it. If it persists across ticks, the cron is not running (see "What to check first").
- `pending`, due, old, `last_error_code` set: the dispatch itself is failing. Read the latest
  `outbox_dispatch_incomplete` log line; `Queue.send()` failures leave the row for the next tick and log
  `outbox_send_failed` with that row's `delivery_id` and `correlation_id` (ADR 0046).
- `state='invalid'`, `last_error_code='config_invalid'`: a row with no organization (pre-0006
  data). It is deliberately never routed; leave it.

Mitigation, in order: (1) wait one tick, the reconciler is the recovery mechanism. (2) If the
Worker or cron is not deployed, redeploy (`npm run deploy`). (3) **Break-glass**, a parked row
that should be due now: `UPDATE notification_outbox SET not_before=NULL WHERE id='<id>' AND
organization_id='<org>' AND state='pending';`. Never edit `payload_json`. Never set `state`
by hand to `dispatched`: that drops the notification.

Customer message: "We are investigating delayed notifications. Delayed notifications are
retried and may arrive late or, rarely, twice." Do not say none were lost until you have
checked `dead_lettered`.

## Held updates (noise control)

Symptom: a customer says updates are late, or "quiet hours are not ending". Noise control
(ADR 0016) holds non-urgent updates for quiet hours, digests and grouping, and a cron job
(`noise_release`, before `outbox_reconcile`) releases them.

Confirm what is waiting and whether it is overdue (counts and ids only; the table holds display
fields, never a payload):

```sql
SELECT organization_id, integration_id, state, hold_reason,
       COUNT(*) AS n, MIN(release_at) AS next_release_at, MAX(claim_expires_at) AS lease_until
FROM held_events WHERE state IN ('held','claimed') GROUP BY 1,2,3,4 ORDER BY next_release_at LIMIT 50;
```

Interpretation (src/pipeline/noise-release.ts):

- `held`, `release_at` in the future: working as configured. The dashboard shows the same count and
  next send time (`GET /api/integrations/:id/noise-status`).
- `held`, `release_at` in the past for more than a few minutes: the cron is not running (see
  "What to check first") or `noise_release` is failing; look for `cron_job_failed` with
  `job: noise_release` and `noise_release_failed` (integration id; once a notification exists, also its
  `delivery_id` and `correlation_id`, ADR 0046). At most 20 integrations are
  released per tick, so a very large backlog drains over several ticks.
- `claimed`, `lease_until` in the past: a run died mid-release. The next tick returns the rows to
  `held` (counting an attempt) and releases them; the release is atomic, so nothing was half-sent.
- `held` with `attempts` > 0 and a future `retry_after`: a release failed and is backing off (1 min,
  2, 4 ... up to an hour). `last_error_class` is `batch_failed` or `lease_expired`. Fix the cause (D1,
  a bad row) and it releases on its own.
- `failed`: the row failed 5 times and was dead-lettered. It is kept 30 days, never released, and
  shown as `failed` in `GET /api/integrations/:id/noise-status`. List them with
  `SELECT organization_id, integration_id, hold_reason, attempts, last_error_class, released_at FROM held_events WHERE state='failed';`.
  They hold display fields only; the updates themselves can be replayed from the provider's own
  delivery log while it retains them.
- Rows of a **disabled** integration, or one with quarantined credentials, are deliberately not due:
  they wait and release after it is enabled again. They are not dead-lettered.
- At most 100 notifications are released per tick across all integrations (about 13 D1 calls), so
  a large backlog drains over several ticks; `noise_release` runs after `outbox_reconcile`, and what it
  released is dispatched by the next tick.
- A `noise_hold_capacity` warn: an integration has 500 updates waiting, and further updates are being
  delivered immediately instead of held (by design, to bound storage).
- `noise_settings_unusable` error: an integration's `noise_json` cannot be read, so its updates are
  being delivered normally; the dashboard shows the notice and saving replaces the document.

Mitigation: wait one tick. **Never** `DELETE` or hand-edit rows to "release" them; to stop holding
for an integration set its settings off in the dashboard (rows already held still release on
schedule). Released rows are kept 7 days and removed by the `noise_purge` job.

## Dead-letter inspection and redelivery

`dead_lettered` is terminal. A delivery reaches it when the retry budget is spent (the
attempt budget is `maxAttempts()` in src/delivery/retry.ts), on a permanent error, or when the queue's own retries run
out and the `noti-dead-letters` consumer marks it (`last_error='queue_retries_exhausted'`).

```sql
SELECT last_error_code, COUNT(*) AS n, MIN(dead_lettered_at) AS first_ms, MAX(dead_lettered_at) AS last_ms
FROM deliveries WHERE state='dead_lettered' AND organization_id='<org>'
GROUP BY last_error_code ORDER BY n DESC;

SELECT i.destination, i.destination_host, d.last_error_code, COUNT(*) AS n
FROM deliveries d LEFT JOIN integrations i ON i.id=d.integration_id AND i.organization_id=d.organization_id
WHERE d.state='dead_lettered' AND d.organization_id='<org>' GROUP BY 1,2,3 ORDER BY n DESC;
```

Error codes are the closed taxonomy in src/platform/errors.ts. Common ones:
`destination_credentials_invalid` (customer must re-enter the webhook; see quarantine),
`destination_revoked` (410, connection deleted at the provider), `destination_unavailable`,
`destination_rate_limited`, `destination_url_rejected` (outside the allowlist).

Replay: `src/delivery/redeliver.ts` implements a manual replay that creates a **new** delivery
(`replay_of` points at the original) and never mutates the original row. Admins use it from the
Activity page (one delivery, or "Redeliver all failed" for a filtered view: a count first, at most
200 per request, one `delivery.bulk_replay` audit row with the counts; see docs/API.md). Do not
hand-insert rows. Replay re-reads the original outbox message. Only the outbox rows of **dead-lettered** deliveries are kept
(and, once their delivery row is purged by retention, removed as orphans). Outbox rows of
delivered deliveries are purged after 7 days (`PURGE_OUTBOX_SQL`, `OUTBOX_RETENTION_MS` in
src/delivery/claim.ts), so an old delivered notification cannot be replayed.

The dead-letter **queue** itself: the Worker consumes it (`noti-dead-letters`, one message at
a time) only to mark the ledger. Browsing queue messages from the CLI is **UNVERIFIED**;
inspect the ledger instead.

Customer message: "Some notifications failed to send to <destination>. The cause is
<plain-language cause from the error code>. Fix the connection and tell us; we can resend
failed notifications once replay is available. A resent notification may duplicate one you
already received."

## Per-attempt history, duplicates and the circuit breaker (ADR 0023)

**What happened on each try.** `delivery_attempts` has one row per attempt and per deferral; the
Activity detail dialog shows it. All columns are closed codes or numbers (outcome, taxonomy code, minted
reason such as `provider_http_503`, status class, `retry_after_ms`); there is no URL, body or header to
leak and nothing to redact. Rows older than migration 0025 have none.

```sql
SELECT attempt, outcome, error_code, reason, status_class, retry_after_ms, possible_duplicate,
       datetime(started_at/1000,'unixepoch') AS started
FROM delivery_attempts WHERE organization_id='<org>' AND delivery_id='<id>' ORDER BY started_at, rowid;
```

**A customer asks "did I get this twice?"** `deliveries.possible_duplicate = 1` means an earlier attempt
ended without the provider confirming it (timeout, dropped connection, 5xx, expired claim) and the send
was retried. It is a possibility: Noti cannot tell. A `suppressed` row (`duplicate_of`, reason
`duplicate`) is a provider redelivery that was recognised and NOT sent again; `event_dedup.hit_count` is
how many times that event came back. Neither means exactly-once, and nothing should say so. `possible_duplicate` is an upper bound (it also marks
a claim a crashed consumer abandoned, `reason = 'claim_expired'` in the attempt log); at most 20 suppressed
rows are kept per original, `event_dedup.hit_count` keeps counting. A suppressed row whose original is
`dead_lettered` means the FIRST delivery failed: redeliver the original, not the repeat.

**"Why is nothing arriving at X?"** Check the breaker before anything else:

```sql
SELECT integration_id, state, consecutive_failures, opened_count, last_failure_code,
       datetime(open_until/1000,'unixepoch') AS open_until, datetime(paused_until/1000,'unixepoch') AS paced_until
FROM destination_health WHERE organization_id='<org>' AND (state <> 'closed' OR paused_until > strftime('%s','now')*1000);
```

A delivery held back (`circuit_open` or `destination_paced`) for more than 24 hours with no real attempt is
dead-lettered with the reason `circuit_open_timeout` or `destination_paced_timeout`; it is replayable once
the destination works. Consecutive identical waits are one `delivery_attempts` row (`repeat_count`).
`open` means the destination failed 5 times in a row; deliveries wait (`retrying`, `last_error =
circuit_open`) and spend no attempt. After `open_until` one probe goes out; success closes it. The integration
page and the delivery say so in plain words. **Noti never disables an integration because of the breaker**, so
there is nothing to re-enable. To clear a breaker by hand (the destination was fixed and waiting is the
problem): `UPDATE destination_health SET state='closed', consecutive_failures=0, open_until=NULL,
probe_until=NULL WHERE organization_id=? AND integration_id=?`; the waiting deliveries then run at their
next scheduled time. `paused_until` is the destination's own rate-limit request; it expires by itself.
No alert fires when a breaker opens yet (see Gaps).

**The dedup table** is purged by the `dedup_purge` cron job (7-day TTL, 500 rows per statement, 5 rounds per
tick, resumable). A backlog after an outage drains over the next ticks; check `SELECT COUNT(*) FROM
event_dedup WHERE expires_at < strftime('%s','now')*1000`.

## Queue backlog

Symptom: `delivery_retrying` grows, or `oldestRetryOverdueMs` in the summary is high
(a retry due 15 minutes ago, `RETRY_OVERDUE_MS`).

```sql
SELECT organization_id, COUNT(*) AS n, MIN(next_attempt_at) AS oldest_due_ms
FROM deliveries WHERE state='retrying' AND next_attempt_at <= (strftime('%s','now')*1000)
GROUP BY organization_id ORDER BY oldest_due_ms LIMIT 20;
```

A retry that is due but not running means the outbox row was not re-enqueued (see "Stuck
outbox") or the consumer is not running. Check `wrangler tail` for consumer errors. A claimed
delivery older than 10 minutes (`CLAIM_STALL_MS`) means the stale-claim sweep
(`sweepStaleClaims`) is not working: it runs every minute and reclaims claims older than the
5-minute lease (`DELIVERY_CLAIM_LEASE_MS`). Depth alone is not the signal: thousands of messages that
drain are healthy; a handful that never move is the incident.

D1 overload errors in logs ("D1 DB is overloaded" per spec 13 F200): that is a sharding signal
(spec 01 F06), not a retry signal. Reduce concurrency. The exact error strings and Cloudflare's
guidance are **UNVERIFIED** here.

## Quarantined credentials

A row is quarantined when its own ciphertext will not open
(`integrations.credentials_quarantined_at`, `credentials_quarantine_reason`). It stops
delivering and its deliveries dead-letter with `destination_credentials_invalid`.

```sql
SELECT id, organization_id, destination, credentials_quarantined_at, credentials_quarantine_reason
FROM integrations WHERE credentials_quarantined_at IS NOT NULL;
```

Fix: the customer re-enters the destination in the dashboard (writes fresh key material and
clears the flag). Break-glass only after the cause is fixed (docs/IMPLEMENTATION.md):
`UPDATE integrations SET credentials_quarantined_at=NULL, credentials_quarantine_reason=NULL
WHERE id='<id>' AND organization_id='<org>';`. If many rows quarantine at once, suspect
key-ring configuration (`GET /health`), not the rows, and stop: that is a Sev 1.

## Readiness endpoint

`GET /health/ready` is public and returns booleans only:
`{"ok":false,"checks":{"config":true,"d1":false,"queue":true}}`, `503` if any is false,
`Cache-Control: no-store`. `config` is the same check as `/health` (without the names), `d1` is a
`SELECT 1` with a 3 second bound, `queue` is a presence check of the `DELIVERY_QUEUE` binding. It
sends no queue message and makes no outbound call. Reading it:

| `config` | `d1` | `queue` | Meaning and first action |
| --- | --- | --- | --- |
| false | any | any | A required binding is wrong. `GET /health` says whether it is `config_invalid` or `kek_environment_mismatch`; the operator readiness view and the log name the binding. What that stops depends on the binding (see "What a configuration fault stops"). Fix the deploy. |
| true | false | true | D1 is unreachable or too slow. `/health` still says 200 (it does not touch D1). Check Cloudflare status and `wrangler tail` for `ready_d1_failed` and `d1_write_shed`. Ingress answers 5xx; see "After an ingress outage". |
| true | true | false | The queue binding is missing from the deployment. Re-deploy with `wrangler.jsonc` intact. |

The answer is cached for 5 seconds in each isolate, so a probe loop does not turn into D1 load, and a
change shows up within that time. Warnings (a malformed optional `ENCRYPTION_KEY` or
`FINGERPRINT_KEY`, a second KEK without a check value, a GitHub App binding still a placeholder) are
shown only in the operator readiness view and the log: they stop one job or one feature, not the Worker.

## Operator readiness view

`GET /api/observability/readiness` (signed in; the user id must be on the secret `PLATFORM_OPERATOR_USER_IDS`,
otherwise `404`, and `404` for everyone while it is unset) returns the failing binding **names** per tier,
never a value:

```json
{"ok":false,"checks":{"config":false,"d1":true,"queue":true},"code":"config_invalid",
 "misconfigured":{"storage":[],"credentials":["KEK_V1"],"queue":[],"auth":[]},
 "warnings":["GITHUB_APP_ID"],"unknownKeys":["KEK_V_1"]}
```

`unknownKeys` are names in the Worker's environment that it does not read: almost always a typo in a
secret or var (also logged once per isolate as `config_unknown_keys`, field `unknown_bindings`).
`warnings` includes the five GitHub App bindings while any is a placeholder: the GitHub routes answer 503
on their own until they are real. This route is a `/api` route, so an `auth` fault (`APP_ORIGIN` or
`BETTER_AUTH_SECRET`) answers 503 here too; for that one read the log line.

## What a configuration fault stops

| Fault | Stops | Keeps working |
| --- | --- | --- |
| `DB` missing | every request except `/health` and `/health/ready`, the queue consumer, `scheduled` | the dashboard shell and assets |
| Key ring invalid, `ENVIRONMENT_NAME` wrong, `KEK_CHECK_V<n>` missing/malformed, or a KEK that does not match (`kek_environment_mismatch`) | creating or editing integrations and sources, rotating a source secret, test sends (503); the delivery consumer; `scheduled` | **webhook ingress**, sign-in, every read, delete and revoke |
| `APP_ORIGIN` not an https origin (a local development host may be http), or `BETTER_AUTH_SECRET` under 32 characters, copied from an example or repetitive | every `/api` and `/github` request (503, `Retry-After: 30`): no session can be verified | **webhook ingress**, the queue consumer, `scheduled` |

For an `auth` fault `GET /health` and `GET /health/ready` answer **503** (config is part of both) while webhook ingress and
delivery still work. A monitor that pages on `/health` will page although events are still being accepted and delivered: treat
`503` with `code: config_invalid` as "the dashboard and API are down", check `GET /webhooks/...` ingress and the delivery
backlog (step 3 of "What to check first") before declaring an outage, and read the failing binding in the log. A monitor that
must follow ingress should probe a webhook route (a signed no-op) instead of `/health`.
| `DELIVERY_QUEUE` missing | `scheduled` (dispatch) | everything else; ingress still persists to the outbox |
| `ENCRYPTION_KEY` or `FINGERPRINT_KEY` malformed; a GitHub App binding a placeholder | only the v0 migration step / fingerprints / the GitHub install flow and webhook | everything else |

Ingress is deliberately not gated on the key ring: it never opens a destination credential, and a
refused webhook can be lost for good (GitHub does not redeliver automatically; GitLab disables a hook
after repeated failures).

While the delivery consumer is gated, **each message** is retried on its own growing delay (5, 10, 20,
40, 80 minutes, about 2.6 hours across the queue's five retries) and nothing is acknowledged. This
postpones; it does not make loss impossible:

- An outage longer than about 2.6 hours moves messages to `noti-dead-letters`. The dead-letter consumer
  is never gated and marks those deliveries `dead_lettered`. The every-minute reconciler does **not**
  recover them: it only re-dispatches outbox rows that are `pending` or whose claim expired, and these
  rows are already `dispatched`. Replay them from the delivery log (admin, one at a time; a bulk replay
  is not built, REMAINING 1.7), or by `POST /api/deliveries/:id/replay`.
- If the dead-letter consumer could not run either, the platform deletes dead-letter messages after 4
  days and the deliveries stay non-terminal. Find them:

  ```sql
  SELECT d.id, d.organization_id, d.state, d.created_at
  FROM deliveries d JOIN notification_outbox o ON o.id = d.id
  WHERE d.state IN ('pending','retrying','claimed') AND o.state = 'dispatched'
    AND d.created_at < datetime('now','-4 hours') ORDER BY d.created_at LIMIT 100;
  ```

  There is no supported way to re-dispatch these in bulk; treat the list as the work queue for manual
  replay and tell the affected workspaces.

## After an ingress outage

If `DB` was missing (or D1 down) while webhooks arrived, the senders got 5xx. GitHub will **not** retry
those on its own: redeliver them by hand (see "Missed GitHub webhooks"). A GitLab hook that failed
repeatedly may have been disabled by GitLab: re-enable it in the project's webhook settings. A signed
generic sender usually retries; an unsigned-retry sender may not. Redelivery is safe because ingress is
idempotent on the provider's delivery id.

A webhook whose first attempt committed but whose response was lost (a connection dropped after the D1
write) is retried once by the Worker (`withD1Retry`). That retry reports `{"accepted":true,
"persisted":0,"duplicate":true}` and the event is dispatched by the every-minute reconciler, up to a
minute later, rather than immediately. This is expected, not an error.

## After a deploy

`npm run deploy` runs `scripts/predeploy-check.mjs` first (it refuses to deploy while a `REPLACE_WITH_`
placeholder remains in a required var, and warns about the optional GitHub App ones) and
`scripts/smoke-health.mjs` last, which asks the new deployment for `/health` and `/health/ready`. If
the smoke check fails it exits non-zero and prints the rollback instruction: run `wrangler rollback`
(**UNVERIFIED** for this account), then read `/health` for the binding names and fix them before
deploying again. Run the smoke check by hand any time: `npm run smoke` (or `node scripts/smoke-health.mjs
https://<origin>`).

## After a restore: end every session

Better Auth stores the session token as is (AR-1). A D1 Time Travel or backup restore can therefore bring back a
`session` row for a session the person ended, or one a password reset ended, and that row works again. Treat every
restore as a session-bearing event (spec 15 F234, mitigation 6):

1. Put the Worker in maintenance mode (`MAINTENANCE_MODE=true`, redeploy) so no session is created between the count and the
   delete.
2. Plan: `node scripts/revoke-all-sessions.mjs --database lumi-noti --remote --reason restore` (prints how many sessions
   and one-time records it would clear; changes nothing).
3. Apply: the same command with `--apply --i-froze-writes` (the second flag is you stating that step 1 is done; without it the
   script refuses). The count is read before the delete and the statements are not one transaction, so it can be stale under traffic. It deletes every `session` row and every `verification` row (so a restored,
   already-used reset link is dead too) and writes one `session.revoke_all` audit event with the count and the reason.
   Everyone signs in again. Use `--reason incident` for a suspected leak of the session table.
4. Leave maintenance mode. Then re-run the tenant-isolation drill (below).

`tests/security/revoke-all-sessions.test.ts` shows a restored row working again and the script ending it, over the Node
SQLite stand-in. `wrangler d1 execute --file` has never been run by this script against a real D1 (**UNVERIFIED**,
`docs/RELEASE_GATES.md`). A session also ends by itself: 30 days after its last use, and 90 days after sign-in at the latest
(`overAgeSessions` in the hourly `expired_auth_purge`, ADR 0030).

## KEK check value and environment mismatch

Each environment carries `ENVIRONMENT_NAME` (`production`, `staging` or `development`) and, for
every KEK it holds, a public **check value** var: `KEK_CHECK_V1` (`KEK_CHECK_V2` while rotating).
The check value is the first 32 hex characters of `HKDF-SHA-256(ikm = KEK, salt = empty, info =
"lumi-noti/kcv/v2:" + ENVIRONMENT_NAME)`. It is one-way and public; the KEK is not. A Worker whose KEK does not produce
its environment's check value refuses to serve (`kek_environment_mismatch`).

Compute it where the KEK is generated, with the KEK in the process environment, never as an
argument (it would land in shell history):

```sh
KEK_HEX=$(openssl rand -hex 32)
printf '%s' "$KEK_HEX" | wrangler secret put KEK_V1            # production
KEK_HEX="$KEK_HEX" node scripts/kek-destroy-check.mjs check-value --environment production
# -> 32 hex characters: set "KEK_CHECK_V1" in wrangler.jsonc, deploy
unset KEK_HEX
```

A staging deployment uses `--environment staging` and its **own** KEK, so its check value differs
even if someone copies the KEK across. Outside `development` at least one KEK must carry a valid check
value, and a malformed or mismatching one is a fault naming `KEK_CHECK_V<n>` (what it stops: "What a
configuration fault stops"). A second KEK without a check value is only a warning, so a rotation can
add the two in either order; `development` is accepted only with a local `APP_ORIGIN`
(`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`).

When `/health` says `kek_environment_mismatch`: do not "fix" it by editing the check value to match.
Find out which KEK is loaded: the wrong environment's secret, a stale `KEK_V1` after a rotation, or
a typo. A wrong KEK that is accepted seals new credentials under a key nothing else can open.

## Destroying a KEK version

Irreversible, and only after the rewrap job is at zero (docs/IMPLEMENTATION.md, "Key rotation").
The script refuses while any row still depends on the version; it looks at the `kek_version`
column **and** at the version inside each wrapped key, and counts quarantined and revoked rows too.

```sh
# 1. Read-only: exits 1 and prints the counts while rows remain.
node scripts/kek-destroy-check.mjs destroy-check --version 1 --active 2 --remote
# 2. Check and record in ONE statement: the key.destroy audit event exists only if no row
#    remained at that instant. It records that destruction is AUTHORISED; it does not delete anything.
#    --active must be the KMS_ACTIVE_VERSION actually DEPLOYED: read it from the deployed
#    configuration, do not guess; the script cannot read it and refuses only a value equal to --version.
node scripts/kek-destroy-check.mjs record-destruction --version 1 --active 2 \
  --actor "<your login>" --reason retired --remote     # retired | compromised | other
# 3. Only now: wrangler secret delete KEK_V1, then remove KEK_CHECK_V1 and deploy.
```

`--remote` runs against the production D1 through `wrangler d1 execute`; without it the local
database is used. The event is `key.destroy` with `subject_type='key'`, `subject_id='kek_v1'`, no
workspace, and metadata `{kekVersion, reason, activeVersion}`. It is exempt from the audit retention
purge, so it outlives `AUDIT_RETENTION_DAYS`:

```sql
SELECT created_at, actor_id, subject_id, metadata_json FROM audit_events WHERE action='key.destroy';
```

Step 3 is not atomic with step 2; the script cannot delete a Worker secret. If rows reappear between
them (a restore, a rollback of the rewrap), stop and rerun step 1.

The KEK itself is still a Worker secret (storage tier 2). Moving it to a Secrets Store binding was assessed in
ADR 0036 and not done: the binding is asynchronous and the key ring is built synchronously at every entrypoint.

## Revoked credentials

A customer (admin) can declare a credential burned: the dashboard's `Revoke webhook URL`, or
`POST /api/integrations/:id/revoke-credentials` / `POST /api/sources/:id/revoke-credentials` (docs/API.md). The order is
fixed (ADR 0036): **revoke** (an integration is quarantined with the reason `revoked`; a source is switched off with
`credentials_revoked_at` set; both stop at once), **drain** (no delivery of the integration is `claimed` with a claim
younger than 5 minutes; a source waits 60 seconds), **destroy** (one statement wipes the wrapped key and every ciphertext
column), **audit** (`integration.key_destroyed` / `source.key_destroyed`, written in the same batch, so it exists exactly
when the wipe did). An integration is usually destroyed inside the revoke request; anything deferred is finished by the
`credential_maintenance` cron (25 per table per tick) and by a repeated revoke call. Messages for a revoked integration
that were already queued end `dead_lettered` with `destination_revoked` (diagnostic `credentials_revoked`) and are never decrypted.

```sql
-- Revoked, and whether the key has been destroyed yet (a row with all-NULL key columns is destroyed):
SELECT id, organization_id, destination, credentials_quarantined_at,
       (dek_wrapped IS NULL AND webhook_envelope IS NULL AND webhook_ciphertext = '') AS key_destroyed
FROM integrations WHERE credentials_quarantine_reason='revoked';
SELECT id, organization_id, kind, credentials_revoked_at, length(dek_wrapped) = 0 AS key_destroyed
FROM sources WHERE credentials_revoked_at IS NOT NULL;
-- The audit trail, per connection (the revoke event has the actor and reason; the destroy event the key version):
SELECT created_at, action, actor_id, subject_id, metadata_json FROM audit_events
WHERE action IN ('integration.credentials.revoke','integration.key_destroyed','source.credentials.revoke','source.key_destroyed')
ORDER BY created_at DESC LIMIT 50;
```

The `credential_maintenance` log line carries `destroyed` and `remaining.revokedKeysRemaining`; the latter should be 0 a
few minutes after the last revoke. A value that does not fall means a live delivery claim that never ends (look at
`SELECT * FROM deliveries WHERE state='claimed' ORDER BY claimed_at LIMIT 20;` and the stale-claim sweep) or a failing
cron (`credential_maintenance` in `job_runs`). The destroy is irreversible: the sealed secret cannot be recovered even by
whoever holds the KEK. A destroyed connection keeps its non-secret fingerprint.

Do **not** clear a revoke by hand the way a quarantine can be cleared: the customer said the secret is burned. Through
the API, clearing needs a **new** secret: an admin (`integration.revoke`) enters a different webhook URL (a member who can
edit gets 403), and a revoked provider source refuses the same pasted credential on `rotate`. After the key is destroyed
the "same value again" check compares the fingerprint, which exists only when `FINGERPRINT_KEY` is set: **set
`FINGERPRINT_KEY` in every environment** (64 hex characters): without it a revoked secret is NOT destroyed (it stays sealed
but unusable, `revokedKeysRemaining` stays above zero, `/api/observability/readiness` warns `FINGERPRINT_KEY`), because the
destroy would otherwise let the burned value be pasted back unnoticed. With a key, the revoke (or the next cron tick) computes
a missing fingerprint while the secret can still be opened, then destroys it. **Do not rotate `FINGERPRINT_KEY`
casually**: every stored fingerprint stops matching, so a destroyed connection's burned value is no longer recognised.
Rows revoked before ADR 0036 hold their key until the next cron tick after the deploy.

**A revoked secret that is never wiped.** If `/api/observability/readiness` shows `revoked_secrets_not_wiped` (or the
`credential_maintenance` log has `keys_awaiting_fingerprint` above zero), a revoked connection holds a secret the Worker cannot give a
fingerprint: it was sealed before fingerprints existed and cannot be opened now (lost key, corrupt envelope, no
`ENCRYPTION_KEY`). First fix the cause if it is a missing binding (the next tick backfills and destroys it). If it cannot be
opened, wipe it yourself, after confirming with the customer that the old value is burned and cannot be recognised afterwards:

```sh
node scripts/force-destroy-revoked.mjs --integration <id> --organization <orgId> --actor "<your login>" --remote          # dry run
node scripts/force-destroy-revoked.mjs --integration <id> --organization <orgId> --actor "<your login>" --remote --apply
# a source: --source <id> (after its 60 second drain window)
```

It refuses a connection that is not revoked or is in another workspace, waits for a live delivery claim (rerun later), also wipes the
`integrations_old` copy, and writes `*.key_destroyed` with `trigger: operator`, `reason: destroyed_without_fingerprint`. Deleting
an integration also removes its `integrations_old` row. UNVERIFIED on a real D1: it assumes `wrangler d1 execute --command` runs
its statements in order; each is idempotent, so a partial run is repaired by running it again.

**What "destroyed" means.** Gone from the live database and, while migration 0026 has not been finalized, from
`integrations_old` (wiped in the same batch; the sweep also wipes a kept copy that reappears). Not gone from D1 Time Travel,
which keeps point-in-time history for up to 30 days (AR-6): a secret revoked today can be read from a restore for up to 30
days. If `migration-0026-recover.mjs` restores the kept original, it re-quarantines the integrations that were revoked since
the swap and wipes their secrets again (a scratch table `_recover_revoked`, kept if the run is interrupted).
`kek-destroy-check.mjs` counts `integrations_old` while it exists, so a KEK version still used there is not destroyable.
The destroy runs first in `credential_maintenance` and per row, so a bad KEK or a failing migration batch does not
delay it; the migration and rewrap still fail the cron afterwards.

## KEK rotation (pointer)

The full, ordered procedure with a rollback at every step is **docs/IMPLEMENTATION.md, "Key
rotation (KEK)"**. Verification queries from it:

```sql
SELECT COUNT(*) FROM integrations WHERE kek_version=1;
SELECT id, credentials_quarantine_reason FROM integrations WHERE credentials_quarantined_at IS NOT NULL;
```

Do not `wrangler secret delete KEK_V1` until the first returns 0 and the second returns no
rows, and use `scripts/kek-destroy-check.mjs` ("Destroying a KEK version") rather than reading the
query by eye. Deploy `KEK_CHECK_V2` together with `KEK_V2`. The `credential_maintenance` log line reports `remaining` per tick. Rotation has not
been rehearsed (docs/RELEASE_GATES.md).

## Generic source: edge rate rule

`POST /webhooks/generic/<endpointId>` is public and unauthenticated until its signature
verifies. Before that point a request costs one indexed D1 read and one HMAC over up to
256 KiB; the per-source limiter (600 verified events a minute) cannot help, by design (it runs
after verification so strangers cannot burn a source's budget). **Configure a Cloudflare rate
limiting rule on the zone** (dashboard: Security, WAF, Rate limiting rules), because the
Worker cannot do this itself:

- Match: URI path starts with `/webhooks/generic/` and method is `POST`.
- Characteristics: IP address. Threshold: start at 300 requests per 10 seconds per IP (a busy
  legitimate sender behind one NAT is well under this; tune from `wrangler tail`).
- Action: block for 60 seconds (or managed challenge is NOT suitable: senders are machines).
- Optional: also cap request body size at 256 KiB at the edge for the same path; the Worker
  already refuses more than that, but the edge refuses first.

Verify after configuring: send 400 unsigned requests from one IP in 10 seconds and expect `429`
from the edge (not from the Worker; the Worker never returns 429 before verification). This rule
has not been created or rehearsed yet (UNVERIFIED); until it is, AR-18 in docs/THREAT_MODEL.md
is an open exposure, not an accepted one.

A sender that is being refused `409 webhook_id_reused` shows a counter on its card on the
Sources page and `generic_webhook_id_reused` warnings in the logs (source id only, never the
id or body). The fix is on the sender: every event needs its own `webhook-id`.

## Missed GitHub webhooks

GitHub is not known to retry failed deliveries automatically (**UNVERIFIED**). If ingress was down or rejected
events, use the GitHub App's settings page, "Advanced", "Recent Deliveries", and redeliver
the failed ones (UI path from GitHub's own documentation; **UNVERIFIED** here, and the
REST API for listing and redelivering App webhook deliveries was not checked).

Safe because of dedup: the delivery id is derived from the GitHub delivery id and the
integration (`src/delivery/ids.ts`), and ingress writes with `INSERT OR IGNORE`
(`src/connectors/sources/github/route.ts`). A redelivered event that was already accepted does
nothing; one that never reached D1 is processed. Therefore redelivery cannot duplicate an
accepted notification, but **it also cannot resend one that was accepted and then failed**:
that needs replay (above).

How to tell which window was missed: there is no ingress counter (spec 13 `acceptance_rate`
is not measurable). Use the gap between the last `deliveries.created_at` for the workspace and
GitHub's Recent Deliveries list:

```sql
SELECT MAX(created_at) FROM deliveries WHERE organization_id='<org>';
```

## Retention and storage

`purgeExpiredRecords` is attempted every cron tick but runs at most once an hour
(`ops_state` key `last_retention_at`; it is only advanced after a complete pass, so a backlog
continues on the next tick). Each pass is bounded to 5 rounds of 500 rows per table. Vars in wrangler.jsonc: `DELIVERY_RETENTION_DAYS` (30-365, default 90),
`AUDIT_RETENTION_DAYS` (30-3650, default 365). Every store, its period and its job is
listed in docs/DATA_RETENTION.md (generated; `npm run docs:retention`). Expired sessions,
verification records, install states and Better Auth rate-limit rows are removed hourly by
`expired_auth_purge` (log line `expired_auth_records_purged`). Invalid values fall back to the default and log a `retention_config_invalid` warn (variable name only) every tick.
It deletes only terminal delivery rows; a dead-lettered row is kept until its failure is also
older than the cutoff. The `retention_purge` log line carries `more: true` while it is still
catching up. If it never reaches `more: false`, volume exceeds the per-tick bound: raise the
issue, do not run unbounded deletes by hand. D1 Time Travel can restore deleted rows for a
period (restore commands and window **UNVERIFIED**); do not describe purges as erasure.

## Rolling back

Code: `wrangler rollback` restores a previous Worker version (**UNVERIFIED** for this
account/config; it does not touch D1 or secrets). Migrations are applied separately with
`wrangler d1 migrations apply lumi-noti --remote` and **are not automatically reversible**.
What the files themselves say:

| Migration | Rolling the Worker back past it | Reversible? |
| --- | --- | --- |
| 0007 envelope encryption | v0 columns are kept (ADR 0004). It also stripped legacy ciphertext from outbox payloads | The outbox stripping is not reversible |
| 0009 delivery reliability | Old Worker still works: `failed` stays accepted and reads as `dead_lettered` | Expand-only; the table rebuild copied every row. Dropping the new columns is a later contract step |
| 0011 workspace deletion | Triggers recreated with a purge exemption | Do not run a purge with the old triggers in place |
| 0012 Teams destination | Old Worker cannot deliver `teams` rows | Disable Teams integrations first. Restoring the old CHECK is another rebuild after deleting or retargeting `teams` rows |
| 0014 rate-limit index | Harmless | `DROP INDEX api_rate_limits_window` |
| 0021 noise control | Old Worker ignores the column and both tables, but it **stops releasing**: rows in `held`/`claimed` wait until a Worker that knows about them runs again (nothing is lost). Turn noise settings off and let `held_events` drain before rolling back if updates must not be delayed | `DROP TABLE held_events; DROP TABLE noise_open_failures;` is safe only once nothing is waiting; the column stays (dropping it needs a rebuild) |
| 0024 credential lifecycle | Old Worker ignores the three columns. **Apply before** the new Worker (its queries name them). A rollback past the Worker leaves revoked integrations quarantined (still stopped) but a revoked **source** is only `enabled=0`, which the old Worker also honours; it would let someone re-enable it | Expand-only: the columns stay (dropping them needs `ALTER TABLE ... DROP COLUMN`, SQLite 3.35+) |
| 0025 delivery ledger depth | Old Worker ignores the four new `deliveries` columns and the tables `event_dedup`, `delivery_attempts`, `destination_health`: it stops recording attempts and suppressed repeats and stops honouring the breaker and pacing, nothing else. Waiting deliveries (`last_error` `circuit_open` or `destination_paced`) are retried by their next scheduled time | Expand-only. `DROP TABLE` the three tables is safe; the columns stay (dropping them needs a rebuild) |
| 0026 tenant contract | The previous Worker keeps working: the new schema is stricter than it needs and it never writes a NULL organization. Rows the migration could not attribute to a tenant leave the live tables (metadata in `legacy_orphaned_rows`) but stay whole in `<table>_old` until finalize | Until finalize: `scripts/migration-0026-recover.mjs` restores the originals and their indexes and triggers (valid until traffic has resumed on the new tables). After finalize: **not reversible by SQL**; a D1 Time Travel restore to the bookmark taken before applying is the only undo (procedure **UNVERIFIED**) |
| 0028 ingress usage and audit read | Old Worker ignores the `ingress_usage` table and `audit_events.correlation_id`; it stops counting usage and stops stamping request ids on audit rows, nothing else. **Apply before** the new Worker (its queries name them) | Expand-only: `DROP TABLE ingress_usage; DROP INDEX audit_events_org_correlation; DROP INDEX audit_events_org_actor; DROP INDEX audit_events_org_target;` is safe; the column stays (`ALTER TABLE audit_events DROP COLUMN correlation_id`, SQLite 3.35+) |
| 0016 observability | Old Worker ignores `ops_state` and the two indexes | `DROP TABLE ops_state; DROP INDEX deliveries_state_created; DROP INDEX audit_events_created;` |

A rollback rehearsal has **not** been performed (docs/RELEASE_GATES.md). A restore from D1
Time Travel is the only recovery from a destructive mistake; its procedure is **UNVERIFIED**.

## Data-subject requests (operator procedure)

Prefer the product: `GET /api/workspace/me/data-export` and `DELETE /api/workspace/me` (docs/DSAR.md),
because identity is already established. Use this procedure only when the person cannot use them
(for example they cannot sign in). It is **written, never rehearsed**, and every write is a
break-glass action to be named in the incident record. Legal deadlines and the decision whether to
act are the operator's (docs/DSAR.md).

1. **Verify identity first.** An emailed request is not enough: confirm control of the account
   email (a verification link to the address on file) before disclosing or deleting anything.
2. **Access.** Read, select ids and counts, never credentials:
   `SELECT id,name,email,created_at FROM "user" WHERE email='<email>';` then the same joins the
   export uses (`src/api/account.ts`): `member`, `session` (omit `token`), `passkey` (omit keys),
   `audit_events WHERE actor_id='<id>'` (omit `subject_id`, `metadata_json`). Never copy the
   `token`, `password`, `public_key` or `credential_id` columns.
3. **Erasure.** First check the person is not the only admin of a workspace:
   `SELECT organization_id FROM member m WHERE user_id='<id>' AND role='admin' AND NOT EXISTS (SELECT 1 FROM member a WHERE a.organization_id=m.organization_id AND a.role='admin' AND a.user_id<>m.user_id);`
   Any row means: stop. Another admin must be made first, or the workspace deleted through its own
   deletion flow. **Never delete a workspace's data because one member asked**, and never touch a
   workspace that has other members. If clear, run in one `wrangler d1 execute` batch:
   `DELETE FROM github_auth_states WHERE user_id='<id>'; DELETE FROM invitation WHERE lower(email)=lower('<email>'); DELETE FROM "user" WHERE id='<id>';`
   (the last cascades sessions, accounts, passkeys, memberships and invitations they sent, **including
   pending ones other people are waiting on**: first reassign them with the `UPDATE invitation SET inviter_id=...`
   statement in `src/api/account.ts`, or the invitee loses the invitation). A database trigger aborts the
   delete if it would leave a workspace without an admin. Accounts whose email was never verified cannot use
   the product route and are only removable this way.
4. **Say what is not erased**: audit rows keep the actor id, IP address and user agent until
   `AUDIT_RETENTION_DAYS` (AR-40); D1 Time Travel keeps history for a period set by Cloudflare
   (AR-6); destination providers keep what they received (docs/SUBPROCESSORS.md).
5. Record the request, the identity check, what was done and the date. There is no request log in
   the product yet.

## security.txt

`/.well-known/security.txt` is generated by the Worker on every request (`src/web/security-txt.ts`) with
`Expires` 90 days ahead, so there is nothing to renew. Check on each release that the Contact URL still
opens a private advisory form and that private vulnerability reporting is enabled for the repository (not
verified from here).
## Adding a migration

1. Create `migrations/NNNN_snake_case.sql` with NNNN one above the highest on `origin/main` (rebase first; a number at or
   below it fails the base check). Keep every compound SELECT to 4 terms and never touch an `_old` table.
2. `npm run migrations:seal` writes `migrations/NNNN_snake_case.sql.sha256`. Commit both. Never edit either afterwards: a
   correction is a new migration. If you change the SQL before it merges, delete its sidecar and seal again.
3. `npm run migrations:check` (and, to see what CI will see, `node scripts/migration-seal.mjs --check --base origin/main`).
4. If a parallel PR merged a migration with the same number, renumber yours (rename both files, delete the sidecar, seal).
   Remember the gate only blocks a merge once branch protection requires CI (RELEASE_GATES 1b).

## Applying migration 0026 (tenant contract)

`migrations/0026_tenant_contract.sql` rebuilds six tables to add `organization_id NOT NULL` plus a
foreign key (ADR 0021). **It has never been applied to a real D1** (no staging environment). This is
a blocking release item (`docs/RELEASE_GATES.md`): rehearse it on staging first.

What Cloudflare documents, and what it does not (checked 2026-10-14):

- Documented: a query may run 30 seconds, and that limit "also applies to the entire batch call"; a
  statement may be 100 KB; a single statement that modifies "hundreds of thousands of rows" exceeds
  execution limits and large work should be broken into chunks of about 1,000 rows
  (<https://developers.cloudflare.com/d1/platform/limits/>). The migrations page mentions
  `PRAGMA defer_foreign_keys = true` for changes that would violate foreign keys
  (<https://developers.cloudflare.com/d1/reference/migrations/>).
- **Not stated** (so **UNVERIFIED**): whether a migration file runs in a transaction, whether a failed
  statement aborts the file or the runner carries on, any per-file statement limit.
- **Measured, not documented.** workerd's SQLite allows **at most 5 compound SELECT terms** (a sixth fails
  "too many terms in compound SELECT"; node:sqlite allows 500, so unit tests over it cannot see this). Every
  statement in migrations and scripts is held to 4 by a test, and
  `tests/migration-0026-d1.test.ts` runs the real `wrangler d1 migrations apply --local` (workerd) on the whole
  chain and on a seeded legacy database with zero row loss, then finalize and recover through
  `wrangler d1 execute --local`.

#### UNVERIFIED on a production (remote) D1 (rehearse before relying on any of it)

Local wrangler is workerd's SQLite, not the production D1 service. These are proven locally and **not**
on a remote database: `pragma_foreign_keys` / `pragma_legacy_alter_table` / `pragma_foreign_key_check` as
table-valued functions; the overflow trick (`CREATE TABLE ... AS SELECT CASE ... abs(-9223372036854775808)`
failing the statement without creating the table); `CREATE VIEW` over tables that do not exist yet, and
`ALTER TABLE ... RENAME` failing on it; `PRAGMA legacy_alter_table=OFF` being accepted as the first statement
of a migration (and that default for the remote connection); `foreign_keys` being on; a file's
transaction/abort behaviour; INTERSECT over wide rows and blobs inside the 30 second limit at the 100,000
row ceiling; `wrangler queues pause-delivery` semantics.

**Mandatory before production: rehearse on a throwaway REMOTE D1** (`wrangler d1 create lumi-noti-rehearsal`,
never the production database): load a copy of production-shaped legacy rows, run the preflight, apply 0026,
confirm each item above by observation, run finalize (check, then `--apply`), then repeat from a fresh copy
and force a failure (drop one `_old` table half way, or edit a copy of the file to fail the verify), run
recover, and record the results in `docs/RELEASE_GATES.md`. Delete the rehearsal database afterwards.

### What the file does, and what it cannot do

**It never destroys an original.** It has no `DROP`, `DELETE` or `TRUNCATE` of any of the six tables or
of `<table>_old` (a test scans for that). Each original is renamed aside to `<table>_old`, the verified
copy takes its name, and **the `_old` tables stay until you run the finalize step below.** Whatever the
runner does (rolls back, aborts, or carries on after an error), whatever the pragmas, and however many
times it is re-run, the original rows are in the live table or in `<table>_old`.

It also refuses to run in a state it does not understand. Tripwires at the top fail the file with a
named constraint: `foreign_keys_must_be_on`, `legacy_alter_table_must_be_off`,
`old_tables_from_an_earlier_run_must_be_finalized_or_restored_first`, `all_six_tenant_tables_must_exist`.
A runner that carries on after the error is stopped from doing harm by two gate tables (created only when
nothing tripped) that every data statement depends on, and by a view that makes every `ALTER TABLE ...
RENAME` fail until both gates exist. The very first statement is `PRAGMA legacy_alter_table=OFF` (the sqlite3
shell defaults to ON, which skips the view check and let a carrying-on runner swap EMPTY copies in); the
tripwire then verifies it took effect. A runner that ignores pragmas still stops at the tripwire (aborting
runners) or, if it carries on and has legacy ON, may swap empty copies with the originals whole in
`<table>_old`: run recover.

### Procedure (maintenance window; every step is mandatory)

1. **Preflight, read-only.** Reports everything the migration will quarantine (derived exactly as the
   migration derives it: a tenant derived to an id that is not an organization still counts), ids that
   differ only by case, cross-tenant anomalies, row counts, `foreign_keys` off, and leftover `_old` tables:

   ```
   wrangler d1 execute lumi-noti --remote --json --file scripts/migration-0026-preflight.sql > preflight.json
   node scripts/migration-0026-preflight.mjs preflight.json
   ```

   It exits 1 until every quarantined row is acknowledged by exact count (`--ack-orphans <N>`): those
   rows leave the live tables (they stay in `<table>_old` until finalize, then only in Time Travel). It also
   refuses any table above 100,000 rows (the ceiling: one `INSERT ... SELECT` per table must finish inside 30
   seconds); purge deliveries by retention first or use the chunked backfill below. A delivery whose
   organization differs from its integration's, an integration whose organization differs from its
   source's, and deliveries of a quarantined integration are **kept**; review each.
2. **Bookmark.** `wrangler d1 time-travel info lumi-noti`; write the bookmark down. Procedure
   **UNVERIFIED**; it is the undo of last resort and the only one after finalize.
3. **Freeze every writer, in this order.**
   1. **Pause queue delivery first:** `wrangler queues pause-delivery noti-deliveries` and
      `wrangler queues pause-delivery noti-dead-letters` (command names from the Cloudflare Queues wrangler
      reference; what a paused queue does to in-flight batches and to message age is **UNVERIFIED**; resume
      with `resume-delivery`). Pausing is the real freeze. `MAINTENANCE_MODE` alone is not: its queue
      handling is `retryAll({ delaySeconds: 300 })`, and `retryAll` **consumes a retry**. The main queue has
      `max_retries: 5`, so a message gets six deliveries; in maintenance it is handed back at 0, 5, 10, 15,
      20 and 25 minutes and then moves to the dead-letter queue. A fresh message therefore survives a window of
      **under 25 minutes**, and a message already part-way through its retries (a delivery that was retrying
      before the freeze) survives **less than 5 minutes**. Dead-lettered deliveries are marked
      `dead_lettered` and can be replayed (docs/RUNBOOK.md, replay), so this is recoverable but noisy.
      The dead-letter queue consumer is never gated by `MAINTENANCE_MODE` (its queue has `max_retries: 1`,
      so handing its message back would drop it before the ledger row is marked); pausing
      `noti-dead-letters` is what keeps it from writing to `deliveries` during the window.
   2. Deploy with `MAINTENANCE_MODE=true` (`wrangler deploy --var MAINTENANCE_MODE:true`). Every route
      except `/health` and `/health/ready` answers 503 with `Retry-After: 300` (providers retry; none are
      told the event was accepted) and cron jobs do nothing. Confirm: a webhook POST returns 503 and the
      cron log shows `maintenance_mode_cron_skipped`. Pause the cron trigger in the dashboard if you do not
      trust a single flag. Wait one minute for in-flight requests to drain.
   Keep the whole window **under 60 minutes**: Queues retention is configurable up to 14 days on Workers
   Paid and fixed at 24 hours on Free; the default on Paid is not stated (UNVERIFIED), so do not rely on more.
4. **Final recount.** Re-run step 1 immediately before applying; the counts must be the same.
5. **Apply.** `wrangler d1 migrations apply lumi-noti --remote`.
6. **Verify before unfreezing** (all must hold):

   ```sql
   -- the foreign key is in place on all six tables (expect 6 rows, each with fk = 1). One query: workerd's
   -- SQLite allows at most 5 compound SELECT terms, so no six-way UNION here.
   SELECT m.name, COUNT(*) AS fk FROM sqlite_master m, pragma_foreign_key_list(m.name) f
     WHERE m.type='table' AND f."from"='organization_id' AND f."table"='organization'
       AND m.name IN ('integrations','deliveries','notification_outbox','held_events','routing_decisions','noise_open_failures')
     GROUP BY m.name;
   -- scratch left over (expect 0 rows): a leftover here means a step failed. The six `_old` tables are EXPECTED.
   SELECT name FROM sqlite_master WHERE name LIKE '%\_v4' ESCAPE '\' OR name LIKE '\_guard%' ESCAPE '\'
     OR name LIKE '\_contract%' ESCAPE '\' OR name LIKE '\_gate%' ESCAPE '\' OR name IN ('_swap_verify','_fk_required','_alter_mode','_old_absent','_live_present');
   -- no dangling foreign keys (expect 0 rows)
   PRAGMA foreign_key_check;
   -- what was removed from the live tables (it is in `<table>_old`)
   SELECT source_table, reason, COUNT(*) FROM legacy_orphaned_rows GROUP BY 1,2;
   ```

   `integrations` must have **5 named indexes and 4 triggers of its own** (`integrations_repo`,
   `_org_idx`, `_kek_version`, `_org_created`, `_source`; `integrations_org_required_insert`,
   `_org_immutable`, `_source_same_org`, `_source_immutable`) **plus the trigger on `sources`**
   (`sources_delete_integrations`):
   `SELECT name FROM sqlite_master WHERE tbl_name='integrations' OR name='sources_delete_integrations'`
   (10 rows, plus any autoindex). Send one test notification (`POST /api/integrations/:id/test`).
7. **Finalize, still frozen** (below). Doing it in the window is what makes the strict comparison possible.
8. **Unfreeze, in this order:** `MAINTENANCE_MODE=false`, then `wrangler queues resume-delivery
   noti-deliveries` and `noti-dead-letters`. Watch `/health/ready`, the delivery log and the cron heartbeat.
9. After review, `DROP TABLE legacy_orphaned_rows;` (no code reads it).

### Finalize: the only step that drops the originals

Take a Time Travel bookmark first (dropped rows include quarantined orphans whose credentials exist
nowhere else). Check only, then apply:

```
node scripts/migration-0026-finalize.mjs --database lumi-noti --remote
node scripts/migration-0026-finalize.mjs --database lumi-noti --remote --apply
```

It refuses, dropping nothing, unless per table (`scripts/migration-0026-finalize.sql`): kept rows equal
their originals in every column (a whole-row comparison, stronger than a hash sum), kept + quarantined =
original, nothing live that the original lacked, and `PRAGMA foreign_keys` is 1 with no violations (the
foreign key check is **database-wide**: a violation in any table blocks, on purpose). A live table that is
EMPTY while its original is not is never acceptable, whatever you acknowledge. It drops the six `<table>_old`, `_snapshot_0026` and any scratch. It is idempotent (nothing left: exit 0) and
refuses a half-present set of `_old` tables. If traffic has resumed, live rows legitimately differ:
read the `REVIEW` lines, which list the first 20 ids of each kind, then acknowledge them separately:
`--ack-drift <missing + live_only>` and `--ack-changed <changed>`. Changed is separate because a count never
shows a write to an existing row: during the freeze the dead-letter consumer (never gated, see above) or a
slipped writer can mark a delivery `dead_lettered`, and a migration that checks counts cannot see it; finalize
compares every column. Quarantine entries from an earlier cycle that no longer match an `_old` row are ignored;
one whose id is live blocks. **Do not leave the `_old` tables in place:**
they are in the retention matrix as TEMPORARY (drop within 7 days), a workspace purge clears its rows from
them, `/health/ready` carries the warning `migration_0026_old_tables_present` while they exist, and the
preflight blocks a new run over them.

### If it fails

Stay in maintenance mode. Do not hand-edit tables to "make the numbers match".

- **Tripwire fired** (`foreign_keys_must_be_on` and the others above): nothing was changed. Fix the cause
  (or finalize/recover for a leftover `_old`) and re-apply.
- **A leftover `_gate_0026_poison` view** (an aborted run can leave it; `/health/ready` then warns
  `migration_0026_gate_view_present`) makes EVERY later `ALTER TABLE ... RENAME` in this database fail, including
  other migrations'. Recover and finalize both drop it; `DROP VIEW IF EXISTS _gate_0026_poison` by hand is safe.
- **Anything else, or you cannot tell:** run the recovery script. It works from the database alone. It is
  tested from the database state after each of the file's statements has run (the process killed between any
  two), after a sabotaged copy, a late writer and a runner with `legacy_alter_table` on, on node:sqlite, and
  from a freshly migrated seeded database on workerd; it is **not** proven from every state a real D1 could
  leave. It drops the scratch objects, drops the live table if there is one and renames
  `<table>_old` back, then recreates every index and trigger verbatim from `_snapshot_0026`, triggers first
  (`sources_delete_integrations` is dropped before anything else, because a trigger that names a missing
  table makes the rename fail, and is recreated from the snapshot):

  ```
  node scripts/migration-0026-recover.mjs --database lumi-noti --remote           # plan
  node scripts/migration-0026-recover.mjs --database lumi-noti --remote --apply
  ```

  It refuses if a live table holds a row its `_old` does not (a write after the swap) unless you pass
  `--discard-live-changes`. Do it with writers still frozen (`MAINTENANCE_MODE`), then lift the freeze. If
  migration 0027 is already applied (`d1_migrations` lists it), recovery re-adds `correlation_id` (with its
  CHECK) to the restored `deliveries` and `notification_outbox` and recreates the two `deliveries` indexes,
  because the current Worker INSERTs that column; the plan prints a note when it does. After recovery EITHER
  Worker version works: the current one (0027 and later) finds its column, and a Worker from before 0027
  ignores it. Then re-run the migration, or stay on the restored schema. The same steps by hand, per table that has `<table>_old`: `DROP TRIGGER IF EXISTS
  sources_delete_integrations; DROP TABLE IF EXISTS <t>; ALTER TABLE <t>_old RENAME TO <t>;` then drop
  `_gate_0026_*`, `_gate_0026_poison`, `*_v4`, `_contract_verify`, `_swap_verify`, `_guard_*`, and recreate
  the indexes and triggers from `SELECT sql FROM _snapshot_0026`.
- After finalize the originals are gone: Time Travel restore to the step 2 bookmark is the only way back.

### Chunked backfill (large `deliveries` only)

The migration's own backfill and copy are single statements. If the preflight reports `deliveries`
near the ceiling, fill the tenant by hand in bounded rounds until it reports 0 changes, so the
migration's backfill matches nothing (the copy is still one statement, and the ceiling still applies):

```sql
UPDATE deliveries SET organization_id=(SELECT i.organization_id FROM integrations i
  WHERE i.id=deliveries.integration_id AND i.organization_id IS NOT NULL AND i.organization_id<>'')
WHERE rowid IN (SELECT rowid FROM deliveries WHERE organization_id IS NULL
  AND EXISTS (SELECT 1 FROM integrations i WHERE i.id=deliveries.integration_id
    AND i.organization_id IS NOT NULL AND i.organization_id<>'') LIMIT 1000);
```

## Tenant-isolation drill

Two runners share one attack plan (`scripts/lib/drill-plan.mjs`, built from
`src/auth/route-policy.ts`):

- **Fake D1, every build:** `tests/drill/tenant-isolation.test.ts` (part of `npm test`). It proves the
  application and the migrated schema. It does not exercise the deployed Worker, real D1 or real
  Better Auth sessions.
- **Staging, by hand: `scripts/tenant-isolation-drill.mjs`. UNVERIFIED: it has never been run.**

To run it once a staging environment exists (F233 evidence item 2):

1. Create two throwaway accounts you own, A and B, each with one workspace, one source, one
   integration bound to it (a Slack destination you control for B) and one delivery.
2. Sign in as A, copy the `Cookie` request header of any `/api` call. Write B's ids and unique
   markers (names, endpoint id, destination tail) into a JSON file outside the repository:
   `{ "orgId", "orgName", "integrationId", "sourceId", "deliveryId", "markers": [...] }`.
3. `DRILL_BASE_URL=https://<staging> DRILL_COOKIE='...' DRILL_VICTIM_FILE=./victim.json
   DRILL_ATTACKER_ROLE=admin node --experimental-strip-types scripts/tenant-isolation-drill.mjs`
   (read-only attacks). Add `DRILL_ALLOW_DESTRUCTIVE=1` for the writes: if isolation is broken they
   change B's staging data, which is why they are opt-in. Repeat as B against A, and once as a
   plain member of A (`DRILL_ATTACKER_ROLE=member`).
4. Success is exit code 0: every attempt a 404 (a 403 only where A's own role lacks the capability),
   nothing of B's in any response. The script prints attempts and counts, never cookies, bodies or
   identifiers. Then check B's audit log for the recorded probes (capped at 20 a minute per user,
   ADR 0019) and that B's Slack channel received nothing.
5. Re-run after a D1 Time Travel restore (F233 evidence item 4), then record the run in
   `docs/RELEASE_GATES.md`. A failure is an incident: stop the route, preserve logs, follow the
   steps in `docs/specs/15` F242.

## Incident record template

Copy per incident. Leave unknowns unknown.

```
Severity / start (UTC) / detected by:
Customer-visible effect (what a customer could observe):
Measured (queries run, with results):
Inferred (and from what):
Not known:
Actions taken (each break-glass write named):
Customer message sent (text, who, when):
Follow-ups filed (every gap this runbook papered over):
```

## Gaps this runbook does not close

- Nobody is paged. Alerts go to the log and, if configured, a chat webhook; no paging service, no acknowledgement, no escalation.
- A cron that has stopped entirely cannot report itself: `cron_heartbeat_missing` fires on the first tick after a gap, and nothing external watches for the silence.
- No support evidence bundle (F202); no job leases, cursors or `cpu_ms`; `alert_state` is not locked against two overlapping ticks (the worst case is one duplicate message with the same incident key).
- Alert thresholds are unmeasured starting values.
- No ingress counter, so a silent source cannot be detected (`ingress_gap`).
- Everything above is unrehearsed.
