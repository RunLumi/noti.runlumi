# ADR 0034: V1 runs on one D1 database; sharding is deferred, not dismissed

Status: Accepted · Date: 2026-10-15 · Records the F06 deferral (spec 01 F06 is marked deferred by design). Related:
[ADR 0021](0021-tenant-contract.md) is the tenant contract this relies on, [ADR 0031](0031-no-durable-objects-v1.md),
[ADR 0011](0011-observability.md). **No code change, no migration.**

## Context

Cloudflare documents D1 as designed for many smaller databases (per tenant or per entity), and a D1 database is single-writer:
more queue consumers do not give more write throughput, they give contention and an `overloaded` error once its internal
queue fills. Queues also scales consumers down as failures rise. Spec F06 proposes a `dbFor(workspaceId)` routing function
from the start. The code uses `env.DB` directly.

## Decision

V1 ships on **one D1 database**. We do not build `dbFor`, a shard key, or a cross-shard fan-out path now.

What keeps sharding possible, and is enforced:

- Every tenant table carries `organization_id`, `NOT NULL` with a foreign key (migration 0026), and a static test requires an
  organization predicate in every tenant query (ADR 0021).
- D1 writes go through `withD1Retry` with backoff and jitter (ADR 0022).
- The signal that would justify the move is watched for: the RUNBOOK names D1 `overloaded` log lines as the sharding signal, and ADR 0011 provides the D1-derived SLIs. No alert on the `overloaded` rate exists yet.

## Why

- A single database is simpler to migrate, back up, export and delete, and F06's own design text says to ship V1 on one and
  shard "when the measured numbers justify it, not before".
- Sharding adds a shard registry, a failure mode ("unknown shard", fail closed) and cross-shard admin queries, all before
  there is a customer or a number to justify them.
- Retrofitting is a routing-function change plus a data migration, not a rewrite, because the tenant key is already on every row.

## Consequences

- Throughput ceiling and blast radius are one database. The limit is not measured; no load test exists and local D1 cannot
  reproduce contention (needs the staging drill in docs/RELEASE_GATES.md).
- The 10 GB per-database cap applies to the whole product; retention jobs (docs/DATA_RETENTION.md) are what bound growth.
- D1 Time Travel is per database, so a restore is whole-product (RUNBOOK "After a restore").
- Adding `dbFor` later touches every query site; the static tenant-scope test is the map.

## Revisit when

- A sustained `overloaded` rate, or p95 query latency breaching its SLI, on real traffic.
- The database approaches a fraction of its size cap that retention cannot hold back.
- A customer needs data residency or isolation that only a separate database gives.
