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
