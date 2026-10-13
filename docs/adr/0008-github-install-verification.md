# ADR 0008: Bind GitHub installations only after verifying the installer's access

Status: Accepted · Date: 2026-10-13 · Implements F56, F57, F67, F68 · Amends F55

## Context

GitHub redirects to our Setup URL with `installation_id` in the query string. GitHub's own
documentation (read 2026-10-13, "About the setup URL") says:

> Bad actors can hit this URL with a spoofed `installation_id` … you should not rely on the
> validity of the `installation_id` parameter. Instead, generate a user access token for the
> user who installed the GitHub App and then check that the installation is associated with
> that user.

Spec F56 proposed binding the workspace from the signed `installation.created` webhook. That
webhook proves the installation exists, but not *which* workspace's user created it. An
attacker who pre-claims a victim's installation id, or completes the redirect first, could
end up bound to that installation. F55 also turned OAuth off entirely. With OAuth off, the
check GitHub recommends is impossible.

## Decision

1. **Two single-use states, stored only as SHA-256.** Each expires after 10 minutes and is
   bound to the user who started the flow.
   - The `install` state is created by `POST /api/github/install` and carried through
     `github.com/apps/<slug>/installations/new`.
   - The `verify` state carries the *claimed* installation id and a PKCE verifier.
   - Consumption is one conditional `UPDATE ... WHERE used_at IS NULL AND expires_at > now`.
     Of two concurrent callbacks, only one succeeds.
   - A state presented by a different signed-in user is refused.
2. **Setup URL → OAuth (PKCE S256) → callback.**
   - The callback exchanges the code.
   - It pages `GET /user/installations` and requires an entry whose `id` equals the claimed id
     **and** whose `app_id` equals ours.
   - It reads `/user/installations/{id}/repositories` for the initial repository set.
   - It then revokes the user token (`DELETE /applications/{client_id}/token`). The token is
     never stored.
   - This amends F55: "Request user authorization during installation" stays **off**, so the
     Setup URL keeps working, but the App has a Callback URL and a client secret.
3. **Bind once.**
   - An installation already bound to a different workspace is refused and audited.
   - The `github_installations_no_rebind` trigger makes a silent rebind impossible even for
     code that forgets this check.
   - Unbinding will be an explicit, audited, admin-only action (not built).
4. **Lifecycle events are state changes, never routes (F68).**
   - `installation.suspend|unsuspend|deleted|created|new_permissions_accepted` and
     `installation_repositories.added|removed` update status or the repository set in one
     batch, together with an audit row.
   - Events for installations nobody has bound are acknowledged and ignored.
   - `ping` is acknowledged.
5. **Repository scope (F67).**
   - For `selected` installations, ingress refuses and audits a repository outside the synced
     set.
   - Integrations may only name a repository an active installation covers. For a `selected`
     installation that means a listed repository; for `all`, it means the installation's
     account is the owner.
   - The canonical GitHub casing is stored.

## Consequences

- One extra GitHub screen during install: the OAuth consent. It is a one-time cost, and the
  GitHub docs recommend it.
- We need a client secret (a Worker secret). We still need no App private key, because
  nothing calls the API as the App yet.
- Everything fails closed while the App is unconfigured. Install returns `503`, the browser
  routes redirect with `not_configured`, and ingress returns `403`.
- SAML-protected organisations: GitHub only lists their installations to a user with an
  active SAML session. Such a user sees `installation_not_accessible` and must sign in to the
  organisation first. This needs a help-text line in the UI.

## Not done

- Reconciliation and backfill (F69), permission reads from `GET /app` (F61), and caching
  installation tokens (F66).
- An unbind or transfer action, and a dashboard notice when an installation is suspended.
- Real-GitHub acceptance. Everything above is tested against mocked GitHub endpoints over
  the real migrations.
