# ADR 0054: Saved-destination re-check on update, and an alert on send-time decrypt failures

Status: Accepted · Date: 2026-10-15 · Closes the gap named in F96 and in F97 (spec 07); the parts of REMAINING
slice 2.7 that need no migration. Builds on [ADR 0004](0004-envelope-encryption.md),
[ADR 0024](0024-job-runner-alerting.md) and [ADR 0026](0026-egress-guards.md).

## Context

F96: the integrations API ran the destination URL policy on create and on a credential change, and the consumer
re-ran it before every send. A `PATCH` that left the credentials alone did not re-run it, so an edit could be
saved, and reported as a success, for a destination whose saved URL today's policy refuses (a host removed from
the provider registry, a rule added since). Nothing reached the network, because the consumer refuses it, but the
customer learnt that only from dead letters.

F97: when the consumer could not open a row's credentials (wrong or missing KEK, an unknown KEK version, a
damaged or moved envelope), the delivery failed with a code in the ledger and nothing else. The existing
`credentials_quarantined_nonzero` alert counts rows the maintenance job quarantined; it does not see a failure
at send time, and `key_config_fault` sees only a binding the boot report can judge, not a valid-looking wrong key.

## Decision

### 1. Which fields re-check the saved destination

`RECHECK_STORED_DESTINATION_ON` in `src/api/integrations.ts` is keyed by every field of `UpdateIntegrationInput`
except `credentials`, so a new field does not compile until someone decides:

| Field | Re-check | Why |
| --- | --- | --- |
| `name` | no | changes nothing about sending |
| `repo`, `eventTypes`, `sourceEventTypes`, `filters` | yes | decide what is sent |
| `noise` | yes | decides when; clearing it releases held updates at once |
| `enabled` | yes, when `true` | re-enabling is a new decision to send |
| `credentials` | n/a | the new URL is validated in full by the parser, as before |

The re-check runs only when the integration is still sending after the update (`input.enabled ?? stored
enabled`): pausing, or editing a paused integration, is never refused, above all for a destination the policy now
refuses. Turning it back on runs the check. A quarantined or revoked row is skipped: nothing is sent to it until
a new credential is entered, and that one is validated.

### 2. What the re-check does

It reads the credential columns (tenant-scoped), opens **only the webhook URL** (`openWebhookUrl`, new in
`src/pipeline/credentials.ts`; the signing secret is never decrypted for this) and runs `checkDestinationUrl`
with the same options the consumer uses (`ownHostsOf(APP_ORIGIN)`). It runs after every cheaper input check and
before anything is written.

- URL refused: 422, field `webhookUrl`, "The saved webhook URL is no longer allowed for this destination, so this
  change was not saved. Enter a new webhook URL, or pause the integration." The log line
  `destination_recheck_refused` carries the integration id and the rule; never the URL or its host.
- URL cannot be opened (`CryptoError`): 422, field `webhookUrl`, a message saying it could not be read; the log
  line `destination_recheck_unreadable` carries the crypto code only. This is fail-closed: an edit that would
  keep sending to a destination we cannot check is refused, and pausing still works.
- Shape checks beyond the URL policy (the Lark domain, the custom webhook's secret) stay with the consumer, which
  runs the full `validateDestinationConfig`. The custom webhook's DNS host verification on re-enable is unchanged.

### 3. A decrypt-failure count without a migration

`src/observability/credential-decrypt.ts` keeps one `ops_state` row, `credential_decrypt_failures`, holding
`{ since, at, count }`: the failures of the current burst, failures less than 15 minutes
(`THRESHOLDS.decryptFailureWindowMs`) apart. The consumer calls `recordDecryptFailure` whenever
`openCredentials` throws a `CryptoError`, before it classifies the failure as it did before, and logs
`credential_decrypt_failed` (delivery, workspace, integration, crypto code). The update is one atomic upsert
computed in SQL (no read-modify-write, so concurrent consumers lose no count); the count is capped; a value that
is not JSON is replaced by a fresh burst; a failed write is logged (`credential_decrypt_count_failed`) and never
changes the delivery's outcome. The row holds counts and times only, no tenant or integration id.

Rejected: counting `delivery_attempts` rows by `reason` in a window. It needs no new state, but the only index on
`started_at` alone walks every attempt in the window during exactly the outage the alert is for, and the signal
plans are pinned to seeks. Rejected: a new column or table (a migration).

Only the send path counts. The update-time re-check above logs its own event but does not feed the alert: it is
driven by a person's edit, and the consumer's next attempt counts the same fault.

### 4. The alert

`credential_decrypt_failures` joins the ADR 0024 registry: severity **critical**, threshold 1, one confirming
tick, the usual three clear ticks, no maintenance settle. Decryption never fails in normal operation, so one
failure is either a key fault (every delivery fails) or a damaged row; both need a person. The signal reads the
burst's count while its last failure is inside the window and 0 after, so the alert resolves about 18 minutes
after the last failure; a D1 error reads `null` (neither fires nor resolves). Fire, dedupe (one incident key for
the burst, repeats only on the critical cadence) and resolve are the engine's. `docs/RUNBOOK.md` has the entry,
with the operator query over `delivery_attempts.reason` that names the integrations.

## Consequences

- A customer editing an integration whose saved URL is now refused gets a clear 422 instead of a silent success;
  the API returns it as a field error on `webhookUrl` (`ApiError.fields` in the dashboard). How each edit dialog
  surfaces a field it does not show was not checked in a browser; no UI was changed.
- Each send-time decrypt failure costs one more D1 write (the upsert), on top of the attempt row it already
  writes. During a key fault that is one write per failed attempt, the same order as the ledger's own.
- Twelve alerts are evaluated every minute.

## Not done

- A reconnect prompt in the dashboard when a registry host is removed (F98).
- Counting by crypto code, or by integration, in the alert (the log line and the attempt rows have both).
- Real-provider evidence: nothing here reached Slack, Teams, Lark or Discord; the alert has only reached fakes.

## Revisit when

- A setting is added to the update input: the type makes the decision explicit; put it in the table above.
- Integrations gain a stored format or feature choice (ADR 0052): it decides what is sent, so it re-checks.
- The dashboard gets a reconnect flow (F98): link the 422 to it instead of asking for a new URL in prose.
- Real traffic shows decrypt failures that are not faults (none are expected): then reconsider threshold 1.

## Verification

`tests/api/integration-destination-recheck.test.ts` (field table, the trigger rule, a stored URL the policy now
refuses, pause and rename still allowed, rotation fixes it, an unreadable URL, a damaged signing-secret envelope
that is not opened, a quarantined row), `tests/observability/credential-decrypt-alert.test.ts` (burst counting,
window, atomic increments, malformed value, swallowed write failure, fire, dedupe, resolve, unknown signal) and
the new case in `tests/pipeline/delivery-path.test.ts` (unknown KEK version and a damaged envelope each counted,
a good delivery not; the log has the code, not the URL). All over the Node SQLite D1 fake.
