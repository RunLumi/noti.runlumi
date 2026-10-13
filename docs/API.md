# Dashboard API

Every endpoint needs a verified Better Auth session cookie. Each request works in exactly one
workspace. The order of resolution is:

1. `?org=<organizationId>`, if the caller is a member of that workspace.
2. Otherwise, the session's active organization.
3. Otherwise, the caller's only membership.

If none of these yields a workspace, the request is refused, except `GET /api/workspace/me`
(see below). A workspace the caller does not
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

## Current user

`GET /api/workspace/me` tells the dashboard who is signed in and which workspace it is in.
It answers for every membership state:

| Caller | Response |
| --- | --- |
| No session, or email not verified | `401 {"error":"Unauthorized"}` |
| Verified, **no memberships** | `200` with `org_id`, `org_name`, `role` all `null` and `organizations: []`. This is the normal start of onboarding, so the dashboard routes to `/onboarding` instead of `/signin`. |
| One membership | `200` with that workspace |
| Several memberships | `200` with the `?org=` workspace, else the session's active one, else the **earliest membership**, which is then saved as the session's active workspace. It never guesses across tenants. |
| `?org=` for a workspace the caller is not in | `404`, audited as above |

```ts
type Me = {
  user: {
    id: string; name: string; email: string; emailVerified: boolean;
    org_id: string | null; org_name: string | null; role: string | null;
    organizations: { orgId: string; role: string; name: string }[]; // only the caller's own
  };
};
```

Only `/me` has the no-workspace exception. Every other workspace-scoped route (`/team`,
`/integrations`, and the rest) still returns `403 {"error":"Create or join an organization
first"}` for a caller with no memberships.

Capabilities, as defined in `src/auth/permissions.ts`:

| Capability | admin | member |
| --- | --- | --- |
| `integration.read/create/update/delete` | ✅ | ✅ |
| `source.read/create/update` | ✅ | ✅ |
| `source.rotate`, `source.delete` | ✅ | ❌ |
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
  repo: string;                       // owner/repository, a filter within the workspace; '' for a source integration
  sourceId: string | null;            // set when it routes every event of a generic source (see below)
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

A source integration is created with `sourceId` instead of `repo` and `eventTypes`:
`{name, sourceId, destination, webhookUrl, signingSecret?}`. It receives every event its source
accepts. Sending `repo` or `eventTypes` with `sourceId` is `422`, as is a `sourceId` from another
workspace (indistinguishable from an unknown one). `PATCH` may rename, pause or replace
credentials on it, but a `repo` or `eventTypes` change is `422`.

## Sources (generic signed webhook source)

Capabilities `source.*`; the same mutation rules as above (Origin, JSON, 20 mutations per user
per minute, 25 sources per workspace, enforced atomically in the INSERT). Every query is scoped to the workspace; another
workspace's source is `404`.

```ts
type Source = {
  id: string;
  name: string;
  kind: 'generic' | 'gitlab' | 'stripe';
  authMode: 'signing_token' | 'secret_token' | null; // GitLab only; never the credential
  livemode: boolean | null;           // Stripe only
  droppedEvents: number;              // events dropped by the per-source flood limit (GitLab absorbs floods)
  lastDroppedAt: string | null;
  endpointId: string;                 // public routing id, 24 base64url characters
  endpointUrl: string;                // APP_ORIGIN + /webhooks/<kind>/<endpointId>
  enabled: boolean;
  createdAt: string; updatedAt: string;
  lastReceivedAt: string | null;      // last accepted, verified event
  secretRotatedAt: string | null;
  reusedIdRejections: number;         // events refused with 409 webhook_id_reused
  lastReuseRejectedAt: string | null;
  integrationCount: number;           // chats bound to it
};
```

| Method and path | Body | Success |
| --- | --- | --- |
| `GET /api/sources` | | `200 {sources: Source[]}` |
| `GET /api/sources/:id` | | `200 {source}` |
| `POST /api/sources` | `{name, kind?}` (1–80 characters, no control characters; `kind` defaults to `generic`; GitLab and Stripe take a pasted credential, see [Provider sources](#provider-sources-gitlab-and-stripe)) | `201 {source, secret}` for `generic`, `201 {source}` for a provider; `Cache-Control: no-store` |
| `PATCH /api/sources/:id` | `{name?, enabled?}` | `200 {source}`; any other field is `422` |
| `POST /api/sources/:id/rotate` | none for `generic`; the new pasted credential for a provider | **Admin only** (`source.rotate`). `200 {source, secret}` (generic) or `200 {source}` (provider), `Cache-Control: no-store`; the previous secret is invalid at once. `409` if the source changed while rotating (nothing changed; retry). |
| `DELETE /api/sources/:id[?cascade=true]` | none | **Admin only** (`source.delete`). `204`. A source with connected chats returns `409 {error, integrations: n}` unless `cascade=true`, which also deletes those integrations and their saved webhook URLs. |

`secret` (`whsec_` + base64 of 32 random bytes) is returned **only** by create and rotate and is
never readable again; it is also absent from the workspace export, which lists sources without
credential columns. While a workspace deletion is pending, mutations return `409`.

### Provider sources (GitLab and Stripe)

Decisions: [ADR 0015](adr/0015-provider-sources.md). GitLab and Stripe generate their own secret,
so it is **pasted**, sealed on write and never returned by any response, list, export, audit entry
or log; validation messages never echo it.

| `kind` | Create body (besides `name`) | Rules |
| --- | --- | --- |
| `gitlab` | `authMode: "signing_token" \| "secret_token"`, `secret` | `signing_token`: `whsec_` + base64, as GitLab shows it once. `secret_token`: 8–255 visible ASCII characters without spaces. The mode is chosen, not guessed. |
| `stripe` | `livemode: boolean`, `secret` | `secret` is the endpoint signing secret (`whsec_...`). Test and live are separate sources. |
| `sentry` | | `422` on `kind` with the reason: Noti does not offer a Sentry source (ADR 0015, decision 8). |

`POST /api/sources/:id/rotate` for a provider source takes `{secret}` (and `authMode` for GitLab,
which may move from `secret_token` to `signing_token`; moving from `signing_token` to the weaker
`secret_token` also needs `confirmDowngrade: true`, otherwise `422` on `confirmDowngrade`). `livemode` cannot change (`422`). Field
errors are `422 {error, fields: [{field, message}]}`; an unknown `kind` is `422` on `kind`.

**Event selection on integrations.** `POST /api/integrations` with a `sourceId` of a GitLab or
Stripe source accepts `eventTypes` (a list from the catalogue below; empty or absent means every
event of the source), and `PATCH` accepts it later. Anything outside the catalogue is `422` on
`eventTypes`; a generic source has no catalogue and refuses any selection. `repo` and `filters`
remain `422` for every source integration.

| Kind | Catalogue |
| --- | --- |
| `gitlab` | `push`, `tag_push`, `merge_request.opened`, `merge_request.merged`, `merge_request.closed`, `merge_request.reopened`, `issue.opened`, `issue.closed`, `issue.reopened`, `pipeline.failed`, `pipeline.succeeded` |
| `stripe` | `invoice.payment_failed`, `payment_intent.payment_failed`, `charge.dispute.created`, `charge.dispute.closed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted` |

### Receiving provider events: `POST /webhooks/gitlab/:endpointId`, `POST /webhooks/stripe/:endpointId`

No session. `Content-Type: application/json`; body at most 1 MiB (GitLab) or 512 KiB (Stripe).
Unknown, malformed, disabled and wrong-kind endpoints all answer one identical `404 Not found`.

| Situation | Answer |
| --- | --- |
| Credential missing, wrong, stale or malformed | `401 Unauthorized` (nothing is parsed or routed) |
| Authentic event, stored | `202 {accepted, persisted}`; `duplicate: true` when the provider id was already accepted |
| Authentic event Noti does not notify about (type or action outside the catalogue, GitLab merge request update, Stripe thin or Connect event, other livemode) | `200 {accepted: true, ignored: reason}`; nothing is routed |
| Per-source flood limit (600/min), GitLab | `200 {accepted: false, dropped: "rate_limited"}` (GitLab disables webhooks after repeated 4xx); counted in `droppedEvents` |
| More than 1200 requests a minute to one endpoint id, before authentication | `429` with `Retry-After` |
| Per-source flood limit (600/min), Stripe | `429` with `Retry-After` (Stripe retries) |
| GitLab request from an instance other than `gitlab.com`, or without `X-Gitlab-Event` | `401` / `400` |
| Verified body that is not a usable event | `400 {error: reason}` |

GitLab verifies `webhook-id`/`webhook-timestamp`/`webhook-signature` (signing token) or
`X-Gitlab-Token` (secret token) per the source's `authMode`. Stripe verifies
`Stripe-Signature` (`t=`, `v1=`) with a five minute tolerance. Notifications carry no customer
personal data.

### Sending events: `POST /webhooks/generic/:endpointId`

No session. Authentication is the [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md)
`v1` signature. Body at most 256 KiB, `Content-Type: application/json`.

| Header | Meaning |
| --- | --- |
| `webhook-id` | **Must be unique per event**; letters, digits, `_`, `:`, `-`, at most 128 characters (no `.`). Retrying the same event with the same id and body is safe: it is accepted once. Reusing an id for different content is refused with `409`. |
| `webhook-timestamp` | Unix **seconds**; must be within 5 minutes of the server clock. |
| `webhook-signature` | Space-separated `v1,<base64 HMAC-SHA256>` entries (at most 10); the HMAC is over `<webhook-id>.<webhook-timestamp>.<raw body>`, keyed with the **base64-decoded** secret after `whsec_`. Other versions are ignored. |

Body (all strings are single-line unless noted; unknown keys are rejected):

```json
{
  "type": "deploy.failed",
  "title": "Deploy failed on production",
  "summary": "Exit code 1",
  "url": "https://ci.example.com/runs/42",
  "severity": "error",
  "actor": "deploy-bot",
  "fields": { "env": "prod", "attempt": 2 }
}
```

`type` (≤ 100; letters, digits, `. _ : -`) and `title` (≤ 300) are required. `summary` (≤ 1000,
may span lines), `actor` (≤ 100), `url` (absolute `https:`, no credentials, ≤ 2048, rendered as a
link, never fetched), `severity` (`info` default, `warning`, `error`, `critical`) and `fields`
(≤ 10 entries; keys ≤ 40 of letters, digits, space, `_ . -`; values text, number or boolean, ≤ 200)
are optional. Destinations show `severity` as info / warning / failure (`error` and `critical`
both render as failure) and `summary` plus `fields` within a 280-character budget, cut with an ellipsis.

| Status | Meaning |
| --- | --- |
| `202 {accepted: true, persisted: n}` | Durably accepted for `n` integrations (`0` if the source has none). `duplicate: true` marks a repeat of an already-accepted `webhook-id`. |
| `400 {error, fields: [{field, message}]}` | Authentic but invalid JSON or event; names fields, never echoes values. |
| `409 {error: "webhook_id_reused"}` | This `webhook-id` was already accepted with a different body. Nothing was queued; the source's `reusedIdRejections` counter increments. Give every event its own id. |
| `401 Unauthorized` | Missing or malformed headers, wrong signature, or timestamp outside the window (all identical). |
| `404 Not found` | Unknown, malformed or paused endpoint (all identical). |
| `413` / `415` | Body over 256 KiB (counted as it streams in, so chunked and lying `Content-Length` requests are cut off at the cap) / not `application/json`. |
| `429` | More than 600 verified events per minute for this source; honour `Retry-After`. |
| `500` | The stored secret could not be opened; retry later. |

```bash
export NOTI_SIGNING_SECRET='whsec_…'      # shown once when the source was created or rotated
URL='https://<your-origin>/webhooks/generic/<endpointId>'
BODY='{"type":"deploy.failed","title":"Deploy failed on production","severity":"error"}'
ID="msg_$(date +%s)_$RANDOM"; TS=$(date +%s)
KEY=$(printf '%s' "${NOTI_SIGNING_SECRET#whsec_}" | openssl base64 -d -A | xxd -p -c 256)
SIG=$(printf '%s.%s.%s' "$ID" "$TS" "$BODY" | openssl dgst -sha256 -mac HMAC -macopt hexkey:"$KEY" -binary | openssl base64 -A)
curl -sS -X POST "$URL" -H 'content-type: application/json' \
  -H "webhook-id: $ID" -H "webhook-timestamp: $TS" -H "webhook-signature: v1,$SIG" --data-binary "$BODY"
```

Delivery semantics are at-least-once on our side and idempotent by `webhook-id`: a retry with the
same id never produces a second message, but a producer that mints a new id per retry will.

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

While a deletion is pending, integration and source mutations and `POST /api/github/install` return `409`.

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

