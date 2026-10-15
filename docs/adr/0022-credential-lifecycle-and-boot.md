# ADR 0022: Credential lifecycle, boot checks and D1 write discipline

Status: Accepted, partly completed by [ADR 0036](0036-credential-destruction-and-boot-hygiene.md) (drain-then-destroy, `destination_revoked`, boot checks for `APP_ORIGIN`, `BETTER_AUTH_SECRET` and the GitHub bindings, anonymous `/health` without names, outbox retry) · Date: 2026-10-14 (revised after independent review) · Implements parts of F04, F09, F10 (spec 01) and F34, F37, F39, F40 (spec 03); builds on ADR 0004 and ADR 0017

## Context

ADR 0004 sealed credentials and made rotation possible, and left four gaps open: a Worker booted with
another environment's KEK was not refused; a customer could not declare a credential burned (only
"quarantined", which is our fault with the row, not theirs); nothing proved that deleting a
connection makes its secret unrecoverable; and no one could safely destroy an old KEK version.
Separately, `/health` checked only the key ring, the `queue` and `scheduled` entrypoints checked
nothing, and a transient D1 write failure on ingress was surfaced as a 5xx with no retry.

## Decision

### 1. Two non-secret fingerprints

- **Credential fingerprint** (F39): `base32(HMAC-SHA-256(tenant key, secret))[0:8]` where the tenant key is
  `HKDF(FINGERPRINT_KEY, info = "lumi-noti/fp/v1\0" + orgId)`. Stored in `credential_fingerprint` when a
  credential is sealed (create, rotate, v0 migration) and returned by `GET` as `credentialFingerprint`.
  It is **keyed and tenant-scoped**: an unsalted hash of a webhook URL would let anyone who can read the
  column confirm a guess, and the same secret in two workspaces would look the same. The key is a
  dedicated optional secret, `FINGERPRINT_KEY` (64 hex characters), **not** a KEK derivative, so a KEK
  rotation or destruction never changes a fingerprint. Without the key no fingerprint is computed and
  the field is `null`: it is display only, never a reason to fail. Rows sealed before this release show
  `null` until the credential is next entered. It is never consulted for authorization.
- **KEK check value** (F34): the first 32 hex characters of `HKDF-SHA-256(ikm = KEK, salt = empty, info =
  "lumi-noti/kcv/v2:" + ENVIRONMENT_NAME)`. One per KEK version, stored as the public var
  `KEK_CHECK_V<n>`. The KEK is never used directly as a MAC key, and the output does not reveal it.

### 2. Environment mismatch refusal

`ENVIRONMENT_NAME` (`production`, `staging`, `development`) and `KEK_CHECK_V1` (`KEK_CHECK_V2` while
rotating) are `vars`. Outside `development` at least one KEK the Worker holds must carry a well-formed
check value, and every check value that is present must match its KEK. A second KEK without a check
value is a **warning**, so a rotation can deploy the KEK and its check value in either order without an
outage (see RUNBOOK for the recommended order). `development` is accepted only when `APP_ORIGIN` is
`localhost`, `127.0.0.1`, `[::1]` or `*.localhost`, so a production deploy cannot opt out of the check
by naming itself `development`. The result is memoised per `env` object; an error inside the check is a
`config_invalid` report (`KEK_CHECK`), never a thrown request and never a remembered rejection.

Why a check value and not "KEK_V1 differs between environments": a deploy tool cannot compare secrets it
cannot read, and a Worker cannot know the other environment's KEK. A public one-way value per
environment is the smallest thing both sides can hold.

### 3. Required and optional bindings, and what a fault stops

`assessConfig(env)` in `src/platform/config.ts` returns binding **names** only, by tier:

| Tier | Bindings | A fault stops |
| --- | --- | --- |
| storage | `DB` | every request except `/health` and `/health/ready`; the queue consumer; `scheduled` |
| credentials | `KEK_V1`, `KEK_V2`, `KMS_ACTIVE_VERSION`, `ENVIRONMENT_NAME`, `KEK_CHECK_V<n>`, and a KEK that does not match its check value | requests that seal or open a credential: `POST`/`PATCH`/`PUT` on `/api/integrations`, `/api/integrations/:id`, `/api/integrations/:id/test`, `/api/sources`, `/api/sources/:id`, `/api/sources/:id/rotate` (503); the delivery consumer; `scheduled`. **Not** webhook ingress, sign-in, reads, delete or revoke |
| queue | `DELIVERY_QUEUE` | `scheduled` (dispatch). Ingress persists to the outbox without it; reads are unaffected. `/health` and `/health/ready` report it |
| optional (warnings) | `ENCRYPTION_KEY` (legacy v0 key), `FINGERPRINT_KEY`, a second KEK's check value | nothing. `/health` lists them under `warnings` on a 200; only the job that needs the binding stands down (a malformed `ENCRYPTION_KEY` skips the v0 migration and logs `legacy_key_malformed_migration_skipped`) |
| not asserted | `APP_ORIGIN`, `BETTER_AUTH_SECRET`, `GITHUB_*` | the GitHub placeholders fail closed at their own route, and `createAuth` throws |

Why ingress is not gated on the key ring: webhook ingress verifies a signature and writes delivery and
outbox rows; it never opens a destination credential. (GitHub verifies with `GITHUB_WEBHOOK_SECRET`; the
generic and provider routes open their own source secret and already answer 5xx from the route when that
fails.) A 503 on ingress **loses events**: GitHub does not automatically redeliver a failed webhook, and
GitLab disables a hook after repeated failures. Only a missing D1, which genuinely prevents durable
acceptance, 503s ingress; in that case the sender's retry is not guaranteed either (below).

`GET /health` stays cheap and public: configuration only, no D1, so it is **200 while D1 is down**. A
failure returns `{ok:false, code, misconfigured:[names], warnings?}` with `code` `config_invalid` or
`kek_environment_mismatch`. `GET /health/ready` adds a bounded (3 s, timer cleared) `SELECT 1` and a
presence check of the queue binding (it sends nothing) and returns booleans only: `{ok, checks:{config,
d1, queue}}`, 503 if any is false, `Cache-Control: no-store`. The answer is cached in the isolate for 5
seconds so a public caller cannot drive one D1 query per request. It never names a binding. Both probes
are routed to the API by `isBackendPath` (`/^\/(api|webhooks|github|health)(\/|$)/`); `/healthz` and
similar still get the dashboard. `tests/web/worker-health.test.ts` proves this through `src/worker.ts`.

### 4. Entrypoints

| Entrypoint | Behaviour on a fault |
| --- | --- |
| `fetch` | per the table above: a 503 `{"error":"Service unavailable"}` with `Retry-After: 30`, after the correlation id and security headers, without touching D1, the queue or a credential. Names go to the log once per isolate, never to the caller |
| `queue`, delivery queue | storage or credentials fault: **each message** is retried on its own delay `min(43200, 300 * 2^(attempts-1))` seconds (5, 10, 20, 40, 80 minutes: about 2.6 hours across the five retries of `wrangler.jsonc`); nothing is consumed or acknowledged by the gate |
| `queue`, dead-letter queue | **never gated**: it needs only D1 and exists to record a loss |
| `scheduled` | records its heartbeat and runs stall detection first (so the outage is visible and silence is measurable), then throws `config_invalid: <names>` |

What this does **not** guarantee: an outage longer than about 2.6 hours exhausts a delivery message's
queue retries and moves it to `noti-dead-letters`, whose consumer marks the delivery `dead_lettered`.
The every-minute reconciler only recovers outbox rows that are `pending` or have an expired claim
(`SELECT_RECONCILE_CANDIDATES_SQL`); a row already `dispatched` whose queue message later dead-letters is
**not** re-dispatched. Recovery is manual replay of the dead-lettered deliveries (admin single replay,
F182; there is no bulk replay yet, REMAINING 1.7). If the dead-letter consumer cannot run either, the
platform deletes those messages after 4 days and the deliveries stay `pending`/`retrying`; RUNBOOK has
the query. This replaces the earlier wording ("nothing is dead-lettered because of our deployment").

### 5. Revocation (F40)

`POST /api/integrations/:id/revoke-credentials` and `POST /api/sources/:id/revoke-credentials`:
admin-only capabilities `integration.revoke` and `source.revoke`, Origin check, rate limit, audited
(`integration.credentials.revoke`, `source.credentials.revoke`; closed reason list `compromised`,
`no_longer_used`, `other`, never free text), tenant-scoped, idempotent.

- **Integration.** Marked quarantined with the reason `revoked`. Every delivery path already refuses a
  quarantined row (consumer, noise release, redelivery, test send), so nothing is sent and nothing is
  decrypted, including messages already queued. `credentialStatus` counts `revoked` separately. The view
  keeps `credentials: "quarantined"` for a revoked row because the dashboard parser rejects unknown values,
  and adds `revoked: true`.
- **Source.** Switched off (ingress already answers 404 for a disabled endpoint) and
  `credentials_revoked_at` set. It cannot be re-enabled by PATCH.
- **Clearing a revoke needs a NEW secret and the right capability.** Entering a credential on a revoked
  integration requires `integration.revoke` (a member who can still edit the integration gets 403), and a
  credential equal to the stored one is refused with 422 (compared as SHA-256 digests of the opened stored
  value and the proposed value, so the comparison time says nothing about either). A revoked provider
  source refuses the same pasted credential on `rotate`; a generic source's secret is generated by us so it
  cannot repeat. A successful rotate clears the flag and turns the source back on.
- **One audit entry per revoke.** The UPDATE is guarded on "not already revoked", and the audit insert runs
  only if that UPDATE changed a row (`changes() > 0`), for both kinds, so concurrent revokes write exactly
  one entry.

Not done: F40's fixed order revoke, drain in-flight, destroy DEK, purge ciphertext. Revoke leaves the
sealed secret until it is replaced or the connection deleted; and the consumer still reports a revoked row
as a missing integration, not `destination_revoked`.

### 6. Crypto-shredding is proven, and KEK destruction is guarded

Deleting an integration or source deletes its row and with it the only copy of `dek_wrapped` and
`key_salt`. `tests/security/credential-lifecycle.test.ts` proves it: after DELETE no column of any table
holds those bytes or the ciphertext, and a holder of the ciphertext **and the KEK** cannot open it.

Destroying a KEK **version** is guarded by `scripts/kek-destroy-check.mjs`: `destroy-check` refuses while
any integration or source row is wrapped under that version (by the column **or** by the version inside
the wrapped-key envelope, which is authoritative); `record-destruction` runs the check and inserts one
`key.destroy` audit event in a single SQL statement, so the event exists only if no row remained at that
instant. The event records that destruction was **authorised**; deleting the secret is a separate manual
step the script cannot perform or verify. `--active` is supplied by the operator and must be the
`KMS_ACTIVE_VERSION` actually **deployed** (the script cannot read it and refuses only a version equal to
the value passed). The event has no workspace (`organization_id` NULL) and is exempt from the audit
retention purge (`PURGE_AUDIT_SQL` skips `action='key.destroy'`): it is platform evidence, not workspace
history.

### 7. Release gates: no placeholder reaches production

`wrangler.jsonc` is committed with `REPLACE_WITH_` placeholders so a fresh checkout fails closed.
`scripts/predeploy-check.mjs` (`npm run predeploy`, run automatically before `npm run deploy`) refuses to
deploy while any placeholder remains outside the optional GitHub App identifiers (those only warn: the
feature stays closed by design), and requires `ENVIRONMENT_NAME` to be `production` or `staging` and
`KEK_CHECK_V1` to be 32 hex characters. A test (`tests/config.placeholders.test.ts`) fails CI if the
committed file carries a placeholder under any key not on the allow-list. `npm run deploy` ends with
`scripts/smoke-health.mjs`, which GETs `/health` and `/health/ready` on the new deployment; a non-200
exits 1 and tells the operator to `wrangler rollback`.

### 8. D1 retry (F09)

`withD1Retry(fn, {idempotent, attempts, baseMs, capMs}, random)` in `src/db/retry.ts`: at most 5
attempts (the documented example's bound), exponential backoff with **full jitter**, and a
classification of D1 error messages taken from Cloudflare's error list:

- retried always: `reset because its code was updated`, `storage caused object to be reset`,
  `Can't read from request stream because client disconnected`;
- retried only when the caller says `idempotent`: `Network connection lost`, `Replica disconnected from
  primary`, `Cannot resolve D1 DB due to transient issue on remote node` (it may have committed);
- **not retried**: `D1 DB is overloaded`, `exceeded timeout`, memory and CPU limit resets. Cloudflare says
  to reduce load or reshape the work, and a retry storm makes an overload worse. This differs from spec
  F09's table; the documentation wins. A `d1_write_shed` warning is logged;
- everything else, including every constraint violation, is permanent and surfaced.

The ingress write (delivery row plus outbox row plus noise bookkeeping) is wrapped as a **whole batch**
(`ingressBatch`): a batch is one transaction, and every statement in it is idempotent (`INSERT OR IGNORE`
on a deterministic id, the outbox insert guarded by `changes() > 0`, a guarded upsert, a keyed DELETE). If
the first attempt committed and only the response was lost, the retry changes zero rows and the event is
still queued exactly once. **Visible consequence:** that retry answers `{accepted:true, persisted:0,
duplicate:true}` and skips the prompt `waitUntil` dispatch, so the event is delivered by the every-minute
outbox reconciler (up to about a minute later), not immediately. `tests/db/retry.test.ts` pins it.

UNVERIFIED: the message strings come from the documentation, not from a real D1 failure; a wording change
would make a transient error `permanent` (surfaced, not retried), which is the safe direction.

`tests/security/bound-parameters.test.ts` is the static guard that no SQL in `src/` or `scripts/`
interpolates anything except a reviewed constant or code-built fragment declared from literals in the same
file, never a request-derived name, never extended by `+`, `.concat(`, `.replace(` or `.join(` after the
literal, and never reached through an aliased `prepare`.

## Consequences

- Every deploy needs `ENVIRONMENT_NAME` and a check value for the KEK (docs/RUNBOOK.md). Forgetting one is
  a visible 503 on `/health` and a failed predeploy, not a silent success.
- A KEK rotation adds one step: compute and deploy `KEK_CHECK_V2` first, then add `KEK_V2`; drop
  `KEK_CHECK_V1` with `KEK_V1`.
- `FINGERPRINT_KEY` is a new optional secret; without it no fingerprints are shown.
- The audit action and subject lists gained `integration.credentials.revoke`,
  `source.credentials.revoke`, `key.destroy` and `key`; the dashboard catalogue has en and vi labels.
- An ingress outage (missing D1) needs manual GitHub redelivery for the window it covered
  (docs/RUNBOOK.md); the guard no longer creates such an outage for credential faults.

## Not done

(Items marked "done in 0036" were completed by ADR 0036; the rest is still open.)

- Secrets Store (tier 1) for the KEK (assessed in 0036: not feasible without an async key ring).
- Done in 0036: drain-then-destroy on revoke, `destination_revoked` in the consumer, per-connection `key_destroyed` audit, the dashboard revoke control and fingerprint (integrations), `withD1Retry` on outbox claim and dispatch writes.
- DEK destruction in workspace purge beyond the row deletion it already does.
- Automatic recovery of deliveries whose queue message dead-lettered (manual replay only) and a bulk replay.
- Rotation rehearsal in staging; the new procedures have only run against the Node SQLite fake.
