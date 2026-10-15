# Security incident response

A skeleton for the first hours of a **security** incident (spec 15 F242): exposure of tenant data,
compromise of a credential, silent corruption of deliveries. Availability and delivery-loss
incidents are in [`RUNBOOK.md`](RUNBOOK.md); this document starts where the RUNBOOK says "stop and
escalate".

**Status: written from the code, never rehearsed, never used.** Every command was derived from this
repository, not run against a production Cloudflare account. Cloudflare behaviour that was not
verified is marked **UNVERIFIED**. There is no on-call rota, no paging and no monitored mailbox
(`SECURITY.md` uses GitHub private vulnerability reporting). No formal security audit has been
performed, and nothing here is a legal opinion or a notification commitment.

## Severity

Severity is set by impact. It does not replace the RUNBOOK's Sev 1 to 3, which describe
delivery health; a security incident gets one of the classes below and, if deliveries are also
affected, a RUNBOOK severity as well.

| Class | Meaning | Examples | First response | Targets (not commitments) |
| --- | --- | --- | --- | --- |
| S1 | Cross-tenant exposure, or an unauthorised party reading or acting on tenant data | A workspace saw another's integration, delivery or audit row; a private event routed to the wrong tenant | Stop the path, preserve evidence, then scope (below) | acknowledge, contain, notify: _to be set by the operator_ |
| S2 | Credential compromise | KEK, `BETTER_AUTH_SECRET`, a webhook secret, a destination URL, a source signing secret, GitHub client secret, session tokens | Rotate the specific credential (below) | _to be set by the operator_ |
| S3 | Silent corruption or loss of deliveries caused by a defect or an attack | Wrong content sent, events dropped without a ledger row | Stop the affected path, then reconcile from the ledger | _to be set by the operator_ |
| S4 | Security-relevant degradation without exposure | Rate-limit abuse, signature-failure spike, a dependency advisory with no exploit path | Triage in working hours; record | _to be set by the operator_ |

Every S1 and S2 triggers a review of the risk register in `docs/THREAT_MODEL.md` section 7 within
14 days (spec 15 F241).

## First hour, any class

1. **Write down the time and who is acting.** Start the incident record (template at the end).
   Keep sensitive details out of chat tools and public issues.
2. **Preserve before you purge.** See "Evidence and retention" below. Do this early; some stores
   delete on a schedule.
3. **Contain with the narrowest effective step** from the playbooks. Prefer rotating one credential
   to taking the service down. A rollback of the Worker (`wrangler rollback`, UNVERIFIED for this
   account) does not touch D1 or secrets.
4. **Scope from data, not memory.** The ledgers are D1: `audit_events`, `deliveries`,
   `routing_decisions`, `github_installations`. Logs are a view (RUNBOOK). Every API response
   carries `x-request-id`; log lines carry the same `correlation_id`.
5. **Do not state facts you cannot show.** Say what was measured, what is inferred and what is
   unknown (the RUNBOOK template separates them).

## Mechanisms that exist today

| Need | Mechanism | Where |
| --- | --- | --- |
| See who did what | Admin audit log `GET /api/audit`; denials and cross-tenant probes are written as `access.denied` | `src/audit/`, `docs/API.md` |
| Per-request correlation | `x-request-id` header and `correlation_id` in logs | `src/platform/correlation.ts` |
| Stop one integration | Pause it (`PATCH /api/integrations/:id {enabled:false}`) | `docs/API.md` |
| Stop a whole workspace | Schedule deletion: integrations are disabled at once, and the purge waits 7 days and can be cancelled | `src/api/workspace-lifecycle.ts` |
| Quarantine | A row whose credentials will not open stops delivering and dead-letters with `destination_credentials_invalid` | RUNBOOK "Quarantined credentials" |
| Take a copy of a workspace's data | `GET /api/workspace/export` (admin), never includes credentials | `docs/API.md` |
| Take a copy of one person's data | `GET /api/workspace/me/data-export` (that person) | `docs/DSAR.md` |
| Rotate KEK | Versioned `KEK_V<n>` secrets, `KMS_ACTIVE_VERSION`, cron rewrap | `docs/IMPLEMENTATION.md` "Key rotation (KEK)" |
| Rotate a source signing secret | `POST /api/sources/:id/rotate`; the previous secret is invalid at once | `docs/API.md` |
| Rotate a destination credential | `PATCH /api/integrations/:id` with a new `webhookUrl` (fresh key material), audited as `integration.credentials.rotate` | `docs/API.md` |
| End sessions | A person ends one or all other sessions in Settings (`/api/workspace/me/sessions`, audited); a password reset ends every session; after a restore or a suspected leak the operator runs `scripts/revoke-all-sessions.mjs` (AR-1) | `docs/RUNBOOK.md` "After a restore", ADR 0030 |
| Account erasure | `DELETE /api/workspace/me` | `docs/DSAR.md` |

## Playbooks

Each lists first actions only. Add the facts you learn to the incident record.

### S1: cross-tenant read or routing observed

1. Identify the path (an API route, the webhook route, the consumer). If it is a code defect and
   the previous Worker version was safe, roll back (`wrangler rollback`, UNVERIFIED). If not, there
   is no global kill switch for the API: pausing integrations (above) stops delivery, and an
   operator can disable every integration in D1 as a break-glass write
   (`UPDATE integrations SET enabled=0 WHERE organization_id='<org>'`, one workspace at a time).
2. There is **no switch to disable public sign-up** (the spec asks for one; it is not built).
3. Preserve evidence (below). Find affected tenants from `audit_events` (`access.denied` and the
   action rows), `deliveries` and `routing_decisions` for the window, selecting ids and counts, not
   payloads. `notification_outbox` holds display text: treat it as customer data.
4. Run the isolation drill from `docs/RELEASE_GATES.md` (not yet built or run) against the fix before
   restoring service.
5. Tell each affected workspace what was exposed, to whom and when, with only what the data shows.

### S2: a KEK is suspected leaked

1. Follow `docs/IMPLEMENTATION.md`, "Key rotation (KEK)": add `KEK_V<n+1>`, switch
   `KMS_ACTIVE_VERSION`, let the cron rewrap, verify zero rows remain on the old version, then delete
   the old secret. Rotation has not been rehearsed.
2. **Rewrapping changes the wrapper, not the data key.** If an attacker could have had both the old
   KEK and a copy of D1, the sealed destination URLs and secrets in that copy are readable. Treat
   them as exposed: the customer must rotate the URL at the provider and re-enter it (the playbook
   below), which writes a fresh data key.
3. If the exposure includes D1, also treat all session tokens as compromised (they are stored in
   clear, AR-1): see "Sessions".

### S2: a destination credential (webhook URL or signing secret) is exposed

1. The customer revokes or regenerates the URL at the provider (Slack, Lark, Teams, Discord).
2. The customer re-enters it with `PATCH /api/integrations/:id`. This seals it under a fresh data
   key and writes `integration.credentials.rotate`. Until then, pause the integration.
3. Look for the leak path: logs, dead letters and exports are designed never to contain a URL or a
   secret (redaction layer, tests under `tests/security/`). A URL found in any of them is a defect
   (S1 or S2), not just an exposure.

### S2: a source signing secret is exposed

1. `POST /api/sources/:id/rotate` returns a new secret once and invalidates the old one at once. The
   sender must be updated; events signed with the old secret are rejected until then. (Spec 03 F38
   describes a zero-downtime overlap; this implementation does not have one.)
2. For a provider source (GitLab, Stripe) rotate in the provider and paste the new credential.

### S2: the GitHub webhook secret or client secret is exposed

1. The webhook secret is one value for the whole App (AR-13). Change it in the GitHub App settings
   and `wrangler secret put GITHUB_WEBHOOK_SECRET` back to back. Events in between fail verification
   and GitHub does not retry on its own: use RUNBOOK "Missed GitHub webhooks".
2. Client secret: regenerate in the App settings, then `wrangler secret put GITHUB_CLIENT_SECRET`.
   The App private key is not used by this codebase yet.

### Sessions: `BETTER_AUTH_SECRET` or session tokens exposed

1. Everyone: `node scripts/revoke-all-sessions.mjs --database <name> --remote --reason incident --apply` (maintenance mode on;
   it records `session.revoke_all`). One person: break-glass, name it in the record:
   `DELETE FROM "session" WHERE user_id='<id>';`. The person signs in again.
2. Rotating `BETTER_AUTH_SECRET` should invalidate signed cookies (UNVERIFIED for the installed
   Better Auth version; verify on staging). It is not a substitute for deleting rows while tokens
   are stored in clear.
3. A person whose account was taken over resets the password (this revokes sessions) and removes
   unknown passkeys. There is no admin tool to do this on their behalf.

### S3: wrong or missing deliveries

1. Pause the affected integrations, or the source.
2. Reconcile from `deliveries` and `notification_outbox` (RUNBOOK "Dead-letter inspection and
   redelivery"). Delivery is at least once; do not promise exactly once.
3. State what was lost or duplicated and for whom, from the ledger.

### S4: security-relevant degradation without exposure

Examples: a spike in signature failures, rate-limit abuse, a dependency advisory with no reachable path, a
`unmapped_provider_response` event, a registry staleness alert.

1. Record it: time, signal, source (alert, log, report). Do not page for S4; triage in working hours.
2. Decide whether it is S4 or a precursor. A signature-failure spike against one installation may be a leaked URL (S2) or a
   probe; check `audit_events` for `access.denied` and the ingress counters before dismissing it.
3. Contain only if cheap: pause one integration or source; tighten the edge rule for a flood (RUNBOOK).
4. Close with a line in the incident record saying what was checked and what the data showed. An S4 that turns out to expose
   data is reclassified and the clock for the higher class starts at the reclassification, with the original time kept.
5. A dependency advisory with no fix: record it in the risk register (`docs/THREAT_MODEL.md` section 7) with an owner and a
   review date, and add a dated exception to `scripts/audit-gate.mjs` only with a reason and an expiry of at most 90 days.

### Compromised dependency

1. Pin to the last good version in `package-lock.json`, run `npm run audit:gate` and `npm audit signatures`, redeploy. The
   install-script policy is `docs/SUPPLY_CHAIN.md`; a package that gained an install script or lost its provenance
   attestation is a red flag in itself.
2. Check whether the affected code path can read secrets (the Worker holds KEKs and the Better Auth
   secret as bindings) and, if so, treat it as S2.

## Evidence and retention

**The rule.** Evidence is preserved before anything that deletes it, and preservation wins over retention and erasure for the
incident window; the conflict is written into the incident record afterwards. Nobody runs a purge, a restore, a rollback of
data or a credential destruction on an affected workspace until step 1 below is done and noted in the record. A destructive
act taken to contain an incident (disabling rows, rotating a KEK) is recorded before it is done, with the rows it will change.

A purge can destroy the record of an incident. No automatic hold exists (the spec's
`incident_preservation_blocks_retention_purges_for_the_window` is not built). Do this by hand:

1. Export first: `GET /api/workspace/export` per affected workspace (the 2,000 newest deliveries and
   audit rows only; `truncated` says if more exist). For anything older or larger, copy rows with
   `wrangler d1 execute lumi-noti --remote --command "SELECT ..."` into the incident record's store.
2. Hold the audit and delivery ledgers by raising `AUDIT_RETENTION_DAYS` (max 3650) and
   `DELIVERY_RETENTION_DAYS` (max 365) in `wrangler.jsonc` and redeploying. The other stores have
   fixed periods in code (`routing_decisions` 30 days, `held_events` 7 days after release, outbox 7
   days) and cannot be held without a code change: copy them out instead.
3. D1 Time Travel keeps point-in-time history for a period set by Cloudflare (`docs/SECURITY.md`
   records up to 30 days). Note the time of the incident so a restore point can be chosen.
   Restore commands are UNVERIFIED.
4. When preservation and a retention or erasure obligation conflict, preservation wins for the
   incident window and the conflict is written into the incident record afterwards.
5. A workspace deletion in progress purges after 7 days. Cancel it
   (`DELETE /api/workspace/deletion`) if its data is evidence, and tell the requester why.

## Talking to customers and regulators

- Customers: facts only, in the incident record's words: what happened, what data, which window,
  what we did, what they should do (for example rotate a webhook). No claim that is not backed by
  data we can show. Do not use the words "secure", "audited" or "production-ready" (spec 15 F240).
- **Notification deadlines are not decided here.** Whether and when a regulator or a customer must
  be told depends on the law, on whether Lumi is controller or processor for the data, and on the
  contract. Spec 15 F242 cites GDPR Article 33 only as a pointer; the text and any deadline were
  **not verified** and are not restated. The operator must settle this with qualified advice before
  launch.
- Researchers: they reach us through GitHub private vulnerability reporting
  (`/.well-known/security.txt`, `SECURITY.md`). Nobody is committed to watch it; assign an owner
  before launch.

## Incident record template

Use the RUNBOOK's template and add:

```
Class (S1-S4) / RUNBOOK severity if deliveries were affected:
Credentials touched and rotated (which, when, by whom):
Tenants affected (count; ids kept in the restricted record only):
Evidence preserved (what, where, when):
Retention or erasure conflicts and how they were resolved:
Detected by us or by someone else:
Controls that held / controls that failed:
Risk-register review due (14 days):
```

## Postmortem template

Internal, for S1 to S3 (and for any S4 that was reclassified). Blameless: describe controls and decisions, not people. Written
within 14 days, the same window as the risk-register review. Say what was measured, what is inferred and what is unknown;
state nothing that the data cannot show. Keep tenant identifiers in the restricted record, not here.

```
Title / class (S1-S4) / dates (first signal, detected, contained, resolved):
Summary (three sentences, no adjectives):
Timeline (UTC, one line per event, with the source of each: log, audit row, person):
Blast radius: tenants (count), rows by table (count), credentials, time window. How it was measured.
Detected by us or by someone else, and how long after the first signal:
What was load-bearing: controls that held (cite the control ID, e.g. AR-n or a test) and controls that failed or did not exist:
What we did not know at the time and what it cost:
Evidence preserved (what, where, when) and any retention or erasure conflict and its resolution:
Customer and regulator communication: what was said, when, on what facts. Any notification decision and who made it:
Actions: owner, due date, and the test or check that will prove each one:
Risk-register entries added or reviewed (due within 14 days for S1 and S2):
```

## Not done

- Rehearsal of any playbook; a tabletop exercise.
- A monitored security contact, an on-call rota, paging, and any published response times.
- A kill switch for sign-up, and a global read-only mode.
- A session list and revoke-others screen; admin-initiated session revocation.
- An automatic evidence hold that blocks the retention jobs.
- A pre-written customer notice reviewed by counsel, and the decision on regulatory notification.
- Zero-downtime source-secret rotation.
