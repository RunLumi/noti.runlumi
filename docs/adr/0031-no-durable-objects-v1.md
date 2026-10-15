# ADR 0031: No Durable Objects in V1: Workers, D1 and Queues only

Status: Accepted · Date: 2026-10-15 · Records a decision taken at the start of the project and never written down
(slice 2.18, F14). Reconstructed from the code and the specs; the decision date is not known. **No code change, no migration.**
Related: [ADR 0005](0005-delivery-reliability.md), [ADR 0034](0034-single-d1-v1.md).

## Context

Cloudflare offers [Durable Objects](https://developers.cloudflare.com/durable-objects/) (DO) for per-key serialised state: counters, locks, WebSocket rooms. Noti has several
places where a reader might expect one: the per-integration claim of a delivery, the fixed-window rate limiters, the
burst-grouping and digest state, and the idempotency check. `wrangler.jsonc` declares no `durable_objects` binding and no
source file under `src/` or `web/src/` references one.

## Decision

V1 uses **no Durable Objects**. State lives in D1 and work moves through Queues (and cron):

1. **Claims** are one conditional `UPDATE ... WHERE state = 'pending' ... RETURNING` under a lease token (ADR 0005), so a
   database row is the lock.
2. **Rate limits** are D1 fixed windows (`src/security/rate-limit.ts`), accepted with their up-to-2x boundary burst (AR-8,
   AR-16, AR-17).
3. **Grouping, digests and held events** are rows plus a scheduled release job (ADR 0016).
4. **Idempotency** is a stable key in the ledger (F170), not an in-memory set.

## Why

- One storage system to back up, migrate, export, delete and isolate per tenant. A second store (DO SQLite) would need its
  own retention matrix, export and erasure path, and its own tenant-isolation proof (F25, F233).
- The tenant contract is enforced in the schema and proven statically (ADR 0021). That proof does not extend to DO storage.
- Every DO is a single-threaded object: a hot tenant becomes a hot object. We have no measurement showing the D1 approach
  is the bottleneck.
- AGENTS.md: keep dependencies lean, avoid long-running runtime assumptions.

## Consequences

- Fixed-window limiters are approximate at window boundaries and add D1 writes; this is recorded as accepted risk, not hidden.
- Contention between consumers on one D1 database is possible; it is retried (`withD1Retry`, ADR 0022) and observed
  (`overloaded` rate, RUNBOOK). The same constraint drives [ADR 0034](0034-single-d1-v1.md).
- No WebSocket or live-push feature is possible without revisiting this.
- Cloudflare's own agent and workflow products are not used for the same reason; adopting one is a new ADR.

## Revisit when

- Measured cross-tenant contention on D1 (sustained `overloaded` rate, or p95 claim latency breaching its SLI), the trigger
  F06 names.
- A feature that needs per-key serialisation or a live connection (exact-count rate limiting, presence, streaming).
- A limiter bypass or abuse incident caused by fixed-window accounting.

## Sources

- [Durable Objects](https://developers.cloudflare.com/durable-objects/): the per-key and single-threaded model. **Not re-read**
  on 2026-10-15 (the agent sandbox could not reach developers.cloudflare.com) and no quote from it is recorded in the repo.
- [D1 platform limits](https://developers.cloudflare.com/d1/platform/limits/): "Each individual D1 database is inherently
  single-threaded". Read 2026-10-13, quoted in `docs/specs/01-platform-runtime.md`.

## Not verified

No load test has compared the D1 claim path with a DO-based one; the choice rests on simplicity and isolation, not on measured throughput.
The Durable Objects behaviour cited above has not been checked against the official page in this change.
