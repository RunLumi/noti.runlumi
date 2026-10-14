# ADR 0030: Ingress response contract, usage accounting, refused-tenant audit, and the audit read side

Status: Accepted · Date: 2026-10-14 · Implements slices 1.17, 1.23, 1.32 (audit read side) and 2.4 of
[`docs/specs/REMAINING.md`](../specs/REMAINING.md): F50, F59, F76 (410 only), F29, F222, F233 (the audit half) and F28 (request id).
Specs 02, 04, 05, 14 and 15 are authoritative. Builds on [ADR 0012](0012-generic-source.md),
[ADR 0019](0019-workspace-switcher-audit-log.md), [ADR 0024](0024-job-runner-alerting.md) (correlation ids) and
[ADR 0026](0026-egress-guards.md). **One migration: `0030_ingress_usage_audit_read.sql`** (0028 and 0029 belong to other slices; the
seal check wants a contiguous chain, so this file merges after them).

## Context

Four loose ends from the reconciliation shared one theme: what Noti tells a provider when it refuses or repeats an event, what it
records about a refusal, and how an admin reads that record back.

- The ingress codes of spec 04 F50 were half built: a duplicate was answered 202 (it should be 200, so a provider stops retrying),
  the GitHub route had no content-type check (GitHub can send `application/x-www-form-urlencoded`, which was refused later and for the
  wrong reason), a disabled endpoint was indistinguishable from an unknown one (404), and error bodies had no request id.
- The per-installation flood limiter existed but no test drove the whole GitHub route to a 429, and nothing counted usage.
- A signed GitHub event for an installation no workspace owns was a bare 403: nothing recorded it. Whether every cross-tenant probe
  must be audited was an open question.
- `/audit` could filter by action, result and date only; it had no total, no diff and no request id, and a failed read returned
  whatever Hono's default produced.

## Decisions

### 1. Ingress contract (F50, F59, F76)

1. **A duplicate is `200`, never 202 and never 4xx.** On every route (GitHub, generic, GitLab, Stripe), "duplicate" means the event
   reached the store for at least one integration and none of them was new (the delivery row already existed, or the event is already
   held). The body is `{accepted: true, persisted: 0, duplicate: true}`. An event that matches no integration is still `202`
   `persisted: 0`: nothing was accepted before, so nothing is a repeat. GitHub previously said only `persisted: 0` with a 202.
2. **`415` on the GitHub route** for a content type that is not `application/json` (parameters such as `; charset=utf-8` are fine),
   checked before the body is read and before the signature. A form-encoded delivery was already unusable (`payload=<json>` is not JSON);
   it used to fail as a 400 or a 401 that pointed at the wrong cause. Now GitHub's delivery log shows 415, which says what to change.
   The shared helper is `isJsonContentType` in `src/lib/body.ts`; the generic and provider routes use it too.
3. **`410 Gone` for a paused, revoked or disabled endpoint** (generic, GitLab, Stripe). Unknown and malformed ids stay one identical
   `404`, with the decoy HMAC. Why the 410 is not an oracle: the endpoint id is 144 bits of randomness and is the only secret that
   selects a source (ADR 0012), so a caller who can reach the 410 already holds the capability, and learning "this URL is switched off"
   is what the spec asks the sender to be told ("Sender should disable the webhook endpoint"). A 410 reads nothing sealed, runs no
   verification and touches no counter. It is returned whether or not the request is signed. The earlier "disabled looks like unknown"
   property of ADR 0012 is deliberately given up for this case; the other half of that ADR (unknown looks like malformed) stands.
4. **`correlation_id` in every non-2xx webhook body.** One middleware around `/webhooks/*` (`src/platform/ingress-errors.ts`,
   registered right after `correlation`) rewrites a plain-text refusal to `{error, correlation_id}` and adds the field to a JSON object
   refusal. Status and every header (`Retry-After`) are kept; a 2xx or 3xx is untouched; a body over 8 KiB is not ours to rewrite. It
   runs outside the boot and maintenance middleware, so a 503 during a freeze carries the id too. The id is ours (a v4 UUID), equal to the
   `x-request-id` header; a sender-supplied `x-request-id` is never used. Bodies stay constants and field names, never the received
   signature, secret or payload (asserted in `tests/github/ingress-codes.test.ts`). The middleware is registered once instead of at each
   `return c.text(...)` so a new early return cannot forget it; `MIDDLEWARE_PATHS` (`src/auth/route-policy.ts`) now lists `/webhooks/*`
   and the route-capability test pins the order.
5. Tests that asserted the old behaviour were changed on purpose: 202 to 200 for a repeat, 404 to 410 for a disabled endpoint, text
   bodies to JSON with a correlation id, 400 or 401 to 415 for a GitHub request sent without a JSON content type (the unsigned-lifecycle
   and chunked-body tests now send the header, so they still test what they were written for). Where several refusals are compared for
   identity, the per-request `correlation_id` is normalised away first.

### 2. Usage accounting, and the 429 test (F29)

1. **`ingress_usage`** (migration 0030): per workspace, UTC day and source kind, `events_accepted`, `events_duplicate`,
   `events_rate_limited`. It is accounting and is **separate from `api_rate_limits`** (the abuse counters, pruned hourly, keyed by
   installation or source): nothing in `src/security/ingress-usage.ts` reads or writes that table, and a test pins it (F29 asks for
   exactly this). The workspace comes from the verified installation or source row, never the payload; every statement is keyed by it.
2. **Best effort, and said so.** The write is one UPSERT after the event is durably accepted or refused, outside that transaction, in a
   try/catch: a failed write logs `ingress_usage_write_failed` (the source kind only) and cannot lose, delay or change the answer to an
   event. The figure can therefore under-count; it can never over-count. It is not a billing meter and nothing may call it one (F253 is
   a different feature with different requirements). Counting inside the delivery batch was rejected: it would couple an accounting
   failure to acceptance of the event, which is the wrong way round.
3. What is counted: an event is *accepted* when at least one delivery or held row was created, a *duplicate* by the rule in 1.1, and
   *rate limited* when the post-authentication limit answered 429 or (GitLab) absorbed the event with a 200. The **pre-authentication**
   endpoint guard is not counted: it is hit by callers who have not proved anything, so counting it would let anyone with an endpoint id
   inflate a workspace's numbers.
4. Retention: 400 days of day rows, drained by the existing hourly retention job (`PURGE_INGRESS_USAGE_SQL`), and cleared with the
   workspace (`TENANT_TABLES`, plus `ON DELETE CASCADE`). Registered in the retention matrix; `docs/DATA_RETENTION.md` regenerated.
5. **The full-route GitHub 429 is now a test** (`tests/github/ingress-codes.test.ts`): the window is filled to the limit, the next
   verified event is `429` with `Retry-After: 50`, nothing is queued, the dispatcher is not kicked, the next window is a fresh budget,
   a lifecycle event is never limited, and an unsigned flood never spends the budget.

### 3. Refused-tenant audit (F233), and the decision on "every probe"

**Decision: not every cross-tenant probe is audited, and the cap is the design, not a gap.** What is recorded, and why:

1. **A signed GitHub event for an unknown installation** (`unknown-installation`) or for a **suspended or uninstalled** one
   (`not-active`) is audited as the new action `github.webhook.refused` (subject type `github_installation`, subject id the numeric
   installation id, metadata `reason: unknown_installation | not_active`). The response does not change (one 403 body for the unroutable
   cases, the distinct "not active" message of F68), and a failed or skipped record never changes it.
2. **Bounded on purpose.** One row per `(installation, workspace)` per hour (not per event), and at most 30 rows a minute across the
   whole platform, so a sender with a valid signature cannot use many installation ids to flood the table. An unbound installation is
   routine (someone installs the App and has not finished binding), so a row per event would be noise.
3. **Where the row lives.** A suspended installation is recorded in ITS workspace, where its admins can see that GitHub is still
   sending. An unknown installation has no workspace, so its row has `organization_id` NULL; it appears in no tenant's `/audit` and is
   read by an operator from D1. That is the honest reading of "tenant isolation": there is no tenant to show it to.
4. **Workspace probes (`?org=` and a refused switch) keep their cap of 20 recorded a minute per person**, and the loss is no longer
   silent: the first suppressed probe in a window writes one `access.denied` row with `reason: probe_audit_capped` (no workspace) and a
   `probe_audit_capped` warning is logged, once per person per minute. The 404 is unchanged. Rationale: probing is cheap and
   unauthenticated-equivalent noise, twenty a minute is ample to detect it, and an unbounded log is a way to hurt the victim workspace.
5. **Object-level misses are not audited, by construction.** A request for an integration, source or delivery id that is not in the
   caller's workspace is a 404 indistinguishable from an id that does not exist. Telling the two apart would need a lookup without the
   workspace predicate, which the static query-scope test forbids and which would itself be the leak. So cross-tenant *object* probes
   are not recorded; cross-tenant *workspace* probes are.

### 4. Audit read side (F222, F28)

1. **Request id on audit rows.** `audit_events.correlation_id` (nullable, bounded by `sanitiseCorrelationId` at write) is stamped from
   the request in `auditStatement`. Rows from before the migration, and from a cron job or queue consumer, have none. No CHECK on the
   column on purpose (a CHECK makes SQLite scan the table once during `ADD COLUMN`); the writer bounds it. The append-only trigger
   refuses UPDATE only, so adding a column is allowed.
2. **Filters** (all bound parameters, all inside `e.organization_id = ?`): `actor` (a current member's user id, or `system`),
   `target` and `targetType`, `correlationId`. **`actor` matches only current members**: an outsider whose probe was recorded here or a
   former member matches nothing, so the filter cannot be used to ask whether a user id ever touched this workspace. The member list for
   the dashboard comes from the existing `GET /api/workspace/team` (names and ids; the page keeps names only). Three indexes lead with
   `organization_id` so each filter is a seek inside one workspace.
3. **`total`**, on the first page only, counted up to 10,000 (`totalCapped` says "more than"); the inner `LIMIT` bounds the work, so a
   workspace with a long log cannot make page one scan it.
4. **Field diff** for the few non-secret fields an update changes: `enabled`, `repo`, and the subscribed updates (added and removed).
   The writer (`src/audit/diff.ts`) stores `previousEnabled`, `previousRepo`, `eventTypesAdded`, `eventTypesRemoved` for the fields the
   request set and that really changed; the reader (`changesOf`) rebuilds `{field, kind, before, after}` from the same keys and shows a
   change only when both sides are present and well typed, never a guess. **A webhook URL, a signing secret, a filter body or a name is
   never diffed** (F222: "secrets are represented by their occurrence, never their value"): those rows say only that the field changed.
   Rows written before this have no diff. Lists are stored as deltas because metadata holds only primitives and string arrays, and the
   4 KiB limit must not drop a whole row.
5. **Fail closed.** The route is wrapped: a failed query, a failed limiter write, a failed count, or any returned row whose
   `organization_id` is not the caller's workspace answers `503 {error, correlation_id}` with `Retry-After: 5` and no events: never an
   empty list, never a partial page. The tenant check is defence in depth (the query already filters); it logs
   `audit_read_failed` with `code: tenant_mismatch` or `read_failed`, never SQL or a row. The dashboard already shows a failed query as
   an error and not as "no events" (F225).
6. Decided against: auditing reads of the audit log (it changes nothing, and the 120 a minute limiter already bounds it), and
   showing the actor's email (ADR 0019 stands: a name only, only for a current member).

### 5. Dashboard (`web/src/audit/`)

Follows `DESIGN.md`: opaque reading surfaces, Tabler Outline icons, 44 px controls, no glass. The filter form gains **Who** (current
members and "Noti (automatic)"), **About (id)** and **Request ID**. The two text fields apply on Enter or when the field is left, not on
every keystroke, and an id that cannot be valid is flagged (`aria-invalid`, text, not colour alone) and never sent. A match count reads
"N events match" or "More than N events match". Each row gains two text actions that replace the filters with one click ("Show events
about this", "Show events from this request"), a "What changed" block with "from X to Y" lines (words, not an arrow: the bundled
Geist subset has no U+2192, which the Vietnamese glyph test caught) and the request id. The CSV gains the request id and the diff.
Everything is in English and Vietnamese (`messages.audit.en.ts` / `.vi.ts`; Vietnamese not reviewed by a native speaker).

## Consequences

- A provider that retries a duplicate now gets a 200 and stops; a form-encoded GitHub hook shows 415; a disabled endpoint's sender is
  told to stop; a customer quoting `correlation_id` from a failed delivery can find the request, and the audit rows it wrote.
- **Rolling back the Worker past this migration needs no schema change** (the old Worker ignores the table and the column), but it
  stops counting usage and stamping request ids. See the RUNBOOK migration table.
- Apply `0030` **before** the new Worker: its queries name the column and the table.
- Behaviour change worth a line in a release note: 202 to 200 for repeats, 404 to 410 for disabled endpoints, plain-text webhook
  errors to JSON.

## Not done, and not verified

- Nothing here was exercised against a real GitHub, GitLab or Stripe: no provider has been observed reacting to a 200 duplicate,
  a 410 or a 415 (GitLab disables a webhook after repeated failures, which is the intended effect of 410 and a risk if a sender
  mishandles it). `ingress_usage` has not run on a real D1; the write volume is at most one UPSERT per accepted event.
- The `ingress_usage` count is not reconciled against `deliveries` and is not billing grade.
- Usage is not shown anywhere in the dashboard yet.
- Non-admin audit actors, installation actor rendering, export-before-delete and audit-failure-fails-action (F222) remain open.
- The Vietnamese strings, and the dashboard on a real screen reader, have not been reviewed by a person.
