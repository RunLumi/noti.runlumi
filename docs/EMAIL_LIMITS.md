# Email platform limits and failure handling

Spec 15 F235. Email is a supporting channel (verification, password reset, invitations, security notices), not a
notification destination. This page records the Cloudflare Email Sending limits that shape that decision and what the code
does when a send fails. The limits were read on **2026-10-13** by the spec author from
[email-service/platform/limits](https://developers.cloudflare.com/email-service/platform/limits/) and
[pricing](https://developers.cloudflare.com/email-service/platform/pricing/); they were **not re-read** when this page was
written. Any change to those pages invalidates the table; re-read it before launch and every 180 days (the F229 discipline).

## Limits that matter to us

| Constraint | Value as read | Consequence |
| --- | --- | --- |
| Recipients before a sending domain is onboarded | verified destination addresses only | new sign-ups cannot be mailed until the domain is onboarded |
| Verified destination addresses per account | 200, shared across domains | cannot rely on per-address verification at scale |
| Sending domains | only the account's routing domains | the From domain is ours (`AUTH_FROM_EMAIL`, `noreply@runlumi.app` in `wrangler.jsonc`); never a customer's |
| Outbound sending | Workers Paid; 3,000 per month included, then a per-1,000 price | verification, reset and invitation mail is a growth constraint (about 100 sign-ups a month at three messages each) |
| Sends to verified destinations | do not count toward the quota | |
| Recipients per message | 50 combined | invitation fan-out must chunk (we send one recipient per message) |
| Message size | 5 MiB (25 MiB to verified destinations) | no attachments; our messages are short plain text |
| Suppression list | one active entry per address and scope; paging and bulk-import limits | bouncing addresses must be suppressed, not retried |
| `send_email` binding in Email Routing summaries | shown as "dropped" even when delivered | never build deliverability or suppression logic on Email Routing data |

**UNVERIFIED:** the DKIM and SPF records a sending domain needs. The Cloudflare page the spec pointed at returned 404 on
2026-10-13. Read the current Email Service configuration documentation and record record names and the date before writing
setup instructions. Whether the domain `runlumi.app` is onboarded for sending in any environment is also not known from the repository.

## What the code does today

`src/auth/email.ts` sends plain text only (no HTML, so nothing from a request becomes markup), from a server-controlled
sender, and refuses a link whose origin is not ours. It calls `env.AUTH_EMAIL.send(...)` and lets a rejection propagate to
the caller. There is **no** quota counter, no suppression list, no bounce or complaint handling and no retry for email.

Two messages are best-effort security notices rather than part of a flow: the account-deletion notice
(`src/api/account.ts`) and, since ADR 0053, the password-changed notice sent after a successful reset
(`src/auth/better-auth.ts`, `onPasswordReset`). A failure to send either is logged (`account_deletion_notice_failed`,
`password_changed_notice_failed`, or `background_task_failed` when the send runs after the response) and never undoes
the action. Each successful reset therefore costs two messages against the quota: the link and the notice.

Failure behaviour by design (target, partly built):

| Condition | Required behaviour | Built? |
| --- | --- | --- |
| Binding rejects (unverified address, no sending domain, quota exhausted) | the action fails with a clear message; the failure is not reported as success and is not retried in a loop that cannot succeed | rejection propagates; per-action message wording is not tested for every flow |
| Hard bounce or complaint | add to a suppression list; never send to it again | not built |
| Quota nearing exhaustion | alert at 50% of the monthly figure (AR-7) | not built |
| Address in logs | redacted by default | covered by the log redaction layer; no email-specific test |

Because nothing is suppressed or counted, an operator reading this must not assume deliverability is managed. At the volume
of a prototype it does not matter; it matters once real sign-ups arrive.

## Obligations

Verification, reset and invitation mail is transactional. Anything recurring (digests by email, marketing) would need an
unsubscribe mechanism and a suppression path under the anti-spam laws the Cloudflare page names (CAN-SPAM, GDPR, CASL). Not
a legal opinion; take advice before sending anything that is not transactional. Email is **not** an event destination in
V1; if it becomes one it inherits the egress policy (ADR 0026) and a recipient address is user-supplied content sent to a third party.

## Revisit when

- Sign-ups approach 50% of the monthly quota, or the 200 verified-address cap is hit.
- A sending domain is onboarded: record DKIM and SPF names and the date.
- Email becomes a destination or a recurring message type.
