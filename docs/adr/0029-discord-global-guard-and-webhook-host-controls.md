# ADR 0029: Discord global guard and custom-webhook host controls

Status: Accepted · Date: 2026-10-15 · Implements slice 1.16 of [`docs/specs/REMAINING.md`](../specs/REMAINING.md): F108 (the
shared-egress budget) and F115 (the host controls). Spec 09 is authoritative. Builds on
[ADR 0014](0014-extended-destinations.md), [ADR 0023](0023-delivery-ledger-depth.md), [ADR 0024](0024-job-runner-alerting.md) and
[ADR 0026](0026-egress-guards.md). **One migration: `0029_egress_guard_and_webhook_hosts.sql`** (revised in place after an independent
review, before merge).

## Context

1. **Discord.** Discord bans the calling IP at Cloudflare for ten minutes after 10,000 invalid requests (401, 403 or 429) in ten
   minutes ([`DESTINATION_API_REFERENCE.md`](../DESTINATION_API_REFERENCE.md) section 4). Every tenant's Discord webhook leaves from the
   same Worker egress, so one tenant retrying a dead webhook can stop Discord delivery for all of them. The per-integration breaker
   (ADR 0023) is keyed by tenant on purpose and cannot see this.
2. **Custom webhooks.** The host is chosen by the customer. The save-time DNS check (ADR 0014) is a point-in-time answer and the
   send path did not look at the address at all.

## Decisions

### A. The Discord guard (`src/delivery/egress-guard.ts`)

**A tenant can cause the global trip, so each tenant is bounded first.** The first version of this guard counted every invalid answer
globally. A workspace could create up to 100 Discord integrations pointing at one real webhook of its own (per-webhook limits answer
429) or at a webhook with a corrupted token (401 on every send), open the breaker for every tenant, and repeat it. The independent
review found this. What bounds it now:

1. **Per-tenant budgets.** `egress_guard_tenant_buckets` (a TENANT table: workspace, integration, provider, minute, requests, invalid)
   holds the same counts per workspace. A workspace whose invalid answers in ten minutes reach 50, or one integration reaching 10, has
   its own deliveries held (reason `workspace_paused`, shown to it in the delivery view and the attempt log) before the global guard
   is looked at. The gate runs before the send, so a held workspace stops sending, it does not merely stop being counted.
2. **Only within-budget answers count globally.** An invalid answer is added to the global count only while its workspace and its
   integration are within budget. A workspace past its budget adds nothing, so opening the breaker needs 1,000 / 50 = 20 workspaces
   all at budget in the same ten minutes. Creating workspaces is rate limited and audited elsewhere; it is not free.
3. **Fair share of the pacing.** A workspace may make 600 requests a minute (a quarter of the soft cap). Once the platform is at 2,400
   a minute only workspaces that have made fewer than 100 that minute are admitted, up to the documented 3,000. A heavy backlog cannot
   starve a light workspace into the 24-hour held-delivery ceiling (`platform_paused_timeout`), which the held-delivery rule still
   applies to a workspace that stays over its share.
4. **The global tables carry no tenant data** (`egress_guard_buckets`, `egress_guard_state`: provider, minute, counts, `open_until`);
   a test asserts it, and the tenant-contract test lists them as platform tables. Tenant counters are in the separate tenant table,
   with retention (one hour, `egress_maintenance`), workspace-purge draining and a tenant-scope allowlist entry for the age purge.

What a tenant can still do, said plainly: an attacker with about 20 workspaces can still open the breaker, and any workspace can make
itself `workspace_paused` (it hurts only itself). The budgets bound the damage; they do not make it impossible. A workspace that burns
its budget repeatedly is visible to the operator in `egress_guard_tenant_buckets`; automatic suspension is not built.

Other decisions:

5. **Trip.** 1,000 invalid answers (401, 403, 429) in the trailing ten minutes, a tenth of Discord's 10,000. The guard then opens for
   eleven minutes (longer than the window, so the counted answers have aged out) and trips again if the cause persists. While open no
   Discord request leaves for any workspace.
6. **Held deliveries** return to `retrying` with no attempt spent, an attempt-log row of kind `deferred` with the reason, and are never
   dead-lettered by the guard; the existing 24-hour ceiling applies. Test notifications are held too (same shared budget). The delivery
   view shows `pausedReason` `platform_paused` or `workspace_paused`, never a count (English and Vietnamese copy, including the
   24-hour stop lines).
7. **`X-RateLimit-Scope: shared` 429s are still counted.** Discord's public documentation says they do not count toward the invalid
   request limit, but [`DESTINATION_API_REFERENCE.md`](../DESTINATION_API_REFERENCE.md) lists the header and does not say so, and this
   repository does not assume what it cannot cite. Counting them is the conservative side; a workspace sharing a rate-limited channel
   pauses itself sooner. UNVERIFIED; revisit when the reference is updated.
8. **Fails open, and says so.** If D1 cannot be read the delivery proceeds, a counter in `ops_state` (`egress_guard_fault`) is bumped
   best effort, and the `egress_guard_failing` alert (warning: three faults in 15 minutes) fires with a runbook entry, so "the protection
   is off" is visible. The 404 rule, the per-integration auto-pause and the 401/403 attempt cap still apply.
9. **Alerts.** `egress_breaker_open` (critical, one tick) reads `egress_guard_state` by primary key.
10. **Alert-sink Discord requests bypass the guard, deliberately.** `observability/alerts/sinks.ts` posts alerts to a configured chat
    webhook through `sendRequest`, not through the consumer. The alert that says the guard is open must still be able to leave, and
    alert volume is a handful a day. A test pins that sinks can never target a custom webhook.
11. **Housekeeping.** The `egress_maintenance` job deletes buckets older than one hour (global, and tenant in bounded batches).

What it cannot do: Discord's limit is per IP and the Worker's egress IPs are Cloudflare's, shared and not ours, so our counters see
only our traffic. Counting is a read-modify-write, not a transaction with the send, so concurrent consumers can overshoot a budget by
the number in flight. Every number (trip, budgets, shares, pacing) is an engineering judgment; none has been observed against the
real service.

### B. Custom webhook host controls (`src/connectors/destinations/generic-webhook/host-control.ts`)

The feature flag `GENERIC_WEBHOOK_ENABLED` **stays off**.

1. **Workspace allowlist** (`workspace_webhook_hosts`, a tenant table; exported with the workspace as `webhookHosts`). A rule is an
   exact host or `*.domain`; IP literals, ports, single labels and the existing blocked suffixes are rejected; **a wildcard over a
   public suffix or shared hosting is rejected** (`*.herokuapp.com`, `*.github.io`, `*.co.uk` ...) using a small bundled list; at most
   50 rules. An integration can be saved or sent only to an allowlisted host: an empty allowlist means no custom webhook. The check
   runs before any DNS query at save and at send. **This is the control that matters.** The bundled list is not the Public Suffix
   List; the management API must use the full list (a blocker below).
2. **Recorded resolutions** (`webhook_host_resolutions`, a tenant table): host, addresses, result, time, last send, and how often the
   address set changed. A record older than five minutes is re-resolved before a send, and the `egress_maintenance` job re-resolves the
   five oldest stale records of **enabled** custom-webhook integrations per tick. **What this catches:** a zone whose records were
   statically changed to a private or reserved address after the allowlist approved the host. **What it does not:** DNS rebinding.
   The answer we check comes from a DNS-over-HTTPS resolver, a different path from the one `fetch` uses, and Workers `fetch` cannot be
   told which address to connect to; a zone owner who answers differently per resolver or per query passes every check here and
   still reaches a private address. Re-resolution shortens nothing against that attacker. It is hygiene and an operator signal.
3. **Record lifecycle.** `last_used_at` is renewed only by a send, not by the cron sweep; retention (30 days) counts from it. Records
   of a deleted or disabled integration are removed by the job whether or not the flag is on, and the sweep never re-resolves them.
   Both sweeps are bounded per run (five re-resolutions, 100 deletes). A Worker invocation has a subrequest budget (50 free, 1,000
   paid; UNVERIFIED for this account) shared with the other cron jobs; each host costs two DNS fetches and about six D1 calls.
4. **Send-time refusal.** A host that is not approved or resolves to a private or reserved address is permanent
   (`destination_url_rejected`, diagnostics `host_not_allowed` and `host_blocked_address`); a failed lookup is retryable
   (`destination_unavailable`, `host_lookup_failed`). It fails closed.
5. **The check cannot be bypassed by a new caller.** `sendRequest` refuses a `generic_webhook` request unless it carries a branded
   `HostVerification` minted for exactly that host, and only `verifyHostAtSend` mints one. The egress test is AST-based: it pins every
   call site of `sendRequest` and `deliver` in `src/` (consumer, `deliver`, the alert sink), that nothing calls `deliver`, that
   `mintHostVerification` is called from `host-control.ts` alone, and that the consumer verifies before it sends and passes the result.
   `ALLOWED_OUTBOUND` is unchanged; `host-control.ts` contains no outbound construct and calls `checkResolvedHost` twice with the
   injected fetcher.

## Blockers before `GENERIC_WEBHOOK_ENABLED` may be turned on

- A management API, capability, audit event and screen for the allowlist, using the full Public Suffix List (today it can be written
  only by SQL or code, so the feature is unusable by design).
- Pinning the connected address (AR-30), or an explicit risk acceptance from a security reviewer: rebinding is not defended.
- A run against a real resolver and a real customer endpoint (every DNS answer in the tests is a fixture).
- Confirm the workspace purge and export of the new tables on a real D1.

## Blockers before Discord is advertised

- Observation against the real service of the 401/403/429 behaviour and the actual limits (UNVERIFIED), including whether `shared`
  429s count; tuning of the budgets and the trip point.
- Per-route Execute Webhook limit (reference section 8, item 9); automatic suspension of a workspace that burns its budget repeatedly.

## Migration

`0029_egress_guard_and_webhook_hosts.sql`, expand only: five new tables (two global, three tenant). **Deploy order:** apply before the
Worker. **Rollback:** the previous Worker ignores the tables (the guard is then off, the custom webhook is off anyway); `DROP TABLE`
the five.

## Cross-tenant statements

`DUE_RESOLUTIONS_SQL`, `PURGE_RESOLUTIONS_SQL` and the tenant-bucket age purge read and delete across tenants on purpose (maintenance
sweeps); each is allowlisted in the tenant-query-scope test with a reason. The global guard tables have no tenant.

## Consequences

- A Discord send costs: state read, workspace window read, global window read (three reads) and one batch of two upserts after the
  response (plus one read and one write when the answer is invalid). A custom webhook adds an allowlist read and a resolution read per
  send, and a DNS pair every five minutes per integration at most.
- Existing tests that deliver to a custom webhook seed an allowlisted host and a fresh resolution.

## Not done

See the blocker lists above. Also: a customer-facing notice when Discord is paused platform-wide, guards for other providers, and the
resolved addresses in the support bundle.
