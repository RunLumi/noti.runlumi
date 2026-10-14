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
    activeOrgId: string | null;                  // the workspace this response describes (= org_id)
    organizations: { orgId: string; role: string; name: string }[]; // only the caller's own, oldest membership first
  };
};
```

### Switching workspace: `POST /api/workspace/active`

Body `{"organizationId": "<id>"}` (JSON). Makes that workspace the **session's** active one, which
every workspace route uses when no `?org=` is given.

| Case | Response |
| --- | --- |
| Member of that workspace | `200 {"activeOrgId", "orgName", "role"}`; `session.active_organization_id` is updated |
| Not a member, or no such organization | `404 {"error":"Not found"}`: the same status and body for both, so the endpoint reveals nothing about which ids exist |
| No session, or email not verified | `401` |
| Cross-site or missing `Origin` | `403` (central CSRF middleware, as for every `/api/*` mutation) |
| Not JSON | `415` |
| `organizationId` missing, not a string or longer than 64 | `422` with `fields` |
| A refused switch | Audited like any refused workspace request (an `access.denied` row, at most 20 recorded per person a minute) |
| More than 30 switches a minute per user | `429` with `Retry-After` |

**Writes need `?org=` for a person in several workspaces.** A `POST`, `PUT`, `PATCH` or `DELETE` on a
workspace route that does not carry `?org=<id>` from a caller with more than one membership is
`400 {"error":"org is required"}` (it would otherwise use the session's active workspace, which another
tab may have changed). A caller with one membership is unaffected; reads still fall back to the active
workspace.

Membership is read from the database for the caller; the body is never trusted. Only the caller's own
session row is written. It is not audited (it changes no workspace data). `Cache-Control: no-store`.

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
  destination: 'lark' | 'slack' | 'teams' | 'discord' | 'generic_webhook';
  destinationHost: string | null;     // e.g. "hooks.slack.com"
  enabled: boolean;
  credentials: 'ok' | 'legacy' | 'quarantined'; // a revoked credential reads 'quarantined' (nothing is sent) with revoked: true
  revoked: boolean;                   // the customer revoked the credential (ADR 0022); cleared only by entering a new one
  credentialFingerprint: string | null; // 8 base32 chars of a tenant-keyed HMAC of the webhook URL (key FINGERPRINT_KEY); null if no key is configured or it was sealed before this release
  filters: FilterConfig;              // {} when none; see "Routing filters"
  filtersInvalid: boolean;            // stored filters corrupt/invalid: events are HELD BACK until replaced
  filtersNewer: boolean;              // saved by a newer release (rollback): sent unfiltered
  noise: NoiseSettings | null;        // quiet hours, grouping, summaries, resolved notices; see "Noise control"
  noiseInvalid: boolean;              // stored noise settings unreadable: updates are delivered normally
  noiseNewer: boolean;                // saved by a newer release (rollback): ignored, delivered normally
  createdAt: string | null;
  updatedAt: string | null;
  health: DestinationHealth | null;   // circuit breaker and rate-limit hold (ADR 0023); null until one is needed
};
type DestinationHealth = {
  state: 'closed' | 'open' | 'half_open';
  paused: boolean;                    // open or half-open: deliveries are waiting, not failing
  consecutiveFailures: number;
  retryAt: string | null;             // ISO; when the next probe is allowed, null when closed
  pacedUntil: string | null;          // ISO; the destination asked to be left alone until then
  lastFailureCode: string | null;
  lastFailureAt: string | null;
  timesOpened: number;
};
```

`health` is shown, never enforced: Noti stops sending to a destination that keeps failing (5 consecutive
`destination_unavailable` or `destination_timeout` failures open it for 5 minutes, then one probe decides)
and never turns the integration off. Deliveries wait as `retrying` with `pausedReason`, spend no attempt and
are not dead-lettered.

| Method and path | Body | Success |
| --- | --- | --- |
| `GET /api/integrations` | — | `200 {organizationId, integrations: Integration[], truncated}` (max 200) |
| `GET /api/integrations/:id` | — | `200 {integration}` |
| `POST /api/integrations` | `{name, repo, eventTypes, destination, webhookUrl, signingSecret?, triggerAuth?, filters?, noise?}` | `201 {integration, warnings}` (plus `signingSecret` once for `generic_webhook`, with `Cache-Control: no-store`); `409` at 100 per workspace |
| `PATCH /api/integrations/:id` | any of `{name, repo, eventTypes, enabled, filters, noise}` (`filters` and `noise` replace everything; `null` or `{}` clears them), and/or `{webhookUrl, signingSecret?, triggerAuth?}` to rotate credentials | `200 {integration, warnings}` (rotating a `generic_webhook` also returns a new `signingSecret`, once) |
| `POST /api/integrations/:id/revoke-credentials` | optional `{reason?: 'compromised' \| 'no_longer_used' \| 'other'}` (default `other`) | **Admin only** (`integration.revoke`), Origin and JSON content type required. `200 {integration}` with `revoked: true`, `credentials: 'quarantined'`. Nothing more is sent for it, including messages already queued. Entering a new credential (`PATCH` with `webhookUrl`) clears it, but only for an admin (`integration.revoke`; a member gets `403`) and only with a value different from the revoked one (`422`). Repeating the call, or two racing calls, is a no-op (one audit entry). `422` for an unknown `reason`. |
| `DELETE /api/integrations/:id` | — | `204` |

Validation failures return `422 {"error":"Validation failed","fields":[{field,message}]}`. Every
invalid field is reported at once. Messages never echo the submitted value.

Rules enforced at write time:

- `webhookUrl` must pass the same allowlist used before every send:
  - Slack: `https://hooks.slack.com/services/…`.
  - Lark: `https://open.larksuite.com/open-apis/bot/v2/hook/…` or the `open.feishu.cn`
    equivalent.
  - Microsoft Teams: the HTTP URL of a Workflows trigger, on a `*.logic.azure.com` host.
  - Discord: `https://discord.com/api/webhooks/{id}/{token}` (or the `/api/v10/` form), with at
    most a `?thread_id=<digits>` query. `discordapp.com`, `canary.` and `ptb.` hosts and any
    other query parameter are `422`. The stored URL is normalised.
  - Custom webhook (`generic_webhook`): **off unless the deployment sets
    `GENERIC_WEBHOOK_ENABLED` to `true`** (ADR 0014). While off, create (also for a source) is
    `422` on `destination` with "This destination type is not available yet." and nothing else,
    checked before the URL is looked at; re-enabling or rotating the credentials of an existing
    one is the same `422`, while pause, rename and delete still work. `GET /api/integrations`
    reports `capabilities: {genericWebhook: boolean}`. At most 10 per workspace (`409`).
    When on: any **public https** hostname on port 443. Refused with
    `422` on `webhookUrl`: `http`, userinfo, a fragment, another port, an IP address in any
    notation, a single-label or trailing-dot name, `localhost`/`.local`/`.internal`/`.lan`/
    `.home`/`.corp`/`.test`/`.example`/… names, known wildcard-DNS names (`nip.io`, …), and
    `runlumi.app`, the host of `APP_ORIGIN` and its parent domain, `workers.dev`, `pages.dev`
    and `cfargotunnel.com`. After that shape check the API resolves the host (DNS-over-HTTPS, A and
    AAAA) and refuses it if any address, or any CNAME target in the answer, is private, reserved
    or internal; it runs again when the integration is re-enabled (`422`: "resolves to a private
    or reserved address"), if it does not resolve, or if the lookup fails ("try again": it
    fails closed). This is a save-time check only: it does **not** stop DNS rebinding (ADR
    0014, AR-30). Messages never echo the URL or an address.
  - No userinfo, no explicit port, no other host (except the custom webhook's free hostname).
  - The rules live in one place, `validateDestinationConfig`; the API only adapts its verdict
    to the `fields` shape.
- `signingSecret` is Lark only. It is optional, at most 256 characters, with no whitespace. A
  `generic_webhook` **always** has a signing secret, generated by the server (`whsec_` plus 32
  random bytes, base64); supplying one is `422`. It is returned once in the `201` (and in the
  `200` of a credential rotation, which always issues a new one), never by `GET`, list, export,
  audit or log. Each request to the customer carries Standard Webhooks headers
  (`webhook-id` = the delivery id, stable across retries; `webhook-timestamp`;
  `webhook-signature`), `x-noti-delivery-id` and `x-noti-event-type`, and a JSON body
  `{version: 1, type: "noti.notification", id, time, workspaceId, notification: {title, eventType,
  url?, repo?, actor?, status?, summary?}}`. A `2xx` from the customer is the only evidence we
  have: `202` is recorded `accepted`, any other `2xx` `sent`; 3xx and most 4xx are permanent,
  `408`/`425`/`429`/`5xx` are retried; redirects are never followed.
- Discord delivery uses `wait=true`: a `200` is `sent`, a `204` is `accepted`. A `404`, a
  `410`, or a `401`/`403` whose body carries Discord's code `10015` or `50027` also **pauses the
  integration** (`enabled: false`, audit action `integration.auto_pause`, actor `null`, written
  in the same batch and only if that credential is still the stored one) so the next event
  does not repeat the request; replace the URL and re-enable it. Any other `401`/`403` is
  retried at most once more and never pauses it. Connection failures to a custom webhook are
  all recorded as `destination_unreachable`.
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

### Send a test notification

`POST /api/integrations/:id/test` sends a clearly labelled test message through the **real**
delivery path ([ADR 0018](adr/0018-test-send.md)): an ordinary delivery and outbox row, the same
dispatcher, consumer, URL policy and adapters as any event. Capability `integration.update`;
requires our `Origin` and `application/json`.

| Result | When |
| --- | --- |
| `202 {deliveryId}` | Queued. Nothing else is returned: no URL, credential or message body. Poll `GET /api/deliveries/:id`; the row has `isTest: true`. |
| `404` | No such integration in this workspace (identical for another workspace's id; consumes no rate-limit budget). |
| `409 {reason}` | `deletion_pending`, `disabled` (paused), `quarantined` (credentials need replacing), `test_in_flight` (an earlier test for this integration is still pending, claimed or retrying and was created in the last 15 minutes), or `unavailable` (it changed while the request ran). |
| `429` + `Retry-After` | More than 5 tests per integration, 20 per user, 30 per workspace, or 10 per destination host (across all workspaces) in a minute (`reason: "rate_limited"`). |

A test is never held or filtered because the route does not use those paths, not because of its event type: `test` and `noti.*` are reserved and refused (`400`) in a generic-webhook event's `type`. It is excluded from
the observability SLIs, stall detection, the Overview's 24 hour counts and the "real event" setup step, and it is
audited as `integration.test` (ids only). A replay of a test stays a test. The delivery state is
the destination's real answer: `sent` (confirmed), `accepted` (accepted without confirmation, as
with Teams), `retrying` or `dead_lettered` with the usual error code. For a custom webhook the error is one of two buckets only (`destination_unavailable`, `destination_unauthorized`), never the HTTP status class.

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
  `config_newer`, plus the noise-control codes under "Noise control" (`quiet_hours`, `digest`,
  `grouped`, `critical_bypass`, `hold_capacity`, which are always `delivered` rows). A
  routing-log row exists for every integration **with filters** that was
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
`{name, sourceId, destination, webhookUrl, signingSecret?}` (the response carries `signingSecret`
for a `generic_webhook` destination, as above). It receives every event its source
accepts. Sending `repo` or `eventTypes` with `sourceId` is `422`, as is a `sourceId` from another
workspace (indistinguishable from an unknown one). `PATCH` may rename, pause or replace
credentials on it, but a `repo` or `eventTypes` change is `422`.

## Noise control (quiet hours, grouping, summaries, resolved notices)

Per-integration settings that **delay and combine** updates; they never drop one
([ADR 0016](adr/0016-noise-control.md)). They apply to repository integrations and to source
integrations (generic, GitLab, Stripe). `noise` is a closed object; every key is optional:

```ts
type NoiseSettings = {
  timezone: string;                                   // IANA zone, e.g. "Asia/Ho_Chi_Minh"; default "UTC"
  quietHours: { start: string; end: string } | null;  // local "HH:MM"; may wrap midnight; start != end
  groupWindowSec: 0 | 60 | 300 | 900 | 3600;          // 0 = off (the default)
  digest: 'off' | 'hourly' | 'daily';
  digestAt: string;                                   // local "HH:MM"; used by the daily digest
  resolution: boolean;                                // "Resolved" notice when a failing workflow passes again
};
```

- `null`, absent and `{}` mean "none" and store `NULL`. Settings that change nothing also store
  `NULL`. Unknown keys, a zone the runtime does not know (including `+05:00` style offsets), equal
  quiet-hours times, a window off the menu and a weekly digest are `422` with dotted paths such as
  `noise.quietHours.end`; messages never echo input. At most 2 KiB is stored.
- **What happens to an update** (decided at ingress, after subscription and routing filters):
  1. A **critical** update is delivered at once, always. Critical means the source mapped it to
     status `failure`: a failed or timed-out GitHub workflow run, a generic event with severity
     `error` or `critical`, a failed GitLab pipeline or Stripe payment (or an event type starting
     `security.`).
  2. Otherwise, inside quiet hours it is **held** until they end (or the next summary boundary
     after that).
  3. Otherwise, with a summary on, it is held until the next hourly or daily boundary; a boundary
     inside quiet hours moves to the end of quiet hours.
  4. Otherwise, with a group window, it joins the open group for its **group key** or opens one.
     The key is `(organization, integration, event type, repository, subject)` where subject is the
     pull request or issue number, workflow run id, pushed branch, deployment or release tag; updates
     about different things are never combined.
  5. Otherwise it is delivered.
  If 500 updates are already waiting for the integration the update is delivered instead.
- A held update is stored as small display fields only (title, link, repo, actor, status, event
  type, summary line), never the payload. A cron job releases due updates through the normal outbox:
  one notification per group (the newest item, a count and a list capped at 5 with "and N more not
  shown"), a lone held update as itself, or one digest per integration (failures first, collapsed by
  group key with `(×N)`, capped at 10 entries per message and 1400 characters). A digest that does
  not fit one message is split into up to 3 ("part 1 of 3") before anything is left out, and the last
  one ends "and N more items not shown. Their details are not kept." when even that is not enough. A digest that would be empty is not sent. Released notifications are ordinary deliveries:
  retries, dead-lettering, replay and the delivery log apply.
- `resolution: true` (GitHub repository integrations only) sends **"Resolved: ..."** when a
  `workflow_run.success` follows a delivered failure of the same repository, workflow and head
  branch, even to an integration that follows failures only. It is `422` on `noise.resolution` for
  a source integration, and for a repository integration whose `eventTypes` contain neither
  `workflow_run.failure` nor `workflow_run.timed_out` (checked on create and on every update of
  either side). It defaults to **off**.
- Stored settings that are unreadable (`noiseInvalid`) or written by a newer release
  (`noiseNewer`) are **ignored and updates are delivered normally** (fail open, the opposite of
  filters); `PATCH` replaces them.
- The audit entry for a create or update lists feature names (`noise: ["quietHours","grouping"]`),
  never times, zones or windows. Deleting an integration (or a source with `cascade=true`) deletes
  what it was holding. Clearing the settings (`null` or `{}`) makes what is already held due at the
  next cron tick; changing them reschedules updates held for quiet hours or a digest to the next
  boundary under the new settings (or at once if none applies); grouped updates keep their window.
  At most 100 notifications are released per cron tick across all integrations. Updates of a disabled
  integration, or one with quarantined credentials, wait and release after it is enabled again. A
  held update that fails to release 5 times is dead-lettered (`failed`): kept 30 days, never released.

| Method and path | Capability | Result |
| --- | --- | --- |
| `GET /api/integrations/:id/noise-status` | `integration.read` | `200 {held: {count, nextReleaseAt}, failed}`: updates waiting for this integration, the earliest scheduled release (ISO) or `null`, and how many rows were dead-lettered after repeated release failures. Another workspace's integration is `404`. |

Ingress responses (`POST /webhooks/...`) add `held: <n>` when updates were held for some
integration of the event; a held update is not reported as `duplicate`.

Why an update was held or let through is recorded as a **reason code** in the routing log
(`outcome: "delivered"`, `reason`: `quiet_hours`, `digest`, `grouped`, `critical_bypass` or
`hold_capacity`) whether or not the integration has filters, and a released delivery in the
delivery log carries `heldReason` (`quiet_hours`, `digest`, `grouped` or `null`) and
`groupedCount` (how many held updates it stands for, `0` for an ordinary delivery).

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
  credentialFingerprint: string | null; // 8 base32 chars of a tenant-keyed HMAC of the secret (key FINGERPRINT_KEY); null if no key is configured or it was sealed before this release
  revoked: boolean;                   // the secret was revoked: the source is off until `rotate` enters a new one
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
| `POST /api/sources/:id/revoke-credentials` | optional `{reason?: 'compromised' \| 'no_longer_used' \| 'other'}` | **Admin only** (`source.revoke`). `200 {source}` with `revoked: true, enabled: false`: ingress answers `410 Gone` for it at once and `PATCH {enabled: true}` is `422` until `rotate` seals a new secret (which clears `revoked` and turns the source back on; a revoked GitLab or Stripe source refuses the same pasted credential with `422`). Repeating the call, or two racing calls, is a no-op (one audit entry). |
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
Unknown, malformed and wrong-kind endpoints answer one identical `404 Not found`; a paused, revoked or disabled
endpoint answers `410 Gone` (the sender is told to stop; it needs the unguessable endpoint id, ADR 0028).
Every non-2xx body is JSON and carries `correlation_id`, the same value as the `x-request-id` header
(never a signature, secret or payload).

| Situation | Answer |
| --- | --- |
| Credential missing, wrong, stale or malformed | `401 Unauthorized` (nothing is parsed or routed) |
| Authentic event, stored | `202 {accepted, persisted}` |
| Exact duplicate (the provider id was already accepted) | `200 {accepted, persisted: 0, duplicate: true}`, never a 4xx, so the sender stops retrying |
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
| `202 {accepted: true, persisted: n}` | Durably accepted for `n` integrations (`0` if the source has none). |
| `200 {accepted: true, persisted: 0, duplicate: true}` | A repeat of an already-accepted `webhook-id` with the same body (idempotent, nothing queued). |
| `400 {error, fields: [{field, message}]}` | Authentic but invalid JSON or event; names fields, never echoes values. |
| `409 {error: "webhook_id_reused"}` | This `webhook-id` was already accepted with a different body. Nothing was queued; the source's `reusedIdRejections` counter increments. Give every event its own id. |
| `401 Unauthorized` | Missing or malformed headers, wrong signature, or timestamp outside the window (all identical). |
| `404 Not found` | Unknown or malformed endpoint (identical). |
| `410 Gone` | The endpoint is paused or its credential was revoked: stop sending to it. |
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
| `GET /api/deliveries` | `delivery.read` | `{deliveries, nextCursor, guarantee}`. Query: `state`, `integrationId`, `correlationId` (exact match on the id minted at ingress, the `x-request-id` the sender got back; 4 to 64 characters of `A-Za-z0-9._:-`, `422` otherwise; workspace-scoped, readable by admins and members), `from`, `to` (ISO dates), `limit` (1–100, default 25), `cursor` (opaque, ordered by `(updated_at, id)` descending). Filter `state=dead_lettered` also matches legacy `failed` rows. `422` on a bad filter. |
| `GET /api/deliveries/summary` | `delivery.read` | `{windowHours: 24, counts}` by state for deliveries created in the last 24 hours. |
| `GET /api/deliveries/:id` | `delivery.read` | `{delivery, timeline, attempts, attemptDetail: "full" \| "summary", replays, guarantee}`. `attempts` is the per-attempt history, oldest first (see below); `attemptDetail` is `summary` for a delivery from before migration 0025, which has only the coarse `timeline`. |
| `POST /api/deliveries/replay-plan` | `delivery.replay` (admin) | Requires our `Origin` and `application/json`. Body `{integrationId?, from?, to?}` (`from`/`to` are `YYYY-MM-DD` or ISO). Writes nothing. `200 {plan: {eligible, total, totalCapped, remaining, bound: 200, token, typedConfirmationAbove: 20}}`. `422` on a bad filter, `429` past 6 a minute. |
| `POST /api/deliveries/replay` | `delivery.replay` (admin) | Body `{integrationId?, from?, to?, token, expectedCount}` from the plan. `202 {result: {requested, replayed, alreadyInFlight, refused, remaining}}`. `409 {reason: "plan_stale", eligible}` when the eligible set is no longer exactly the one the token names (nothing written), `409 nothing_to_replay`, `409` while workspace deletion is pending, `422 count_mismatch` when `expectedCount` is not the planned count, `429` past 6 a minute. At most 200 deliveries per request. Audited twice as `delivery.bulk_replay`: a `phase: started` row (requested count and filter) written before the first replay, so a failed audit write sends nothing (`503`, retry), and a `phase: finished` row with the counts, written after (best effort, logged). |
| `POST /api/deliveries/:id/replay` | `delivery.replay` (admin) | Requires our `Origin` and `application/json`. `202 {replay: {deliveryId, replayOf, created: true}}`; `200` with `created: false` while an earlier replay of the same delivery is queued or succeeded (idempotent). `409` if the delivery is not dead-lettered, already delivered, its original message is gone, its integration is deleted, paused or quarantined (`reason: "integration_unavailable"`), or workspace deletion is pending. `429` when rate limited. Audited as `delivery.replay`; the audit row commits in the same batch as the replay and exists only if a new replay row was created. |

Each delivery carries `isTest` (a test notification, ADR 0018); tests stay in the log, labelled, but are left out of `/summary`.

Each delivery also carries, from [ADR 0023](adr/0023-delivery-ledger-depth.md):

- `possibleDuplicate`: an earlier attempt ended without the provider confirming it (a timeout, a dropped
  connection, a 5xx, an expired claim) and the send was retried, so the destination MAY have shown the
  message twice. It is a possibility, never a count: Noti cannot know.
- `suppression`: `{reason: "duplicate" | "claim_conflict" | "provider_idempotency", duplicateOf}` on a
  `suppressed` row, the record of a repeat that was detected and not sent again. Today only `duplicate`
  is written, for a provider redelivery within the dedup window (7 days, `event_dedup`); the repeat is a
  row of its own, pointing at the original.
- `pausedReason`: `"circuit_open"` or `"destination_paced"` on a `retrying` delivery that has not been
  sent again yet because the destination keeps failing or asked to be left alone. No attempt is spent
  and nothing is dead-lettered by a short wait. After 24 hours with no real attempt it is dead-lettered
  (`destination_unavailable`, reason `circuit_open_timeout` or `destination_paced_timeout`) and can be
  redelivered. `suppression.originalState` is the state of the delivery a repeat repeats.

`attempts[]` entries: `{attempt, startedAt, durationMs, outcome: "delivered" | "accepted" |
"retry_scheduled" | "dead_lettered" | "deferred", error, detail, statusClass: "2xx" | "3xx" | "4xx" | "5xx" |
"timeout" | "network" | "none", retryAfterSeconds, providerMessageId, possibleDuplicate}`. `error` is the
usual taxonomy object, `detail` a code Noti minted (`provider_http_503`, `circuit_open`), never provider
text, a URL or a header. For a test sent to a custom webhook `statusClass` is `none` and `detail` null
(the class of a customer-chosen host's answer is a probing oracle). `deferred` rows are waits, not
attempts: `attempt` is the number of attempts already spent (0 when none), and `repeatCount` is how many
further identical waits were folded into the row (a long outage is one row). The history returns the newest
50 rows, oldest first, so the final outcome is never cut off. A `claim_expired` row is an attempt a crashed
consumer abandoned: it may have reached the provider. `providerMessageId` is always null today:
no adapter response carries one.

A replay never edits the original row (not even `updated_at`): it writes a new delivery with
`replayOf` set, so the log shows both. Each delivery carries `integrationStatus`
(`available`, `missing`, `disabled`, `quarantined`); `canReplay` is true only for
`available`. Reads are limited to 300 per minute per user and mutations to 30, both `429`
with `Retry-After`.

**Bulk replay.** The plan lists what a replay would send: dead-lettered, non-test deliveries of this
workspace whose integration is enabled and not quarantined, whose original message is still stored, and
whose latest replay (if any) is itself dead-lettered. `eligible` is at most `bound` (200); `total` is the
full count up to 10,000 (`totalCapped` says it stopped there). The `token` is a SHA-256 over the tenant,
the filter and the sorted ids: it detects that the set changed since it was shown; it is not a secret and not
a security boundary, and does not authorise anything. Only chain roots (`replayOf` null) are eligible, so a
replay that itself failed is never replayed on its own. A second run of the same plan finds nothing
eligible and replays nothing; two identical concurrent requests create each replay once.

## Setup progress

`GET /api/setup/progress` (`delivery.read`), **version 2** ([ADR 0025](adr/0025-setup-and-shell-ux.md), supersedes
the four-step model of [ADR 0018](adr/0018-test-send.md)). Derived from real rows on every request; nothing is
stored and the browser holds no step state, so a refresh, a second device and a shared link agree.

```ts
type SetupProgress = {
  version: 2;
  organizationId: string;
  steps: {
    id: 'workspace_created' | 'github_connected' | 'repositories_selected' | 'destination_connected'
      | 'events_chosen' | 'test_delivered' | 'activated';
    state: 'todo' | 'doing' | 'done' | 'blocked' | 'skipped';
    done: boolean;                       // true only for state 'done'
    optional: boolean;                   // events_chosen and activated never keep `complete` false
    verification: 'confirmed' | 'accepted' | null;   // test_delivered only
    since: string | null;                // ISO instant of the earliest evidence
    nextAction: 'connect_github' | 'pick_repository' | 'choose_destination' | 'refine_events' | 'send_test'
      | 'repair_integration' | 'resume_integration' | 'trigger_real_event' | 'none';
    blockedBy: 'github_app_not_configured' | 'github_not_connected' | 'credentials_quarantined'
      | 'integration_paused' | null;
  }[];
  complete: boolean;                     // every required step is done or skipped
  next: StepId | null;                   // first step still todo, doing or blocked
  nextAction: NextAction;                // the next step's action
  resume: { step: StepId; integrationId: string | null; point: string };   // where a returning person lands
  verifiedWindowDays: 30;
};
```

- `github_connected`: `done` with an **active** GitHub installation; `skipped` with none but another enabled
  source; `blocked` (`github_app_not_configured`) when this server has no GitHub App credentials.
- `repositories_selected` and `destination_connected` flip together when an integration exists (it is created in one
  request); the destination is `blocked` (`credentials_quarantined`) while its credentials are quarantined.
- `events_chosen` (optional): `done` when the newest integration has events other than the quiet default
  (`workflow_run.failure`, `workflow_run.timed_out`), filters, noise settings or a generic source; else `skipped`.
- `test_delivered`: a `sent` delivery (`confirmed`) or an `accepted` one (`accepted`, not confirmed shown) within 30
  days, test or real, to the **newest** integration, provided it is enabled and not quarantined. At most the newest
  500 deliveries of the window are read, so the cost does not grow with the ledger. `blocked` when the newest
  integration is paused or quarantined.
- `activated` (optional): any non-test delivery, in any state.
- Exactly one step is `doing` when `next` is a `todo` step; a `blocked` next step stays `blocked`. `resume.point`
  changes when the resume point does. Reads are limited to 120 per minute per user (`429` with `Retry-After`).

## Workspace export and deletion (admin)

| Method and path | Capability | Result |
| --- | --- | --- |
| `GET /api/workspace/export` | `workspace.export` | `200` JSON attachment, `format: "lumi-noti-export/v1"`, `credentialsIncluded: false`, at most the 2,000 most recent deliveries, delivery attempts and audit events (`truncated` says if older rows were left out). The export is audited. |
| `GET /api/workspace/deletion` | `workspace.delete` | `{scheduled: false}` or `{scheduled: true, requestedAt, purgeAfter, purgeStarted}` |
| `POST /api/workspace/deletion` | `workspace.delete` | Body `{confirm: "<workspace name>"}`. Returns `202`. Integrations are disabled immediately and the purge runs after 7 days. Returns `422` on a wrong confirmation and `409` if a deletion is already scheduled. |
| `DELETE /api/workspace/deletion` | `workspace.delete` | Cancels and restores the integrations that were enabled. Returns `409` once the purge has started. |

While a deletion is pending, integration and source mutations and `POST /api/github/install` return `409`.

## Your own data, sessions and account (any signed-in member)

These act on the caller's own identity only (the id comes from the session, never from the
request) and do not resolve a workspace, so `?org=` is ignored. Scope, decisions and limits are in
[`DSAR.md`](DSAR.md); the session routes are ADR 0030. Better Auth's own `list-sessions`, `revoke-session`,
`revoke-sessions` and `revoke-other-sessions` answer `404` through the Worker: they return session tokens, so they
are closed in favour of the audited routes below. Password reset ends every session; an absolute 90-day
lifetime from sign-in applies however often a session is used.

| Method and path | Result |
| --- | --- |
| `GET /api/workspace/me/sessions` | `200 {sessions: [{id, current, createdAt, lastActiveAt, expiresAt, ip, userAgent}]}`, newest activity first, at most 100, expired sessions left out, `Cache-Control: no-store`. `current` marks the session making the request. **No token or cookie value is ever returned**; `id` is an opaque handle that names only this person's sessions. `ip` is shortened (`203.0.113.x`). `lastActiveAt` is `updated_at`, which Better Auth moves at most daily. 120 a minute per person (`429`). `401` when signed out. |
| `POST /api/workspace/me/sessions/:id/revoke` | `Origin` required. Ends that one session at once and records `session.revoke` in the same D1 batch: `200 {revoked: 1}`. `404` for an id that does not exist, is malformed, or belongs to someone else (indistinguishable); `409 {error: "current_session"}` for the session making the request (that is signing out). 30 a minute per person with `revoke-others` (`429`). |
| `POST /api/workspace/me/sessions/revoke-others` | `Origin` required. Ends every session of the caller except the one making the request: `200 {revoked: n}` with the exact count. Records `session.revoke_others` only when `n > 0`. |
| `GET /api/workspace/me/data-export` | `200` JSON attachment, `format: "lumi-noti-account-export/v1"`, `credentialsIncluded: false`, `Cache-Control: no-store`. Contains the caller's user record, memberships, session metadata (no token), sign-in methods (provider and date only), passkey metadata (no keys), invitations they sent (no invitee address) and audit rows where they are the actor (IP address and user agent, no subject or metadata), at most 2,000 audit rows (`truncated` says if more exist). Limited to 5 per hour per user (`429` with `Retry-After`). A request the browser marks `Sec-Fetch-Site: cross-site` or `same-site` is refused (`403`). Audited as `account.export`. |
| `DELETE /api/workspace/me` | Body `{confirm: "<your account email>"}`, `Origin` and `application/json` required. `200 {deleted: true}` and `Clear-Site-Data: "cookies"`. `403 {error: "reauth_required"}` unless the session was created in the last 10 minutes (sign in again, then retry; nothing changes). The typed email is a misclick guard only. An email notice goes to the address on file before the delete. `422` on a wrong confirmation. `500` for a database fault (nothing deleted). `409` with `blockers: [{workspaceId, workspaceName, otherMembers, action: "transfer_admin_role" \| "delete_workspace"}]` while the caller is the only admin of any workspace; nothing is changed. `429` after 5 attempts an hour. Deletes the user, sessions, sign-in methods, passkeys and memberships, invitations addressed to their email and sent invitations that are not pending; pending invitations they sent are handed to another admin of the same workspace. There is no undo. Never deletes a workspace or any other member's data. Audited as `account.delete` in each workspace the person left. |

## Audit log (admin)

| Method and path | Capability | Result |
| --- | --- | --- |
| `GET /api/audit` | `audit.read` | `200` JSON, workspace-scoped, newest first, `Cache-Control: no-store`. A member gets `403 {"error":"Missing capability: audit.read"}` (audited). Limited to 120 requests a minute per user (`429` with `Retry-After`). |

Query: `limit` (1 to 100, default 25), `cursor` (the opaque `nextCursor` of the previous page, keyed on
`(created_at, id)`), `action` (one of the recorded action ids, `src/audit/actions.ts`), `outcome`
(`success` or `denied`), `from` and `to` (`YYYY-MM-DD`, the whole UTC day, or an ISO instant), and, since
ADR 0028:

- `actor`: a CURRENT member's user id, or `~system` for events no person took (no user id can start with `~`). Anyone who is not a member of
  this workspace (an outsider whose probe was recorded here, a former member) matches nothing, so the filter
  cannot be used to ask whether a user id ever touched the workspace. Ids come from `GET /api/workspace/team`.
- `target` and `targetType`: the id and kind (`integration`, `source`, `delivery`, `organization`,
  `capability`, `github_installation`, `repository`, `key`) of the thing the event is about.
- `correlationId`: the request id of one request (4 to 64 characters), as quoted from an error body, the
  `x-request-id` header or a delivery. Only changes made after migration 0028 carry one.

Anything invalid is `422 {"error":"Validation failed","fields":[...]}`. The first page (no `cursor`) also
carries `total`, the number of events the filters match in this workspace, counted up to 10,000
(`totalCapped: true` means "more than that"); later pages carry `total: null`. With no `from`, the count covers the last 90
days and `totalSince` (a UTC time) says so, otherwise `totalSince` is null. The count never fails the list: if it errors or
overruns 1.5 s the page still answers with `total: null, totalCapped: true`.

```ts
type AuditPage = {
  organizationId: string;
  events: {
    id: string;
    createdAt: string;                 // ISO 8601 UTC
    action: string;                    // e.g. 'integration.update', 'access.denied'
    subjectType: string;               // integration | source | delivery | organization | capability | github_installation | repository
    subjectId: string | null;          // an id, capability name or repository name, at most 120 characters
    outcome: 'success' | 'denied';
    actor:
      | { kind: 'member'; name: string }   // a CURRENT member of this workspace, name only
      | { kind: 'system' }                 // no actor (automatic)
      | { kind: 'former' }                 // a successful action by someone no longer a member
      | { kind: 'other' };                 // a refused request from someone who never was (an outsider's probe)
    summary: { key: string; value: string | number | boolean | string[] }[];  // allow-listed, bounded
    correlationId: string | null;      // the request the change was made in; null for older rows and jobs
    changes: (                          // before and after of a few NON-SECRET fields an update changed
      | { field: 'enabled' | 'repo'; kind: 'value'; before: string | boolean; after: string | boolean }
      | { field: 'eventTypes'; kind: 'list'; added: string[]; removed: string[] }
    )[];                                // empty for rows written before the diff existed
  }[];
  nextCursor: string | null;
  total: number | null;                // first page only; capped at 10,000
  totalCapped: boolean;
  totalSince: string | null;           // UTC start of the default 90-day count window, or null
  retentionDays: number;               // AUDIT_RETENTION_DAYS in force
};
```

What is **not** returned, deliberately: the actor's email or id, `ip`, `user_agent`, and any
`metadata_json` key that is not in the per-action allow-list (`SUMMARY_FIELDS` in
`src/api/audit-view.ts`). Strings are cut to 120 characters, lists to 10 items, and control and bidi
characters are removed. A webhook URL, a signing secret, a filter body or a name is never diffed: those
rows say only that the field changed. See ADR 0019 and ADR 0028.

**Fails closed.** A failed read, a failed limiter write or a row that is not this
workspace's answers `503 {error, correlation_id}` with no events and `Retry-After: 5`: never an empty or
partial list. The dashboard shows that as an error, not as "no events".

## Observability

| Method and path | Capability | Result |
| --- | --- | --- |
| `GET /api/observability/summary?window=24h` | `delivery.read` | `200` JSON, workspace-scoped, `Cache-Control: no-store`. `window` is `<n>h` or `<n>d` from `1h` to `30d` (default `24h`); anything else is `400`. Limited to 30 requests a minute per user (`429` with `Retry-After`). |

Each delivery view and the detail carry `correlationId` (string or `null` for rows older than migration 0027 and rows no request created). Every caller gets `jobsStatus` (`ok`, `degraded` or `unknown`). Platform operators only (user ids on the secret `PLATFORM_OPERATOR_USER_IDS`, comma separated, checked server-side; unset or empty means nobody, and a workspace admin is not an operator) also get `jobs: {name, lastOk, lastFailed, stale}[]` (epoch ms or `null`; `lastOk` is the last `ok` or `skipped` run; `stale` means more than three cadences overdue; platform-wide, names and times only; `null` if job state could not be read) and `alerting: {webhookConfigured, lastSuccessAt, lastFailureAt, consecutiveFailures}` (times and a count; never the URL).

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
  duplicates: { suppressed: number; rate: Ratio; possibleDuplicates: number }; // repeats recorded; retries after an unconfirmed attempt (an upper bound, not a count). Tests excluded.
  destinationHealth: { open: number; halfOpen: number; paced: number; deferredAttempts: number }; // current breaker and pacing state; deferrals in the window
  notMeasurable: { sli: string; reason: string }[];       // SLIs the ledger cannot support yet
};
type Latency = { samples: number; excluded: number; p50Ms: number | null; p95Ms: number | null; resolutionMs: 1000 };
```

Teams Workflows reaches `accepted`, never `sent`: the provider cannot confirm delivery, so it
is reported as `outcomeKind: "accepted"`. Latency is `last_attempt_at` minus `created_at`;
`created_at` has one-second resolution. Every response from the Worker carries an
`x-request-id` header (our own id; a caller-supplied one is only logged beside it).

## Health and readiness

Public, unauthenticated, `Cache-Control: no-store`, carrying the same security headers and
`x-request-id` as every response. Neither sends a queue message or makes an outbound call. Decisions:
[ADR 0022](adr/0022-credential-lifecycle-and-boot.md).

| Method and path | Success | Failure |
| --- | --- | --- |
| `GET /health` | `200 {ok: true, service: 'lumi-noti', warnings?: string[]}`. Configuration only: it does not touch D1, so it stays `200` while D1 is down. `warnings` names malformed optional bindings (`ENCRYPTION_KEY`, `FINGERPRINT_KEY`) or a second KEK without a check value. | `503 {ok: false, service, code: 'config_invalid' \| 'kek_environment_mismatch', misconfigured: string[]}`: binding **names** only (e.g. `KEK_V1`, `KEK_CHECK_V1`, `ENVIRONMENT_NAME`), never a value, length or prefix. |
| `GET /health/ready` | `200 {ok: true, checks: {config: true, d1: true, queue: true}}` | `503 {ok: false, checks: {...}}` with the failing checks `false`. `d1` is a `SELECT 1` bounded at 3 seconds; `queue` is a presence check of the binding; `config` is the `/health` check, without the names. The answer is cached for 5 seconds per isolate. |

What a configuration fault stops is tiered (docs/RUNBOOK.md, "What a configuration fault stops"):

- `DB` missing: every backend path except the two probes answers `503 {"error":"Service unavailable"}`
  with `Retry-After: 30`.
- A bad key ring, `ENVIRONMENT_NAME`, `KEK_CHECK_V<n>` or a KEK that does not match its environment: only
  the requests that seal or open a credential (`POST`/`PATCH`/`PUT` on `/api/integrations`,
  `/api/integrations/:id`, `/api/integrations/:id/test`, `/api/sources`, `/api/sources/:id`,
  `/api/sources/:id/rotate`) answer that 503. Webhook ingress, sign-in, reads, delete and revoke keep working.

A 503 from ingress is **not** reliably retried by the sender: GitHub does not automatically redeliver a
failed webhook (redeliver by hand from the App's Recent Deliveries), and GitLab disables a webhook after
repeated failures. That is why ingress is gated on nothing but D1.
