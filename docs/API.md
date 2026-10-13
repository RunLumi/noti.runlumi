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
  destination: 'lark' | 'slack';
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
| `POST /api/integrations` | `{name, repo, eventTypes, destination, webhookUrl, signingSecret?}` | `201 {integration}`; `409` at 100 per workspace |
| `PATCH /api/integrations/:id` | any of `{name, repo, eventTypes, enabled}`, and/or `{webhookUrl, signingSecret?}` to rotate credentials | `200 {integration}` |
| `DELETE /api/integrations/:id` | — | `204` |

Validation failures return `422 {"error":"Validation failed","fields":[{field,message}]}`. Every
invalid field is reported at once. Messages never echo the submitted value.

Rules enforced at write time:

- `webhookUrl` must pass the same allowlist used before every send:
  - Slack: `https://hooks.slack.com/services/…`.
  - Lark: `https://open.larksuite.com/open-apis/bot/v2/hook/…` or the `open.feishu.cn`
    equivalent.
  - No userinfo, no explicit port, no other host.
- `signingSecret` is Lark only. It is optional, at most 256 characters, with no whitespace.
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
| `GET /api/github/installations` | `integration.read` | `200 {configured, installations: [{id, account, accountType, repositorySelection, status, updatedAt, repositories: string[]}]}` |
| `GET /github/setup` | session | GitHub's setup redirect. Continues to GitHub OAuth. |
| `GET /github/callback` | session | GitHub's OAuth redirect. Verifies and binds, then redirects to `/integrations?github=<status>`. |

`status` is one of:

- `connected`
- `state_invalid`
- `state_user_mismatch`
- `installation_id_invalid`
- `oauth_failed`
- `installation_not_accessible`
- `installation_bound_elsewhere`
- `github_unavailable`
- `not_configured`
- `signin_required`

An integration's `repo` must be covered by an active installation in the workspace. Otherwise
the request gets `422` with a `repo` field error. The stored value uses GitHub's casing.
