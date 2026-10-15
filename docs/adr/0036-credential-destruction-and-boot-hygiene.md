# ADR 0036: Credential destruction, boot hygiene and outbox write discipline

Status: Accepted · Date: 2026-10-14 · Completes parts of F34, F37, F39, F40 (spec 03), F04, F10 (spec 01) and F09 (spec 01); builds on ADR 0022

## Context

ADR 0022 made a revoked credential unusable and left four things open (its "Not done" list): revoke left the
sealed secret in D1 until the customer replaced or deleted the connection; the consumer reported a revoked row
as a missing integration; the dashboard could neither revoke nor show the fingerprint; and the boot check did not
cover `APP_ORIGIN`, `BETTER_AUTH_SECRET` or the GitHub bindings, while `/health` still named a misconfigured
binding to anyone who asked. The outbox claim and dispatch writes also had no retry, and nothing asserted D1's
100 bound-parameter limit.

## Decision

### 1. Revoke, drain, destroy, audit (F40)

Revoke keeps its two effects from ADR 0022 (an integration is quarantined with the reason `revoked`, a source is
switched off with `credentials_revoked_at`), and now continues in a fixed order, in `src/pipeline/credential-destroy.ts`:

1. **Revoke.** Nothing new can open the secret: the consumer refuses a revoked row, ingress answers 404 for a
   switched-off source.
2. **Drain.** Wait until nothing that already opened the secret can still be using it. For an integration that is
   "no delivery of this integration is `claimed` with a claim younger than the claim lease" (5 minutes,
   `DELIVERY_CLAIM_LEASE_MS`): a claim is taken before the consumer opens anything, so it is the observable
   proxy for an in-flight send, and a claim older than the lease belongs to a dead consumer and does not hold the
   key. A source has no consumer claim; an ingress request that opened its secret ends well within
   `SOURCE_DRAIN_MS` (60 s) of the revoke, so that is the window.
3. **Destroy.** One statement wipes every credential column: `dek_wrapped`, `key_salt`, `kek_version`,
   `webhook_envelope`, `lark_secret_envelope` and both ciphertexts for an integration (the columns are nullable); for a
   source `secret_envelope`, `key_salt` and `dek_wrapped` become empty blobs and `kek_version` 0, because the
   columns are `NOT NULL` and no migration was needed (no KEK version is 0, so the KEK destruction check
   stops counting the row). With the wrapped key gone, the ciphertext cannot be opened by anyone who holds the KEK.
4. **Audit.** `integration.key_destroyed` or `source.key_destroyed`, inserted in the same batch BEFORE the wipe
   with the same predicate (so it can still read `kek_version`), metadata `{kekVersion, trigger, destinationHost | kind}`.
   The audit insert and the wipe share one predicate ("revoked and still holds key material, and drained"), so the event exists
   exactly when the wipe did and a second attempt, a concurrent one, or the cron pass after the inline attempt is
   a no-op that writes nothing. A test asserts the two predicates stay textually equal.

Where it runs: **inline** in the revoke request for an integration (if no claim is live the key is gone before the
response, and the response says `keyDestroyed: true`), and in the **`credential_maintenance` cron** every tick for
anything deferred (a live claim, a source inside its window), bounded to 25 rows per table per tick. A repeated
revoke call also retries the destroy. The inline attempt never fails the revoke: an error is logged and the sweep
retries. The sweep has no person, so its `actor_id` is null and `trigger` is `sweep`; the actor and the reason
are on the paired `*.credentials.revoke` event for the same subject. Retry: the batch is wrapped in
`withD1Retry` with `idempotent: true`, because after a committed first attempt the repeat matches nothing.

What survives a destroy, on purpose: the row, the non-secret fingerprint, the destination host. The fingerprint is
what makes "this exact credential was burned" visible and what refuses it being entered again.

**Re-entering the burned value after a destroy.** ADR 0022 compared SHA-256 digests of the opened stored value
and the proposal. The stored value is now gone, so the comparison falls back to the retained fingerprint (keyed
and tenant-scoped). Trade-off, stated plainly: without `FINGERPRINT_KEY` no fingerprint was ever computed, so a
destroyed credential cannot then be recognised if pasted again, and the revoke is lifted by any new value. The
dashboard says so when there is no fingerprint (`settings.credentials.fingerprintNone`), and RUNBOOK recommends
setting `FINGERPRINT_KEY`. A 40-bit fingerprint can in principle refuse a different value (about one in 10^12);
it is a refusal with a clear message, never a silent acceptance.

Source rotation after a destroy: the optimistic guard `dek_wrapped = <seen>` cannot bind an empty blob portably,
so the guard is `(dek_wrapped = ? OR (length(dek_wrapped) = 0 AND ? IS NULL))` with both parameters null when the
seen key was empty. A concurrent rotation still loses (409). UNVERIFIED against a real D1: the fake D1 binds and
compares empty blobs; the rewrite avoids depending on it for the guard.

`rewrapStaleSourceKeys` now skips rows with an empty wrapped key (otherwise a destroyed source would make the
rewrap job throw every tick), and `credentialStatus` reports `revokedKeysRemaining`, the zero-check for
"every revoke has run its course".

### 2. `destination_revoked` as a consumer outcome (F40)

The consumer loads the integration without filtering on state and decides in `resolveTarget` before opening
anything: missing, paused or quarantined for another reason stays `config_invalid` / `integration_unavailable`;
revoked is `destination_revoked` with the minted diagnostic `credentials_revoked`. The code already existed in the
taxonomy (a provider deleting a webhook), so it is permanent, not retried, has its dashboard explanation, and its
health effect is `neutral` (no destination was contacted). A queued or in-flight message fails closed here
whenever it was enqueued. The delivery view reports `integrationStatus: 'revoked'` (no replay offered) and the
integration's current `credentialFingerprint`.

### 3. Dashboard (F40, F39, DESIGN.md)

The integration settings "Destination and webhook URL" section shows the fingerprint (monospace, with a line of
explanation, or why none exists), a `Revoked` badge, and whether the encrypted copy is destroyed or being
destroyed. A `Revoke webhook URL` danger button opens an alert dialog (focus starts on Cancel, Escape and Tab
behave, reason is one of three radio cards, never free text) and on success announces what happened and opens the
replace form. The credentials notice has a revoked variant. The delivery detail shows the fingerprint of the
integration's current credential. Strings in en and vi. Not done: the same control and fingerprint for sources
(API only), and the fingerprint in the audit view.

The fingerprint in a delivery view is the integration's CURRENT one, not the one in force when that delivery was
sent: attempts do not record it. That is stated in the field's comment; recording it per attempt needs a column.

Exports (`/api/workspace/export`) now carry `credential_fingerprint` and `credentials_revoked` for integrations and
sources: still never a secret, key, salt or envelope.

### 4. Boot hygiene (F04, F10)

`assessConfig` gains an **auth** tier and GitHub warnings (ADR 0022's table, extended):

| Tier | Bindings | A fault stops |
| --- | --- | --- |
| auth | `APP_ORIGIN` (an absolute origin with no path, query, fragment or credentials; https unless it is a local development host), `BETTER_AUTH_SECRET` (at least 32 characters, not a placeholder) | every `/api` and `/github` request except the probes (503, `Retry-After`). **Not** webhook ingress, the queue consumer or `scheduled`: none needs a session, and a 503 on ingress loses events |
| warnings | `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID` (numeric), `GITHUB_APP_SLUG`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` while a placeholder or malformed | nothing: the GitHub routes already fail closed, and `predeploy-check` treats them as optional by design. They are named so an operator sees which |

`BootReport.names` keeps its meaning (the faults that stop the consumer and `scheduled`); `BootReport.auth` is separate.
Every unit and integration test environment needed `BETTER_AUTH_SECRET` and a valid `APP_ORIGIN` (the cost the
REMAINING note predicted); `tests/support/boot-env.ts` and the inline test environments carry them.

**Unknown extra keys.** `src/platform/config-keys.ts` lists every binding the Worker reads; `unknownKeys(env)` returns
the names present in `env` and on no list (sorted, at most 20, 64 characters each), logged once per isolate as
`config_unknown_keys` and carried in the report. Typed against `Bindings`, and a test fails when `src/env.ts` or
`wrangler.jsonc` gains a name that is not on the list. A typo such as `KEK_V_1` is the case it exists for.

**`/health` no longer names bindings.** An anonymous caller gets `{ok, service}` and, on failure, a coarse
`code` (`config_invalid` or `kek_environment_mismatch`); no `misconfigured`, no `warnings`. Binding names go to the
log and to a new authenticated view: `GET /api/observability/readiness`, readable only by a signed-in user on
`PLATFORM_OPERATOR_USER_IDS` (anyone else, and everyone when the list is unset, gets 404, so the route does not
advertise itself; 401 without a session). It returns `{ok, checks: {config, d1, queue}, code, misconfigured:
{storage, credentials, queue, auth}, warnings, unknownKeys}`: names only, never a value, a length or a prefix, rate
limited like the summary. It is registered in `ROUTE_POLICY` as `self` (it names no workspace; the caller's own
user id from the session is the gate) and therefore is not part of the tenant-isolation drill's workspace attacks.
Limitation: an `auth` fault blocks `/api` including this route, so for that fault the operator reads the log
line; the other tiers leave it readable.

### 5. Outbox write discipline (F09)

The claim, the expired-lease reclaim, the dispatched mark, the release and the invalid-payload batch in
`src/pipeline/outbox.ts` run through `withD1Retry`, with `idempotent` chosen per statement, not assumed:

- the **claim** and the **reclaim** are `idempotent: false`: if the first attempt committed and only the answer was lost, a repeat
  finds the row no longer `pending` (or no longer expired), reports `lost_race`, and the row sits `claimed` under a
  lease nobody holds until it expires and the next reconcile reclaims it. So only failures meaning "it did not
  run" (the `retry` class) are retried for them; "Network connection lost" is surfaced and the reconciler repairs
  it within a lease;
- the **dispatched mark**, the **release** and the **invalid batch** are `idempotent: true`: each is guarded on the lease token
  and `state = 'claimed'`, so a repeat after a committed first attempt changes zero rows.

Overload and timeout are still not retried (ADR 0022). Whether they should be is still undecided: there is no
evidence yet.

`tests/security/bound-parameters.test.ts` gains `no_query_exceeds_100_bound_parameters`: a count of the
placeholders (the highest `?N` or the number of bare `?`) in every SQL text in `src/` and `scripts/`, plus the
arithmetic of the four builders that size a placeholder list at run time (25 repositories x 3, a 90-row delete chunk plus
one, 40 noise group keys twice plus 11, and the digest scope bounded by the renderer's constants), read from the
source so a changed constant fails the test.

### 6. Secrets Store (tier 1) for the KEK: not done

Cloudflare's Secrets Store binding is asynchronous (`await env.KEK.get()`), while the key ring is built
synchronously from `env` at every entrypoint, in `assessConfig`, and in the fingerprint and rewrap paths, and the boot
check is memoised per `env` object. Moving the KEK there means making the ring asynchronous end to end and
caching it per isolate, a change that touches every entrypoint and cannot be exercised without a real Secrets
Store. It is therefore not feasible in this slice and nothing here pretends otherwise: the KEK remains a Worker
secret. Done when taken up: an async `loadKeyring(env)` memoised per isolate, the store binding in
`wrangler.jsonc`, `predeploy-check` and the unknown-key list updated, and a staging rehearsal.

## Review round (independent security review of PR #60)

- **Erasure is not complete while `integrations_old` exists (H1).** Migration 0026 keeps the pre-swap table until an
  operator finalizes it, and it holds the sealed secrets as they were before the revoke. The destroy now wipes the kept
  copy in the same batch (guarded by organization, id, and the live row being revoked and already wiped), the sweep
  wipes any kept copy of an already-wiped connection (one existence check of `sqlite_master` per sweep; a missing
  table is tolerated), `scripts/migration-0026-recover.mjs` records which integrations are revoked before it swaps
  the live table out and re-applies the revoke and the wipe to the restored original (a scratch table kept across an
  interrupted run), and `scripts/kek-destroy-check.mjs` counts `integrations_old` while it exists. Only
  `integrations_old` exists: 0026 does not rebuild `sources`.
- **The real limit.** "Destroyed" means gone from the live database and, until finalize, from the kept original. D1 Time
  Travel keeps point-in-time history for up to 30 days (AR-6) and can contain the secret; Noti cannot shorten it. The
  dashboard, API and runbook say so; the earlier "nobody can recover it, even the KEK holder" is true of the live
  database only.
- **The destroy runs first and alone (M1).** `maintainCredentials` runs the destroy before the key ring is built and
  before the migration and rewrap, in its own try/catch, and each row inside the sweep is caught separately (`failed` is
  counted and logged), so a bad KEK, an `every_row_failed` abort or one failing row cannot leave a revoked secret in place.
  The migration and rewrap still throw afterwards so the cron fails visibly.
- **No fail-open re-paste check (M2).** The wipe now waits until a fingerprint exists (outside `development`): the
  revoke computes and stores a missing one while the secret can still be opened (needs the KEK and a valid
  `FINGERPRINT_KEY`), and the sweep backfills for deferred rows. Without `FINGERPRINT_KEY` a revoked secret therefore
  stays sealed but unusable (revoked, refused by the consumer and by ingress), the re-paste check keeps working by
  comparing with the still-sealed value, `credentialStatus.revokedKeysRemaining` stays above zero, and `assessConfig`
  warns `FINGERPRINT_KEY` (also when it is malformed). Choosing between a burned secret kept sealed and one destroyed with
  a blind re-paste check, the former is safer. Rotating `FINGERPRINT_KEY` makes every stored fingerprint stop matching,
  so a destroyed connection's burned value is then no longer recognised: do not rotate it casually (RUNBOOK).
- **A secret that cannot get a fingerprint (delta review M-a).** The sweep skips a revoked row with no fingerprint, and the
  backfill needs the secret to be openable, so a pre-fingerprint row under a lost key, a corrupt envelope or a missing
  `ENCRYPTION_KEY` would be kept forever. It is now visible: the sweep counts it in `deferred` and
  `awaitingFingerprint` (`keys_awaiting_fingerprint`, a `revoked_secret_awaiting_fingerprint` warning), and the operator
  readiness view shows `revokedSecretsAwaitingFingerprint` and the warning `revoked_secrets_not_wiped`. The way out is an
  explicit operator action, `scripts/force-destroy-revoked.mjs --integration|--source <id> --organization <org> --actor
  <login> [--apply]`: it wipes ONE already-revoked connection, scoped by id and workspace (a wrong id or an unrevoked row
  changes nothing), waits for the drain, wipes the kept `integrations_old` copy, and writes `key_destroyed` with
  `trigger: operator` and `reason: destroyed_without_fingerprint` in the same statement group. There is deliberately no
  automatic wipe after N ticks: a transient fault (a missing KEK for an hour) must not turn into an irreversible, unaudited-by-a-human
  destroy of something the re-paste check still needs.
- **Delete (delta review L-d).** Deleting an integration removes its `integrations_old` row in the same batch while that table
  exists, so "delete destroys the key" holds for the kept original too. Revoke and delete are the two paths; the other
  `_old` tables hold no credentials.
- **Session secret strength (M3).** `BETTER_AUTH_SECRET` is refused outside a local `development` origin when it looks
  copied from an example (a leading `replace`, `change`, `example`, `sample`, `your`, `todo`, `dummy`, `default`,
  `placeholder`, or `changeme`, `entropy` or `placeholder` anywhere, which covers the value in `.dev.vars.example`) or has
  fewer than 10 distinct characters or one character over a third of it. A randomly generated value is occasionally refused by
  the repetition rule (roughly 1 in 9000 for 32 hexadecimal characters); the boot error names `BETTER_AUTH_SECRET`, and the
  fix is to generate another.
- **State guards (L1).** A PATCH that changes credentials updates only while the row is still in the quarantine state it read,
  and its audit rows are written after the UPDATE only if it changed the row; otherwise `409` (a revoke that landed in between is
  never cleared). A source is switched on only while it is not revoked (`409`), so a revoked and wiped source cannot be enabled
  by a stale request and answer 5xx to every webhook.
- **Dashboard (L2, L3).** Enter on a reason radio no longer submits: only the confirm button revokes. The control is shown only
  to admins (`integration.revoke`); the server still answers 403 to others.

## Consequences

- No migration. Existing revoked rows are destroyed by the next `credential_maintenance` tick after deploy (an
  integration whose revoke predates this release has `credentials_quarantine_reason = 'revoked'` and still holds its
  key; the sweep finds it).
- A revoked connection's secret is gone. A customer who revoked by mistake cannot get it back from Noti: they
  create a new webhook at the provider and paste that (the burned value is refused by its fingerprint when a
  fingerprint key was set, see above).
- With no `FINGERPRINT_KEY` a revoked secret is not destroyed (see the review round); set it in every environment.
- Rolling back to a Worker from before this release leaves destroyed rows readable as revoked (the reason is
  unchanged) and the old rewrap job would throw on a destroyed source until the new Worker is back: roll forward.
- Every deploy needs a valid `APP_ORIGIN` and `BETTER_AUTH_SECRET`; before, a bad one failed at the first sign-in.
- Operators read configuration faults from the log or `GET /api/observability/readiness`, no longer from `/health`.

## Not done

- Secrets Store for the KEK (section 6).
- The dashboard revoke control and fingerprint for sources, and the fingerprint recorded per delivery attempt.
- Rehearsal in staging; none of this has run against a real D1 or a real provider. The retry on outbox writes is
  tested with injected failures against the Node SQLite fake, and the D1 error strings come from Cloudflare's
  documentation, not from an observed failure (as in ADR 0022).
- Whether overload should be retried once there is evidence.

## Revisit when

- Cloudflare ships a Secrets Store binding that can be read synchronously, or the key ring is made asynchronous end to end (then move the KEK, see ADR 0033).
- D1 overload or timeout errors on outbox writes become frequent enough to justify retrying them.
- A real-D1 rehearsal shows the empty-blob binding, the `wrangler d1 execute` multi-statement order or the error strings differ from what is assumed here.
- A customer needs the revoked secret gone from D1 Time Travel before 30 days.
