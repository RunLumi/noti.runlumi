# ADR 0029: Discord global guard and custom-webhook host controls

Status: Accepted · Date: 2026-10-15 · Implements slice 1.16 of [`docs/specs/REMAINING.md`](../specs/REMAINING.md): F108 (the
shared-egress budget) and F115 (the host controls). Spec 09 is authoritative. Builds on
[ADR 0014](0014-extended-destinations.md), [ADR 0023](0023-delivery-ledger-depth.md), [ADR 0024](0024-job-runner-alerting.md) and
[ADR 0026](0026-egress-guards.md). **One migration: `0029_egress_guard_and_webhook_hosts.sql`** (the next contiguous number on `main`
when written; parallel slices may claim it, and whichever merges second renumbers).

## Context

Two controls were named as blockers "the day they are switched on".

1. **Discord.** Discord bans the calling IP at Cloudflare for ten minutes after 10,000 invalid requests (401, 403 or 429) in ten
   minutes ([`DESTINATION_API_REFERENCE.md`](../DESTINATION_API_REFERENCE.md) section 4). Every tenant's Discord webhook leaves from
   the same Worker egress, so one tenant retrying a dead webhook can stop Discord delivery for all of them. The per-integration breaker
   (ADR 0023) is keyed by tenant on purpose and cannot see this.
2. **Custom webhooks.** The host is chosen by the customer. The save-time DNS check (ADR 0014) is a point-in-time answer and the
   send path did not look at the address at all.

## Decisions

### A. The Discord guard (`src/delivery/egress-guard.ts`)

1. **The one deliberately cross-tenant control.** `egress_guard_buckets` (per provider and minute: requests, invalid answers) and
   `egress_guard_state` (per provider: `open_until`) have no organization, integration, host or URL column. A test asserts it, and the
   tenant-contract test lists both as platform tables with that reason. Nothing a tenant can read is derived from them except the fact
   that their delivery is waiting.
2. **Trip.** Invalid answers (401, 403, 429; every 429 is counted, which is conservative) in the trailing ten minutes reach 1,000, a
   tenth of Discord's documented 10,000. The guard opens for eleven minutes (longer than the window, so the counted answers have aged
   out when traffic resumes) and trips again if the cause persists. While open **no** Discord request leaves for **any** tenant.
3. **Pacing.** Total Discord requests in the current minute are capped at 2,400, 80% of the documented global 50 per second. It is a
   per-minute cap, not per-second: a per-second counter costs a D1 write per request on top of the one already made.
4. **What happens to a held delivery.** The consumer checks the guard after the stored destination has been opened and validated and
   before the request. A hold returns the delivery to `retrying` with no attempt spent, an attempt-log row of kind `deferred` with the
   reason `platform_paused`, and the existing 24-hour held-delivery ceiling still applies. Nothing is dead-lettered by the guard.
   Test notifications are held too: they spend the same shared budget. The delivery view shows `pausedReason: platform_paused`
   ("held by a platform-wide safeguard"), never a count.
5. **Accounting.** Every Discord request records one request and, for 401, 403 or 429, one invalid answer, best effort.
6. **Fails open.** If D1 cannot be read the delivery proceeds and the fault is logged: the guard is a safeguard, not something
   delivery depends on. The 404 rule, the per-integration auto-pause and the 401/403 attempt cap still apply.
7. **Alert.** `egress_breaker_open` (critical, one tick) reads the number of guards open now from `egress_guard_state` by primary
   key. The runbook entry says what to look at (the counters hold no tenant, so the cause is found from `delivery_attempts`).
8. **Housekeeping.** The `egress_maintenance` cron job (new in the cadence table) deletes buckets older than one hour.

What it cannot do, stated rather than hoped: Discord's limit is per IP, and the Worker's egress addresses are Cloudflare's, shared and
not ours, so our counters see only our own traffic. The count is a read-modify-write per response and not a transaction with the send,
so concurrent consumers can overshoot the trip point by the number in flight (a tenth of the real limit leaves room). The trip point,
window and pacing are engineering judgment; no number has been observed against the real service.

### B. Custom webhook host controls (`src/connectors/destinations/generic-webhook/host-control.ts`)

The feature flag `GENERIC_WEBHOOK_ENABLED` **stays off**.

1. **Workspace allowlist** (`workspace_webhook_hosts`, a tenant table). A rule is an exact host or `*.domain`; IP literals, ports,
   single labels and the existing blocked suffixes are rejected; at most 50 rules. An integration can be saved or sent only to an
   allowlisted host, so an empty allowlist means no custom webhook: opt-in, never a default. The check runs before any DNS query at
   save and at send.
2. **Recorded resolutions** (`webhook_host_resolutions`, a tenant table): host, addresses, result, time, and how often the address set
   changed. A record younger than five minutes is trusted; an older one is re-resolved before the send (through `dns-check.ts`, the
   only allowed resolver call site, unchanged), and a blocked address is refused. The `egress_maintenance` job also re-resolves the
   twenty oldest stale records per tick, but only while the flag is on, and records a host that is no longer allowlisted as
   `not_allowed`. Addresses are for the operator and are returned by no tenant API; changes are logged as counts and ids only.
3. **Send-time refusal.** A host that is not approved or resolves to a private or reserved address is permanent
   (`destination_url_rejected`, diagnostics `host_not_allowed` and `host_blocked_address`); a failed lookup is retryable
   (`destination_unavailable`, `host_lookup_failed`). It fails closed.
4. **Egress proofs extended, not bypassed.** `host-control.ts` contains no outbound construct and calls `checkResolvedHost` exactly
   twice, each with the injected fetcher; the egress test pins both, and pins that the consumer verifies the host before `sendRequest`.
   `ALLOWED_OUTBOUND` is unchanged.

**What this does not do, and why the flag stays off.** Workers `fetch` cannot be told which address to connect to, and the DNS-over-
HTTPS answer comes from a different resolver path than the one `fetch` uses, so a zone owner can answer differently to each. The
controls narrow the rebinding window from "save time" to "five minutes" and remove the attacker's choice of host; they do not close it.
Closing it needs an egress proxy that pins the connected address, or a platform feature not verified here.

## Blockers before `GENERIC_WEBHOOK_ENABLED` may be turned on

- A management API, capability, audit event and screen for the allowlist (today it can be written only by SQL or code, so the feature
  is unusable by design).
- Pinning the connected address (AR-30), or an explicit risk acceptance from a security reviewer.
- A run against a real resolver and a real customer endpoint (every DNS answer in the tests is a fixture).
- The allowlist in the workspace export, and its deletion behaviour confirmed with the workspace purge on a real D1.

## Blockers before Discord is advertised

- Observation against the real service of the 401/403/429 behaviour and the actual limits (UNVERIFIED); tuning of the trip point.
- Per-route Execute Webhook limit (reference section 8, item 9).

## Migration

`0029_egress_guard_and_webhook_hosts.sql`, expand only: four new tables. **Deploy order:** apply before the Worker. **Rollback:** the
previous Worker ignores the tables (the guard is then off, the custom webhook is off anyway); `DROP TABLE` the four.

## Cross-tenant statements

`DUE_RESOLUTIONS_SQL` and the stale-resolution delete in `host-control.ts` read and delete across tenants on purpose (a maintenance
sweep); both are allowlisted in the tenant-query-scope test with reasons. The guard's tables have no tenant.

## Consequences

- One extra D1 read (state) and one (window) before, and one write after, every Discord request. A custom webhook adds an allowlist
  read and a resolution read per send, and a DNS-over-HTTPS pair every five minutes per integration at most.
- Existing tests that deliver to a custom webhook seed an allowlisted host and a fresh resolution.

## Not done

See the blocker lists above. Also: a customer-facing notice when Discord is paused platform-wide, guards for other providers, and the
`webhook_host_resolutions` addresses in the support bundle.
