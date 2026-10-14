# Subprocessors and data flows

Every external party this codebase sends data to or relies on to hold it, derived from the
code as of 2026-10-14. **It is an engineering inventory, not a published subprocessor list and
not a legal document.** Fields marked _operator to complete_ (legal entity, contract or DPA,
processing region, transfer mechanism, retention at the provider) are not knowable from the
repository and are left blank on purpose. Nothing here says a provider is compliant with
anything. No formal security audit has been performed.

Retention inside our own database is in [`DATA_RETENTION.md`](DATA_RETENTION.md). Subject
access and erasure are in [`DSAR.md`](DSAR.md).

## Where the data goes

| Recipient | Role | What it receives from us | Code | Contract, DPA, region |
| --- | --- | --- | --- | --- |
| Cloudflare Workers | Runs all of our code | Everything we process, in memory | `src/worker.ts`, `src/index.ts` | _operator to complete_ |
| Cloudflare D1 | Primary database | Every table in `DATA_RETENTION.md`; sealed credentials are encrypted before they reach it | `migrations/`, `src/db/schema.ts` | _operator to complete_ (D1 location is chosen when the database is created) |
| Cloudflare Queues | Delivery and dead-letter queues | Ids and display text (title, link, repository, sender login, summary). Never a credential or a raw provider payload (F173) | `src/pipeline/outbox.ts`, `src/pipeline/consumer.ts` | _operator to complete_ |
| Cloudflare static assets | Serves the dashboard build and `security.txt` | Nothing about people; it serves public files | `wrangler.jsonc` `assets`, `src/web/shell.ts` | _operator to complete_ |
| Cloudflare Email Sending | Sends verification, password-reset and invitation emails | Recipient address, subject, a one-time link (text only, no HTML) | `src/auth/email.ts` | _operator to complete_ |
| Cloudflare Workers logs | Operational logs | Redacted lines: correlation id, counts, error categories; no payloads, URLs or tokens by design | `src/platform/log.ts`, `src/platform/redact.ts` | _operator to complete_ (retention is an account setting) |
| Cloudflare DNS over HTTPS (`cloudflare-dns.com/dns-query`) | Resolver for the customer-webhook host check | The hostname a customer typed, at save time, when the customer-webhook destination is on. Disabled by default (`GENERIC_WEBHOOK_ENABLED` is `"false"`) | `src/connectors/destinations/dns-check.ts` | _operator to complete_ |
| GitHub (`github.com`, `api.github.com`) | Identity of the person connecting an installation, and installation facts | OAuth code, client id and secret, PKCE verifier; then the person's short-lived user token as a bearer for `GET /user`, `/user/installations`, `/user/memberships/orgs/{org}` and the installation's repository list; and a request to revoke that token afterwards | `src/connectors/sources/github/install.ts` | _operator to complete_; GitHub is the person's own account provider, so GitHub has its own relationship with them |
| Slack (`hooks.slack.com`) | Destination | The rendered notification | `src/connectors/destinations/slack/` | The customer's Slack workspace; _operator to complete_ |
| Lark or Feishu (`open.larksuite.com`, `open.feishu.cn`) | Destination | The rendered notification as a card, with a signature over a timestamp when a signing secret is set | `src/connectors/destinations/lark/` | The customer's tenant. `feishu.cn` is the China-region service; which one receives data is the customer's choice per destination |
| Microsoft Teams (`*.logic.azure.com`, Workflows) | Destination | The rendered notification as an Adaptive Card | `src/connectors/destinations/teams/` | The customer's Microsoft tenant |
| Discord (`discord.com`) | Destination | The rendered notification | `src/connectors/destinations/discord/` | The customer's Discord server |
| A customer's own HTTPS endpoint | Destination, off by default | A signed JSON event: title, event type, link, repository, sender login, status, summary, delivery id, time and an opaque workspace id. Never a credential | `src/connectors/destinations/generic-webhook/` | The customer; any host, subject to the SSRF policy (AR-30) |
| AI providers | None | Nothing. No AI feature exists (specs 16 are not built) and no model or AI binding is configured | none | n/a |
| Analytics, error tracking, advertising | None | Nothing. No third-party script or beacon is loaded; fonts are self-hosted (`@fontsource-variable/geist`) | `web/` | n/a |

"The rendered notification" is exactly the fields we build for display: a title, a link back to
the source, a repository name, the sender's login, a status, an event type and a short summary
(at most 280 characters, 1,400 for a grouped or digest message). That is notification text a
customer chose to route, so it can contain whatever their source put in a title: a pull request
name, a commit subject, a person's GitHub login.

## What is never sent to a destination

- Destination credentials (other destinations' URLs and secrets), our key material, session
  tokens, or anything from another workspace.
- The raw provider payload (full webhook body). Only the fields above are extracted.
- Internal ids, except the delivery id and an opaque workspace id in the customer-webhook event.
- Email addresses or names of members (the sender's source login is the only person-like field).

## What comes in (not subprocessors)

These send data **to** us. They are not recipients, but they are where notification content
originates.

| Source | What we receive | Authentication |
| --- | --- | --- |
| GitHub App webhooks (`POST /webhooks/github`) | Event payloads for installed repositories, including private repositories | HMAC over the raw body, App id, installation binding |
| Generic signed webhook, GitLab, Stripe (`/webhooks/{kind}/:endpointId`) | Event payloads the customer sends or configures | Standard Webhooks signature, GitLab token or signature, Stripe signature |

We keep only the extracted display fields, never the full payload (`DATA_RETENTION.md`,
`notification_outbox`).

## Not a subprocessor of customer data

- **CI** runs on GitHub Actions against test fixtures. The workflows are read-only and hold no
  deploy credential (`tests/security/config-guards.test.ts`). This is a statement about the
  workflow files, not about what an operator may later configure.
- **Package registries and Dependabot** supply code, not customer data.

## For the operator to complete

None of the following is decided in this repository.

1. The contracting entity for each row, whether a data processing agreement exists with it, and
   where it is signed.
2. The processing region of D1, Queues and Workers, and any transfer mechanism that follows.
3. Which rows the operator will list publicly as subprocessors, and the notice period for
   changes. Adding a recipient (for example an email provider if Email Sending limits bite, AR-7,
   or an AI provider) must update this file in the same pull request.
4. Whether Lark/Feishu region and other customer-chosen destinations are disclosed as the
   customer's own recipients rather than ours.
