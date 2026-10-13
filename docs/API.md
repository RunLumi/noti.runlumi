# Dashboard API

Every endpoint needs a verified Better Auth session cookie. Each request works in exactly one
workspace. The order of resolution is:

1. `?org=<organizationId>`, if the caller is a member of that workspace.
2. Otherwise, the session's active organization.
3. Otherwise, the caller's only membership.

If none of these yields a workspace, the request is refused. A workspace the caller does not
belong to returns **404**, never 403, and the attempt is written to `audit_events`.

Mutations (`POST`, `PATCH`, `DELETE`) also require:

- `Origin` equal to `APP_ORIGIN`. Otherwise the response is `403`.
- `Content-Type: application/json` on requests with a body. Otherwise the response is `415`.
  A cross-site form cannot meet this without a CORS preflight.
- A body of at most 16 KiB. Otherwise the response is `413`. A declared `Content-Length` over
  the limit is refused before the body is read.
- At most 30 mutations per user per minute. Otherwise the response is `429` with
  `Retry-After`.
- `DELETE` needs only the `Origin` check, because it has no body.

A probe against a workspace the caller does not belong to is audited once per minute per
actor and target. A `?org=` value longer than 64 characters is never stored verbatim. A
failed denial write never changes the response.

Capabilities, as defined in `src/auth/permissions.ts`:

| Capability | admin | member |
| --- | --- | --- |
| `integration.read/create/update/delete` | ✅ | ✅ |
| `delivery.read` | ✅ | ✅ |
| `delivery.replay`, `audit.read` | ✅ | ❌ |

A missing capability returns `403 {"error":"Missing capability: <name>"}`, and the denial is
audited.

## Integrations

An integration routes the subscribed GitHub event types for one repository to one
destination. Responses **never** contain the webhook URL or the signing secret. They show
only `destinationHost`.

```ts
type Integration = {
  id: string;
  name: string;
  repo: string;                       // owner/repository, a filter within the workspace
  eventTypes: string[];               // from GITHUB_EVENT_TYPES (src/connectors/sources/github/catalog.ts)
  destination: 'lark' | 'slack' | 'teams';
  destinationHost: string | null;     // e.g. "hooks.slack.com"
  enabled: boolean;
  credentials: 'ok' | 'legacy' | 'quarantined';
  filters: FilterConfig;              // {} when none; see "Routing filters"
  filtersInvalid: boolean;            // stored filters corrupt/invalid: events are HELD BACK until replaced
  filtersNewer: boolean;              // saved by a newer release (rollback): sent unfiltered
  createdAt: string | null;
  updatedAt: string | null;
};
```

| Method and path | Body | Success |
| --- | --- | --- |
| `GET /api/integrations` | — | `200 {organizationId, integrations: Integration[], truncated}` (max 200) |
| `GET /api/integrations/:id` | — | `200 {integration}` |
| `POST /api/integrations` | `{name, repo, eventTypes, destination, webhookUrl, signingSecret?, triggerAuth?, filters?}` | `201 {integration}`; `409` at 100 per workspace |
| `PATCH /api/integrations/:id` | any of `{name, repo, eventTypes, enabled, filters}` (`filters` replaces all filters; `null` or `{}` clears them), and/or `{webhookUrl, signingSecret?, triggerAuth?}` to rotate credentials | `200 {integration}` |
| `DELETE /api/integrations/:id` | — | `204` |

Validation failures return `422 {"error":"Validation failed","fields":[{field,message}]}`. Every
invalid field is reported at once. Messages never echo the submitted value.

Rules enforced at write time:

- `webhookUrl` must pass the same allowlist used before every send:
  - Slack: `https://hooks.slack.com/services/…`.
  - Lark: `https://open.larksuite.com/open-apis/bot/v2/hook/…` or the `open.feishu.cn`
    equivalent.
  - Microsoft Teams: the HTTP URL of a Workflows trigger, on a `*.logic.azure.com` host.
  - No userinfo, no explicit port, no other host.
  - The rules live in one place, `validateDestinationConfig`; the API only adapts its verdict
    to the `fields` shape.
- `signingSecret` is Lark only. It is optional, at most 256 characters, with no whitespace.
- `triggerAuth` is Teams only and optional. Only `"anyone"` is accepted (the default);
  `"tenant_users"`, `"specific_users"` and anything else return `422` on `triggerAuth`,
  because those triggers need an Entra token Noti does not send. It is validated, not stored.
  Teams delivery is recorded as `accepted`, never `delivered`, because the Workflows trigger
  answers `202` without confirming that the flow posted the message.
- `eventTypes` must be a non-empty subset of the catalog. Duplicates are removed.
- `destination` cannot be changed after creation, because the credentials are bound to it.
  Create a new integration instead.
- Rotating credentials writes fresh key material, discards the old DEK, and clears any
  quarantine.

Every create, update, credential rotation and delete writes an `audit_events` row in the same
D1 batch as the change. For update and delete, the audit row is written only if the
integration still exists when the batch runs. A concurrent delete therefore returns `404`
and leaves no false "success" entry.

`repo` matches incoming events case-insensitively, as GitHub does.

The audit log refuses `UPDATE`. It is append-only at the application level, not
tamper-evident: organization deletion cascades to it, and a future retention job will
delete rows.

## Routing filters

Per-integration filters narrow which of the subscribed events are sent
([ADR 0010](adr/0010-routing-filters.md)). They are evaluated at ingress against a handful of
normalised facts, never against a stored payload. `filters` is a closed object; every key is
optional and a missing key means "no condition":

```ts
type FilterConfig = {
  branch?:     { allow: string[]; deny: string[] };   // head branch: push, pull_request*, workflow_run*
  baseBranch?: { allow: string[]; deny: string[] };   // pull request target branch
  actor?:      { allow: string[]; deny: string[]; bots: 'any' | 'exclude' | 'only' };
  draft?:      'exclude';                              // skip draft pull requests
  labels?:     { include: string[]; exclude: string[] }; // issues and pull requests
};
```

- `branch` and `baseBranch` entries are globs with exactly two wildcards: `*` (within one path
  segment) and `**` (across `/`), `\*` for a literal star. `? [ ] { } +` and a leading `!` are
  rejected. Matching is case-insensitive and NFC-normalised, by a linear-time matcher; no
  `RegExp` is built from input.
- `actor` entries are exact GitHub logins (case-insensitive). The deleted-user placeholder
  (`ghost`) cannot be put in a list, and an event from it always passes this filter.
- `labels` entries are whole label names, case-insensitive.
- Limits: 32 entries per list, 128 in total, 128 characters per glob, 64 per login, 100 per
  label, 8 wildcards per glob, 8 KiB stored. Violations return `422` with dotted field paths
  such as `filters.branch.allow[2]`; messages never echo the value.
- `deny` wins over `allow`. An empty `allow` allows everything.
- A fact GitHub did not send is unknown, never `false`. **Any configured filter that applies
  to the event and cannot judge it holds the event back** (`unknown_fact`, `unknownFact: true`),
  `allow` and `deny` alike, because a deny rule is often a privacy control. The one exception
  is a deleted account (`ghost`), which an actor filter always passes.
- A filter reads facts only from some event types (branch: push, pull requests, workflow runs,
  releases and deployments; target branch, draft: pull requests; labels: issues, issue comments,
  pull requests; people: all). On create and on every update the filters and the subscribed
  `eventTypes` must fit together: an **"only" list** (`branch.allow`, `baseBranch.allow`,
  `labels.include`) with a subscribed event type that cannot supply that fact is refused with
  `422` on field `filters.coverage` (the message names the filters and catalog events, never the
  typed values). A **"never" rule** on such event types is accepted, and the `201`/`200` body
  carries `warnings: [{filter, eventTypes}]`. For releases and deployments the branch is read
  from `target_commitish` / `deployment.ref` when it looks like a branch (not a SHA or tag ref).
- `branch`, login and label comparison is case-insensitive (fail-safe for `deny`; an `allow`
  list also admits a differently-cased name). `actor.bots: exclude` checks the **sender** of the
  event, not a pull request's author.
- Stored filters that are corrupt or no longer valid make `filtersInvalid: true`: events for the
  integration are held back (`filtered`, filter `config`, reason `config_invalid`) until
  `PATCH` replaces them. `filtersNewer: true` (written by a newer release) sends unfiltered.
- The audit entry for a create or update lists the **ids** of the changed filters
  (`filters: ["branch","labels"]`), never their values.

Capability `integration.read`; another workspace's integration is `404`.

| Method and path | Body | Success |
| --- | --- | --- |
| `GET /api/integrations/:id/routing-log?limit=&cursor=` | — | `200 {entries: [{id, eventType, outcome, filterId, reason, unknownFact, decidedAt}], nextCursor}`. `limit` 1–100 (default 50), newest first, keyset cursor. `400` for a bad `limit` or `cursor`. |
| `POST /api/integrations/:id/filters/preview` | `{eventType, facts?, filters?}` | `200 {result: {outcome: 'delivered' \| 'filtered', filterId, reason, unknownFact}}`. Pure: no delivery, no write, no fetch. |

- `outcome` is `delivered` or `filtered`. `filterId` is set when filtered. `reason` is one of a
  closed vocabulary: `allowed`, `not_in_allow_list`, `in_deny_list`, `unknown_fact`,
  `draft_excluded`, `bot_excluded`, `not_a_bot`, `ghost_exempt`, `config_invalid`,
  `config_newer`. A routing-log row exists for every integration **with filters** that was
  enabled, on the repository and subscribed to the event type; integrations without filters
  write none (their delivery row is the record). It holds ids, the event type, the outcome and
  the reason code, never field values or payload, is written best effort after (never inside)
  the delivery transaction, is deleted with its integration, and is kept for 30 days.
- `config_invalid` means the stored filters are corrupt or no longer valid, so the event was
  **held back** (fail closed; `filterId` is `config`). `config_newer` means a newer release wrote
  them, so the event was sent. Held-back events are not stored and cannot be replayed from Noti.
- `preview` takes a **sample** facts object. Every key is optional and absent means unknown:
  `{branch, baseBranch, actorLogin, actorIsBot, actorIsGhost, draft, labels}`. `eventType` must
  be in the catalog. `filters` is an unsaved draft to try; omit it to test the saved filters.
  It follows the mutation rules (our `Origin`, a JSON body) and is limited to 60 per user per
  minute. It needs `integration.read` only, because nothing is written.

## GitHub connection

See [ADR 0008](adr/0008-github-install-verification.md) and [GITHUB_APP.md](GITHUB_APP.md).

| Method and path | Capability | Result |
| --- | --- | --- |
| `POST /api/github/install` | `integration.create` | `200 {url}`. Navigate the browser to `url`. Returns `503` when the App is not configured and `403` without our `Origin`. |
| `GET /api/github/installations` | `integration.read` | `200 {configured, installations: [{id, account, accountType, repositorySelection, status, updatedAt, needsResync, repositories: string[]}]}` |
| `GET /github/setup` | session | GitHub's setup redirect. Continues to GitHub OAuth. |
| `GET /github/callback` | session | GitHub's OAuth redirect. Verifies and binds, then redirects to `/integrations?github=<status>`. |

`status` is one of:

- `connected`
- `state_invalid`
- `state_user_mismatch`
- `installation_id_invalid`
- `oauth_failed`
- `installation_not_accessible`
- `installation_admin_required`
- `installation_deleted`
- `installation_too_large`
- `workspace_access_lost`
- `unexpected_error`
- `installation_bound_elsewhere`
- `github_unavailable`
- `not_configured`
- `signin_required`

An integration's `repo` must be covered by an active installation in the workspace. Otherwise
the request gets `422` with a `repo` field error. The stored value uses GitHub's casing.

## Deliveries (delivery log and manual redelivery)

Every query is scoped to the caller's workspace; a delivery in another workspace is a `404`.
Responses never contain a payload, a webhook URL or a secret, only ids, states, counts,
timestamps and a taxonomy error code with its user-facing wording. The log is at-least-once:
responses carry `guarantee: "at_least_once"` and the dashboard says so.

| Method and path | Capability | Result |
| --- | --- | --- |
| `GET /api/deliveries` | `delivery.read` | `{deliveries, nextCursor, guarantee}`. Query: `state`, `integrationId`, `from`, `to` (ISO dates), `limit` (1–100, default 25), `cursor` (opaque, ordered by `(updated_at, id)` descending). Filter `state=dead_lettered` also matches legacy `failed` rows. `422` on a bad filter. |
| `GET /api/deliveries/summary` | `delivery.read` | `{windowHours: 24, counts}` by state for deliveries created in the last 24 hours. |
| `GET /api/deliveries/:id` | `delivery.read` | `{delivery, timeline, attemptDetail: "summary", replays, guarantee}`. The timeline is what the single ledger row records, not a per-attempt history. |
| `POST /api/deliveries/:id/replay` | `delivery.replay` (admin) | Requires our `Origin` and `application/json`. `202 {replay: {deliveryId, replayOf, created: true}}`; `200` with `created: false` while an earlier replay of the same delivery is queued or succeeded (idempotent). `409` if the delivery is not dead-lettered, already delivered, its original message is gone, its integration is deleted, paused or quarantined (`reason: "integration_unavailable"`), or workspace deletion is pending. `429` when rate limited. Audited as `delivery.replay`; the audit row commits in the same batch as the replay and exists only if a new replay row was created. |

A replay never edits the original row (not even `updated_at`): it writes a new delivery with
`replayOf` set, so the log shows both. Each delivery carries `integrationStatus`
(`available`, `missing`, `disabled`, `quarantined`); `canReplay` is true only for
`available`. Reads are limited to 300 per minute per user and mutations to 30, both `429`
with `Retry-After`.

## Workspace export and deletion (admin)

| Method and path | Capability | Result |
| --- | --- | --- |
| `GET /api/workspace/export` | `workspace.export` | `200` JSON attachment, `format: "lumi-noti-export/v1"`, `credentialsIncluded: false`, at most the 2,000 most recent deliveries and audit events (`truncated` says if older rows were left out). The export is audited. |
| `GET /api/workspace/deletion` | `workspace.delete` | `{scheduled: false}` or `{scheduled: true, requestedAt, purgeAfter, purgeStarted}` |
| `POST /api/workspace/deletion` | `workspace.delete` | Body `{confirm: "<workspace name>"}`. Returns `202`. Integrations are disabled immediately and the purge runs after 7 days. Returns `422` on a wrong confirmation and `409` if a deletion is already scheduled. |
| `DELETE /api/workspace/deletion` | `workspace.delete` | Cancels and restores the integrations that were enabled. Returns `409` once the purge has started. |

While a deletion is pending, integration mutations and `POST /api/github/install` return `409`.

## Observability

| Method and path | Capability | Result |
| --- | --- | --- |
| `GET /api/observability/summary?window=24h` | `delivery.read` | `200` JSON, workspace-scoped, `Cache-Control: no-store`. `window` is `<n>h` or `<n>d` from `1h` to `30d` (default `24h`); anything else is `400`. Limited to 30 requests a minute per user (`429` with `Retry-After`). |

The body is exact, computed from the delivery ledger on request. Ratios are a **cohort by creation time**: rows created inside the window, counted by their current state. `oldestOutboxPendingAgeMs` covers due outbox rows only (a retry parked for later does not count). Shape (abridged):

```ts
type Ratio = { value: number | null; numerator: number; denominator: number }; // null = no data
type Summary = {
  provenance: 'exact';
  generatedAtMs: number;
  window: { sinceMs: number; untilMs: number };
  deliveries: { total: number; byState: Record<DeliveryState, number> };
  successRatio: Ratio & { definition: string };   // (sent+accepted) / (sent+accepted+dead_lettered)
  retryRate: Ratio & { definition: string };
  deadLetter: { count: number; byErrorCode: { code: string; count: number }[] };
  latency: { endToEnd: Latency; queueDelay: Latency };   // exact nearest-rank p50/p95, no averages
  backlog: { oldestPendingAgeMs; oldestClaimedAgeMs; oldestRetryOverdueMs; oldestOutboxPendingAgeMs }; // current, not windowed
  byDestination: { destination: string; outcomeKind: 'delivered' | 'accepted'; total; sent; accepted; deadLettered; successRatio: Ratio }[];
  notMeasurable: { sli: string; reason: string }[];       // SLIs the ledger cannot support yet
};
type Latency = { samples: number; excluded: number; p50Ms: number | null; p95Ms: number | null; resolutionMs: 1000 };
```

Teams Workflows reaches `accepted`, never `sent`: the provider cannot confirm delivery, so it
is reported as `outcomeKind: "accepted"`. Latency is `last_attempt_at` minus `created_at`;
`created_at` has one-second resolution. Every response from the Worker carries an
`x-request-id` header (our own id; a caller-supplied one is only logged beside it).

