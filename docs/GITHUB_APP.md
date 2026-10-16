# Registering the Noti GitHub App

Noti receives GitHub events through a **GitHub App**, not repository webhooks. Repository
webhooks carry no tenant identifier, need repo-admin access to create, and need a secret
each (F55). Register one App per environment: staging and production are separate
registrations with separate keys.

## Settings

| Setting | Value |
| --- | --- |
| Homepage URL | `https://noti.runlumi.app` |
| **Callback URL** | `https://noti.runlumi.app/github/callback` (exactly; no extra parameters) |
| Expire user authorization tokens | ✅ on |
| **Request user authorization (OAuth) during installation** | ❌ off. Noti runs its own OAuth step after the setup redirect (ADR 0008). |
| Enable Device Flow | ❌ off |
| **Setup URL** | `https://noti.runlumi.app/github/setup` |
| **Redirect on update** | ✅ on |
| Webhook | ✅ active, URL `https://noti.runlumi.app/webhooks/github` |
| Webhook secret | 32+ random bytes, stored as `GITHUB_WEBHOOK_SECRET` |
| Where can this App be installed? | **Any account** (public). "Only on this account" cannot be installed by customers. |

### Permissions: read-only, the documented minimum (F61)

| Permission | Access | Why, in the words the install screen should use |
| --- | --- | --- |
| Metadata | Read (mandatory) | See repository names so you can choose which ones notify you. |
| Issues | Read | Tell you when issues are opened, closed or commented on. |
| Pull requests | Read | Tell you when pull requests are opened, reviewed or merged. |
| Actions | Read | Tell you when a workflow run fails or succeeds. |
| Contents | Read | Tell you about pushes and published releases. GitHub gates these events on this permission, which technically allows reading files. Noti makes no API call that reads them. |
| Deployments | Read | Tell you about deployment status changes. |
| Organization → Members | Read | Confirm that the person connecting an organization is one of its admins, so a regular member cannot route the whole organization's events into their own workspace. |

⚠️ UNVERIFIED: whether `GET /user/memberships/orgs/{org}` needs **Members: Read** for a
GitHub App user token. GitHub's REST page does not name a permission. Check it on the staging
App. If the call returns 403, the flow refuses with `installation_admin_required`, which
fails closed.

**Never request write access.** A notification router that can write to a repository is a
supply-chain risk. GitHub's install screen always says the App can read public
repositories. That line is fixed, and we do not claim otherwise.

### Events to subscribe to

`Issues`, `Issue comment`, `Pull request`, `Pull request review`,
`Pull request review comment`, `Push`, `Release`, `Workflow run`, `Deployment status`.

`installation` and `installation_repositories` are delivered without subscribing and cannot
be turned off. They are how Noti learns about suspension, uninstall and repository changes
(F68).

## Worker configuration

| Name | Kind | Value |
| --- | --- | --- |
| `GITHUB_APP_ID` | var | the numeric App ID |
| `GITHUB_APP_SLUG` | var | the slug from `github.com/apps/<slug>` |
| `GITHUB_CLIENT_ID` | var | the App's Client ID (it starts with `Iv`) |
| `GITHUB_CLIENT_SECRET` | **secret** | `wrangler secret put GITHUB_CLIENT_SECRET` |
| `GITHUB_WEBHOOK_SECRET` | **secret** | `wrangler secret put GITHUB_WEBHOOK_SECRET` |

While any of these is still a placeholder:

- `POST /api/github/install` returns `503`.
- The setup and callback routes redirect to `/integrations?github=not_configured`.
- Webhook ingress refuses events from unknown installations with `403`.

All three fail closed.

The App's private key is **not** needed yet. Noti does not call the GitHub API as the App
until reconciliation (F69) and permission reads (F61) are built.

## Routing

`/github/setup` and `/github/callback` must reach the Worker, not the SPA. Route them the
same way as `/api/*` and `/webhooks/*`. The Vite dev server proxies them in development.


## Production registration — 2026-10-16

- Owner: `RunLumi`; name: **Lumi Noti**; slug: `lumi-noti`.
- Public page: https://github.com/apps/lumi-noti
- App ID: `5340232`; Client ID: `Iv23lip5fWsTE0SnewIa` (both public identifiers).
- Read-only permissions and all nine subscriptions above were read back from GitHub's public App API.
- Callback/setup URLs match the values above. Active webhook settings were verified after a reload.
  Real GitHub ping delivery `b84b9f66-c916-11f1-904b-548d191f79de` returned 202; a tampered live fixture
  request returned 401. This verifies signed ingress, not OAuth verification or destination delivery.
- `GITHUB_CLIENT_SECRET` and `GITHUB_WEBHOOK_SECRET` were generated and installed as Worker secrets;
  their values were not printed or committed. The mode-0600 temporary upload file was removed after
  Cloudflare confirmed both writes. No separate backup is claimed.

No private key was generated: the current runtime does not consume one, and the installation permission
review page is available without one. A GitHub registration reminder alone is not proof of a runtime
private-key requirement. The dashboard now starts with OAuth discovery so an already-installed App can
be verified without changing its repository permissions. See ADR 0038 for the runtime redirect fix,
account choice, state boundaries and remaining live acceptance checks.
