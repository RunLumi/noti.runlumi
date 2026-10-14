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
| Security | Any suspicion of exposure | leaked URL in a log, cross-tenant read | Stop; follow `INCIDENT_RESPONSE.md` (classes S1 to S4 there; a Security row here is S1 or S2 until shown otherwise) |

These tiers are this runbook's own judgement. No on-call rota or paging integration exists
(spec 13 F200 is not built), so today **nobody is paged**: detection is the `delivery_stall`
warn line, `GET /api/observability/summary` and a person looking.

## What to check first

1. `GET /health` on the Worker. 503 names the misconfigured binding (key ring) and nothing
   else; 200 only proves the Worker boots.
2. Is the cron running? Every tick upserts a heartbeat first:
   `SELECT value AS last_tick_ms, updated_at FROM ops_state WHERE key='cron_heartbeat';`
   Compare with `strftime('%s','now')*1000`; it should be under about two minutes old. The
   cron is `* * * * *` (wrangler.jsonc). If it is stale, the Worker may not be deployed with
   its cron trigger, or D1 is unreachable (check `wrangler tail`). Each job is isolated: a
   failing job logs `cron_job_failed` with the job name and the invocation still fails at the
   end, but the other jobs (stall detection, retention) still run. There is no `job_runs`
   table yet (spec 13 F192 not built).
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
  `job: noise_release` and `noise_release_failed` (integration id only). At most 20 integrations are
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
(`replay_of` points at the original) and never mutates the original row. At the time of
writing, **no HTTP route exposes it** (the deliveries API is a parallel slice, docs/API.md).
Until it ships there is no operator-facing replay. Do not hand-insert rows. Replay re-reads
the original outbox message. Only the outbox rows of **dead-lettered** deliveries are kept
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
