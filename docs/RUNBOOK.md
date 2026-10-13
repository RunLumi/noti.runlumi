# Operations runbook

The availability and delivery-loss runbook (docs/specs/13-observability.md F201). Security
incidents are a different document: if you suspect credential exposure or cross-tenant
access, **stop and escalate** (SECURITY.md, spec 15 F242). Do not triage them here.

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
  find the log lines with the same `correlation_id`. It is not stored on rows or queue
  messages yet (spec 13 F193), so it finds request logs only, not a delivery.

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
| Security | Any suspicion of exposure | leaked URL in a log, cross-tenant read | Stop; escalate per SECURITY.md |

These tiers are this runbook's own judgement. No on-call rota or paging integration exists
(spec 13 F200 is not built), so today **nobody is paged**: detection is the `delivery_stall`
warn line, `GET /api/observability/summary` and a person looking.

## What to check first

1. `GET /health` on the Worker. 503 names the misconfigured binding (key ring) and nothing
   else; 200 only proves the Worker boots.
2. Is the cron running? `SELECT key, value, updated_at FROM ops_state;` and the latest
   `outbox_reconcile` log line. The cron is `* * * * *` (wrangler.jsonc). If neither moves,
   the Worker may not be deployed with its cron trigger or is failing every tick (check
   `wrangler tail`). A failed `scheduled()` throws, so a failing job shows as a failed
   invocation. There is no `job_runs` table yet (spec 13 F192 not built).
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
  `outbox_dispatch_incomplete` log line; `Queue.send()` failures leave the row for the next tick.
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

## Dead-letter inspection and redelivery

`dead_lettered` is terminal. A delivery reaches it when the retry budget is spent (13
attempts, src/delivery/retry.ts), on a permanent error, or when the queue's own retries run
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
(`replay_of` points at the original) and never mutates the original row. At the time of
writing, **no HTTP route exposes it** (the deliveries API is a parallel slice, docs/API.md).
Until it ships there is no operator-facing replay. Do not hand-insert rows. Replay needs the
original outbox message, so those rows are kept for as long as the delivery row is (src/pipeline/retention.ts).

The dead-letter **queue** itself: the Worker consumes it (`noti-dead-letters`, one message at
a time) only to mark the ledger. Browsing queue messages from the CLI is **UNVERIFIED**;
inspect the ledger instead.

Customer message: "Some notifications failed to send to <destination>. The cause is
<plain-language cause from the error code>. Fix the connection and tell us; we can resend
failed notifications once replay is available. A resent notification may duplicate one you
already received."

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
delivery older than 10 minutes (`CLAIM_STALL_MS`) means the 5-minute stale-claim sweep
(`sweepStaleClaims`) is not running. Depth alone is not the signal: thousands of messages that
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

## KEK rotation (pointer)

The full, ordered procedure with a rollback at every step is **docs/IMPLEMENTATION.md, "Key
rotation (KEK)"**. Verification queries from it:

```sql
SELECT COUNT(*) FROM integrations WHERE kek_version=1;
SELECT id, credentials_quarantine_reason FROM integrations WHERE credentials_quarantined_at IS NOT NULL;
```

Do not `wrangler secret delete KEK_V1` until the first returns 0 and the second returns no
rows. The `credential_maintenance` log line reports `remaining` per tick. Rotation has not
been rehearsed (docs/RELEASE_GATES.md).

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

`purgeExpiredRecords` runs every cron tick (src/pipeline/retention.ts), bounded to 5 rounds of
500 rows per table. Vars in wrangler.jsonc: `DELIVERY_RETENTION_DAYS` (30-365, default 90),
`AUDIT_RETENTION_DAYS` (30-3650, default 365). Invalid values fall back to the default.
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
| 0016 observability | Old Worker ignores `ops_state` and the two indexes | `DROP TABLE ops_state; DROP INDEX deliveries_state_created; DROP INDEX audit_events_created;` |

A rollback rehearsal has **not** been performed (docs/RELEASE_GATES.md). A restore from D1
Time Travel is the only recovery from a destructive mistake; its procedure is **UNVERIFIED**.

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

- Nobody is paged. Stall detection logs only.
- No `job_runs`: a cron that stopped is noticed by absence of log lines, not by an alert.
- No replay route yet; no per-delivery lookup by correlation id; no support evidence bundle.
- No ingress counter, so a silent source cannot be detected (`ingress_gap`).
- Everything above is unrehearsed.
