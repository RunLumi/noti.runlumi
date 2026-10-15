# ADR 0042: Breaker-open alert and outbound mail boot check

Status: Accepted · Date: 2026-10-15 · Completes parts of F183 and F200 (spec 12, spec 13) and F04 (spec 01) from [`docs/specs/REMAINING.md`](../specs/REMAINING.md) slices 1.7 and 1.11 (alert) and 1.3 (boot). Builds on [ADR 0023](0023-delivery-ledger-depth.md) (the breaker), [ADR 0024](0024-job-runner-alerting.md) (the alert engine) and [ADR 0036](0036-credential-destruction-and-boot-hygiene.md) (boot hygiene).

## Context

ADR 0023 built the per-integration circuit breaker, and its own "Not done" line said nobody is told when one opens. ADR 0024 built the alert engine, with ten alerts, and none of them reads a single breaker opening: `breaker_open_many` fires only at three open breakers at once. REMAINING 1.3 also asked whether the Worker exports an `email` entrypoint for the boot check. It does not: the default export has `fetch`, `queue` and `scheduled`. The only email binding is the outbound `AUTH_EMAIL` (Cloudflare Email Sending) that sends verification and reset mail, and the boot report does not mention it.

## Decision

1. **`breaker_open`, a new alert in the existing engine (F183, F200).** No migration: `alert_state` is keyed by alert id, so one more registry entry gets fire, dedupe, re-notify and resolve from the state machine that already exists and is tested.
   - **Signal.** `breakersHolding`: integrations whose breaker is holding deliveries back RIGHT NOW. An `open` row counts while `open_until` is in the future; a `half_open` row counts while its probe lease (`probe_until`) is live. That is the test `gateAttempt` applies in `src/delivery/health.ts`, so the alert reads what the consumer does.
   - **Why not the stored state.** An integration nothing sends to keeps its `open` row after the window passes, because only a probe changes the row. Counting the stored state would fire the alert and never resolve it for an idle destination, then re-notify every six hours. The UI still shows the stored state; the alert does not follow it.
   - **Threshold 1, warning, one incident platform-wide.** An alert carries no tenant id, so it cannot name the integration. Two breakers open at once are one incident with the count in `value`. Per-integration incidents would need a keyed row, which is a schema change this slice does not make.
   - **Timing.** Evaluated by the one-minute cron. A breaker stays `open` for five minutes, so a tick sees it unless the cron is down; the cron-down case is `cron_heartbeat_missing`.
   - **`breaker_open_many` is unchanged** and still counts the stored state (`breakersOpen`). It carries the same idle-row caveat, which this slice does not fix.
   - The runbook entry (`### Alert: breaker_open`) names the query that lists the breakers holding deliveries now, with the tenant id, for the operator only.
2. **No `email` handler; named warnings for the outbound binding (F04).** The Worker does not export `email`, and no inbound email source is built (ADR 0014), so there is no entrypoint to check. Instead `assessConfig` adds two warnings: `AUTH_EMAIL` when the binding has no `send`, and `AUTH_FROM_EMAIL` when unset, a placeholder or not an address. Warnings stop nothing, consistent with ADR 0036's GitHub warnings. A binding in `wrangler.jsonc` is not proof of a verified sending domain or of delivered mail (`docs/EMAIL_LIMITS.md`). Email does not work on evidence from this change.

## Consequences

- An operator is told within a minute that a destination breaker has opened, through the log and the optional chat webhook. Nothing pages a person.
- Alerts now total eleven. `alert-runbook.test.ts` and `alerts.test.ts` pin the registry, and the `breakersHolding` signal is in the plan test (`alert-plans.test.ts`, index seek on `destination_health_state`).
- Shared test environments (`tests/support/boot-env.ts` and the boot tests) carry a stub `AUTH_EMAIL` and a sender, because an absent binding is now a warning.
- **Finding, not fixed here.** `createAuth` throws when `AUTH_EMAIL` or `AUTH_FROM_EMAIL` is absent (`src/auth/better-auth.ts`), so `/api/auth` fails without the binding while the boot check only warns. That is an auth-tier fault in substance and belongs in the auth tier (which stops `/api`) if the coordinator agrees. This slice keeps the warning the task asked for.

## Not done

- Paging a person for a breaker; acknowledgement and escalation.
- Per-integration incidents, and the spec's `circuit_open` rule as written ("open > 5 min, per destination"). This alert fires on opening.
- Clearing `breaker_open_many`'s idle-row caveat (it should read the holding predicate too).
- A test that trips a real breaker through the consumer. The alert tests seed the rows `gateAttempt` reads; the row shapes are the ones `healthStatement` writes, tested in the delivery tests.
- Nothing has been sent to a real Slack, Discord, Lark or Teams webhook, and no real Email Sending run has been made.
- The auth-tier change for `AUTH_EMAIL` (see Consequences).

## Revisit when

- An operator reports breaker alerts that do not match what the integration page shows, or flapping at the window edge.
- `breaker_open_many` is retuned against real traffic: decide then whether it should use the holding predicate too.
- The email binding is exercised against a real Cloudflare Email Sending domain, or an inbound email source is added (then it needs its own entrypoint check).
- The coordinator promotes `AUTH_EMAIL` to the auth tier.
