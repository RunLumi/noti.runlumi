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
  createdAt: string | null;
  updatedAt: string | null;
};
```

| Method and path | Body | Success |
| --- | --- | --- |
| `GET /api/integrations` | — | `200 {organizationId, integrations: Integration[], truncated}` (max 200) |
| `GET /api/integrations/:id` | — | `200 {integration}` |
| `POST /api/integrations` | `{name, repo, eventTypes, destination, webhookUrl, signingSecret?, triggerAuth?}` | `201 {integration}`; `409` at 100 per workspace |
| `PATCH /api/integrations/:id` | any of `{name, repo, eventTypes, enabled}`, and/or `{webhookUrl, signingSecret?, triggerAuth?}` to rotate credentials | `200 {integration}` |
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
| `POST /api/deliveries/:id/replay` | `delivery.replay` (admin) | Requires our `Origin` and `application/json`. `202 {replay: {deliveryId, replayOf, created: true}}`; `200` with `created: false` while an earlier replay of the same delivery is queued or succeeded (idempotent). `409` if the delivery is not dead-lettered, already delivered, its original message is gone, or workspace deletion is pending. `429` when rate limited. Audited as `delivery.replay`. |

A replay never edits the original row: it writes a new delivery with `replayOf` set, so the
log shows both.

## Workspace export and deletion (admin)

| Method and path | Capability | Result |
| --- | --- | --- |
| `GET /api/workspace/export` | `workspace.export` | `200` JSON attachment, `format: "lumi-noti-export/v1"`, `credentialsIncluded: false`, at most the 2,000 most recent deliveries and audit events (`truncated` says if older rows were left out). The export is audited. |
| `GET /api/workspace/deletion` | `workspace.delete` | `{scheduled: false}` or `{scheduled: true, requestedAt, purgeAfter, purgeStarted}` |
| `POST /api/workspace/deletion` | `workspace.delete` | Body `{confirm: "<workspace name>"}`. Returns `202`. Integrations are disabled immediately and the purge runs after 7 days. Returns `422` on a wrong confirmation and `409` if a deletion is already scheduled. |
| `DELETE /api/workspace/deletion` | `workspace.delete` | Cancels and restores the integrations that were enabled. Returns `409` once the purge has started. |

While a deletion is pending, integration mutations and `POST /api/github/install` return `409`.
