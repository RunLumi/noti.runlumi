# Data-subject requests: access and erasure

Engineering record of what Lumi Noti can do today when a person asks to see or delete their
personal data (spec 15 F238). **This is not legal advice and not a privacy policy.** Which
legal regime applies, the response deadline, and whether Lumi acts as controller or processor
for any given data are **to be decided by the operator** with qualified advice. The commonly
cited GDPR articles are only pointers (spec 15 F238); their text and deadlines were not
re-verified here and are deliberately not restated. No formal security audit has been performed.

What is held, why and for how long is generated from code in
[`DATA_RETENTION.md`](DATA_RETENTION.md). Where each recipient of data sits is in
[`SUBPROCESSORS.md`](SUBPROCESSORS.md).

## What exists

| Right (plain words) | Mechanism | Status |
| --- | --- | --- |
| See my data | `GET /api/workspace/me/data-export` (any signed-in member) | built, tested over the Node SQLite D1 fake |
| Take my data with me | Same endpoint (JSON). Workspace content: an admin's `GET /api/workspace/export` | built |
| Delete my account | `DELETE /api/workspace/me` | built, tested over the fake |
| Delete a workspace and its data | Admin: two-phase deletion, 7-day grace, then purge (`POST /api/workspace/deletion`; see `docs/SECURITY.md`, "Data deletion") | built (slice W) |
| Correct my data | Better Auth profile update; no Lumi UI | not built here |
| Restrict or object to processing | No mechanism | not built; operator to decide |
| A request that cannot be done in the product | Operator procedure in [`RUNBOOK.md`](RUNBOOK.md), "Data-subject requests" | written, never rehearsed |

Requests are fulfilled through the signed-in product, so identity is already established. An
emailed request must be verified against the signed-in account before anything is disclosed.

## Access: what the account export contains, and why

`GET /api/workspace/me/data-export` answers for the caller only. The user id comes from the verified
session, never from the request, so it cannot be pointed at someone else. It is read-only
(a plain GET changes nothing except an audit row and a rate-limit counter), returns
`Cache-Control: no-store` and a download header, is limited to 5 per hour per person, and is
audited as `account.export`. Cross-site pages cannot read it: the API sets no CORS headers.

| Section | Included | Left out on purpose |
| --- | --- | --- |
| `user` | id, name, email, verified flag, image, dates | nothing |
| `memberships` | workspace id and name, role, joined date | other members |
| `sessions` | created, updated, expiry, IP address, user agent, active workspace | the token and the row id (a session token is a usable credential, AR-1) |
| `signInMethods` | provider (for example `credential`) and creation date | password hash, OAuth tokens |
| `passkeys` | name, device type, backup flag, transports, creation date | public key, credential id, counter |
| `invitationsSent` | workspace id, role, status, dates | the invitee address (a third party's data) |
| `auditEventsAsActor` | rows where the person is the actor: workspace id, action, subject type, outcome, **IP address, user agent**, time; newest 2,000 | `subject_id` and `metadata_json` |

**Decision: audit rows.** Audit rows where the person acted are personal data about them (their
IP address and user agent), so they are included, from every workspace including ones the person
has since left. The object the action touched and its metadata are not: those describe
workspace objects (integration ids, destination hosts, repository names), which belong to the
workspace and which its admins already receive through the workspace export and the audit log.
A person who is not an admin therefore never receives workspace configuration through this
endpoint. Nothing about any other person is included.

**Not in the account export:** workspace content. Notification text (`notification_outbox`,
`held_events`), integrations, deliveries and sources belong to the workspace; admins export them
with `GET /api/workspace/export`. Notification content can carry a GitHub login or a commit
title that names a person; there is no per-person search of it, and this is a known gap
(listed in `DATA_RETENTION.md`).

## Erasure: what `DELETE /api/workspace/me` does

Requires a signed-in, email-verified session, a same-origin request, JSON, and the account email
typed as confirmation (`{confirm}`; 422 otherwise). Limited to 5 attempts per hour.

1. **Refuses (409) while the person is the only admin of any workspace**, naming each one and the
   way out: `transfer_admin_role` (the workspace has other members: make one an admin first) or
   `delete_workspace` (the person is the only member: schedule the workspace for deletion and wait
   for the purge). Nothing is changed. This follows the database's last-admin trigger, which would
   refuse the delete anyway; the check exists so the answer is a plain explanation.
2. Otherwise, in one transaction: writes one `account.delete` audit row per workspace the person
   leaves, deletes pending GitHub install states they started, deletes invitations addressed to
   their email, and deletes the `user` row, which cascades to sessions, sign-in methods, passkeys,
   memberships and invitations they sent.
3. **Never deletes a workspace, or any other member's data.** A workspace with other members
   keeps everything: integrations, sources, deliveries, notification content. Those belong to
   the workspace. Only the person's membership goes.
4. The response carries `Clear-Site-Data: "cookies"` so the browser drops the dead session cookie.

**Pseudonymisation, stated plainly.** After erasure the person's row no longer exists, so an
opaque id left behind in other tables no longer resolves to a name or email:
`audit_events.actor_id`, `integrations.created_by`, `sources.created_by`,
`github_installations.bound_by`, `workspace_deletions.requested_by`. The audit dashboard shows
such an actor as a former member. That is pseudonymisation, not anonymisation: the id is still a
stable identifier within those rows.

**What survives erasure, and the operator decision it forces.**

- **Audit rows keep the actor id, IP address and user agent** until `AUDIT_RETENTION_DAYS`
  (default 365). The audit log is append-only and a database trigger refuses every `UPDATE`
  (migration 0008), so the rows are not scrubbed. Whether that retention is acceptable against the
  erasure obligation (for example as security logging) is a legal call for the operator;
  until decided it is recorded as accepted risk AR-40. If the operator decides IP and user agent
  must go, the options are a shorter audit retention or a migration that makes the scrub explicit.
- **D1 Time Travel** can restore the database to a point before the erasure for a period set by
  Cloudflare (`docs/SECURITY.md` records up to 30 days). A deleted row is therefore not erased from
  that history until the window passes (AR-6). Do not tell a person otherwise.
- **Cloudflare Queues, logs and Email Sending records** are Cloudflare-retained
  (`DATA_RETENTION.md`, "Stores outside D1").
- **Short-lived verification records** that are still valid at the time survive until they
  expire; the hourly `expired_auth_purge` removes them afterwards.
- **Destination providers** (Slack, Lark, Teams, Discord, a customer's endpoint) keep whatever
  notification text they already received. Lumi cannot delete it. See `SUBPROCESSORS.md`.

## Not done

- A fresh-sign-in step before erasure. The typed email is the only re-confirmation (AR-41).
- Correction and restriction mechanisms in the product.
- A person-level search across notification content.
- Statutory response deadlines, a request log with a due date, and a privacy-contact address.
  There is no address in this repository (`SECURITY.md` uses GitHub private reporting), so none
  is invented.
- A Data Processing Agreement template, legal review, and the controller/processor decision.
- Any test against a real Cloudflare D1 or a real Better Auth session. The tests fake the session
  with a header and run the real route over the real migrations on Node SQLite.
