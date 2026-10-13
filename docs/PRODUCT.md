# Product requirements

## Audience
1. Nontechnical owner/operator: needs understandable setup and useful notifications, not webhook jargon.
2. Engineering lead: needs GitHub CI/PR routing, reliability and control over noise.
3. IT administrator: needs access control, credential governance, auditability and retention.
4. Agency/operator: needs many customer workspaces without cross-tenant leaks.

## Core user journey
Create workspace → choose source → connect with least privilege → select event types → add optional filters → choose one or more destinations → choose previewable format → send test → activate → inspect deliveries and failures. Make setup progress recoverable and show the exact next step.

## V1 scope
- Workspace login, roles (owner/admin/member), integration CRUD and disable/enable.
- GitHub signed webhooks (manual repo webhook as initial wedge; GitHub App after proving value).
- Issue opened/edited/closed; comments; PR opened/updated/reviewed/merged; workflow run completed with success/failure; push.
- Lark, Slack and Teams destinations with verified setup and format-specific capabilities.
- Event filtering by repository, action, branch, actor and status; suppress bots by option.
- Test delivery, delivery log, retries, duplicate suppression, failure visibility.
- Secure per-tenant credentials and quotas, responsive accessible dashboard.

## Non-goals
Full automation workflows, inbound email parsing, cross-system synchronization, AI-generated facts, unrestricted custom code, marketplace, billing before validated demand.

## Success thresholds (initial hypotheses, not measured)
- Median successful setup under 5 minutes in moderated tests, excluding third-party admin approvals.
- >= 80% of 10 new users complete their first delivery without developer help.
- >= 99.9% accepted events eventually reach terminal delivered/failed status in synthetic tests (not a delivery SLA).
- No known cross-tenant leakage or unencrypted stored destination secrets.

## Test with real users
Recruit 5 developers/DevOps, 3 operations staff and 2 nontechnical managers. Watch unassisted setup, record where they stop and whether the notification is useful. Reprioritize by observed friction, not feature votes.
