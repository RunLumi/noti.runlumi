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
- A body of at most 16 KiB. Otherwise the response is `413`.

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
| `GET /api/integrations` | — | `200 {organizationId, integrations: Integration[]}` (max 200) |
| `GET /api/integrations/:id` | — | `200 {integration}` |
| `POST /api/integrations` | `{name, repo, eventTypes, destination, webhookUrl, signingSecret?}` | `201 {integration}` |
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
D1 batch as the change.
