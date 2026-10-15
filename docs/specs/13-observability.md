# 13 — Observability & SLIs

> What we measure, what we refuse to measure, and what we will say when we do not know.
> Three claims this file exists to prevent: a benchmark we did not run, a delivery rate we
> cannot prove, and an audit we have not had.
>
> Cloudflare facts below were read **2026-10-13**. Source of record:
> `docs/specs/README.md#sources`.

## The decision that shapes everything here

**D1 is the ledger of record. Cloudflare's log and analytics products are a view.**

This is forced by two documented facts, and it inverts the usual arrangement:

| Fact | Consequence |
| --- | --- |
| On the Free plan, *"Cloudflare stops ingesting new data when the account reaches its daily limit. Ingestion resumes when the allowance resets at 00:00 UTC."* ([observability/pricing](https://developers.cloudflare.com/observability/pricing/), read 2026-10-13) | Observability **goes dark** on the day we have a traffic spike, D1 overload, or retry storm — exactly when it is needed. Nothing that alerts on a failure may depend on log ingestion. |
| Workers Logs head sampling is per **request**: *"All logs within the context of the request are collected"* ([workers/observability/logs/workers-logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/), read 2026-10-13) | You **cannot** drop a single log line from a noisy invocation. Sampling must happen at the call site, in our code, before `console.log` is reached. |

So every signal that F200 alerts on is written to **D1** by the component that observed it, in
the same batch as the state it describes. Logs and Analytics Engine are for *diagnosis after
the fact*, never for *detection*. The exception is one: Analytics Engine holds three months
(F191) against D1's 30-day event retention, so it is the only place we can look back further —
and for that reason its counts are **estimates** (F191, F198), and every dashboard that reports
a count says whether it is exact or estimated.

## Constraints we design against

| Fact | Value | Source |
| --- | --- | --- |
| Analytics Engine datapoints | **250 per Worker invocation**; each `writeDataPoint` counts | [analytics-engine/limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/) |
| Analytics Engine per datapoint | ≤ **20 blobs**, ≤ **20 doubles**, **1 index** | same |
| Analytics Engine blob size | **16 KB** total per data point | same |
| Analytics Engine index size | **96 bytes** | same |
| Analytics Engine retention | **3 months** | same |
| Analytics Engine sampling | *"At very high volumes of data, Analytics Engine will downsample data… Sampling can occur on write and on read."* Rate exposed as `_sample_interval` | [analytics-engine/sql-api](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/) |
| Analytics Engine percentiles | `quantileExactWeighted(q)(column, _sample_interval)`; alias `quantileWeighted` | [sql-reference/aggregate-functions](https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/aggregate-functions/) |
| Workers Logs head sampling | `head_sampling_rate` 0–1, default `1`; **all logs in a sampled request are collected** | [workers-logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) |
| Workers Logs size cap | **256 KB per log**; oversize logs are truncated with `$cloudflare.truncated = true` | same |
| Workers Logs account cap | 5 billion logs/day, after which a **1% head sample** applies for the rest of the day | same |
| Workers Logs retention | 7 days | same |
| Observability pricing from **2026-12-01** | Free **0.5 GB/day** ingestion, 7-day retention, **no overage**; Paid **50 GB/cycle** ingestion + **10 GB-month** storage, **$0.25/GB** ingestion overage, **$0.10/GB-month** storage overage | [observability/pricing](https://developers.cloudflare.com/observability/pricing/) |
| Platform log budget | 256 KB per request covering `console.log`, exceptions, request metadata and headers; beyond that *"the system does not record additional context for that request"* | [workers/platform/limits](https://developers.cloudflare.com/workers/platform/limits/) |
| D1 overload | `D1 DB is overloaded. Requests queued for too long.` / `… Too many requests queued.` Recommended action is to optimize / send fewer requests / **shard** — not to retry | [d1/observability/debug-d1](https://developers.cloudflare.com/d1/observability/debug-d1/) |

### Documented contradictions — we build on the conservative reading

| Topic | Conflict | Our position |
| --- | --- | --- |
| Workers Logs retention | Limits table on the Workers Logs page: *"Maximum log retention period — 7 Days"*. Pricing table on the same page: Free **3 Days**, Paid **7 Days**. The Observability pricing page says Free gets *"Seven-day retention included"*. | Assume **3 days on Free**. Our retention-sensitive analysis runs off D1 (90-day delivery metadata), never off log retention. |
| Included Paid storage | The Observability pricing page says **10 GB-month**; a 2026-10 blog post said 10; at least one secondary source said 12. | **10 GB-month**, from the docs page. Re-check at the December changeover. |
| Analytics Engine counts | Docs show `COUNT()` and then show `SUM(_sample_interval)` as the correct form "if you are doing statistical analysis". | **`COUNT()` is never used for a published number.** Exact counts come from D1. |

---

## F191 — Analytics Engine metrics pipeline

**Priority** P1 · **Status** ❌ No Analytics Engine binding in `wrangler.jsonc`, no typed metric writer, datasets, sampling config or datapoint budget. ADR 0011 defers it; SLIs come from D1 only (`src/observability/slis.ts`). · **Referenced by F166, F168**

**Story** As a product owner, I want product metrics that survive three months and cost nothing
to query, so that I can understand how the product is used without building a warehouse.

**Acceptance**

```ts
type Dataset = 'noti_delivery' | 'noti_ingress' | 'noti_routing' | 'noti_platform';
// one dataset per cardinality shape; the index is chosen per dataset (below)
```

- [ ] Four datasets, each with **exactly one** index (a data point may carry only one).
- [ ] Index choice is deliberate, because *"Sampling is based on the index of your dataset so
      that only indexes that receive large numbers of events will be sampled"* — a
      high-volume index means that tenant's data becomes an estimate while other tenants stay
      exact, which is a confusing property to expose to a customer.

| Dataset | `index1` | Rationale |
| --- | --- | --- |
| `noti_delivery` | `orgid` | tenant-scoped volume; a single noisy tenant is sampled, not the whole dataset |
| `noti_ingress` | `connectionid` | connection-level volume |
| `noti_routing` | `orgid` | rule-evaluation volume, correlated with delivery |
| `noti_platform` | `stage` | our own health; never tenant data |

- [ ] Blobs are **low-cardinality enums only**: `event_type_id`, `destination_provider`,
      `outcome`, `error_code` (F13), `rule_id`, `state`. No free text, no repository names, no
      actor logins, no URLs.
- [ ] Doubles are **numeric facts only**: `latency_ms`, `attempt`, `count`, `bytes`, `group_size`.
- [ ] ⭐ **Tenant id is never a blob and never an event payload.** It is the index, so the
      dataset is queried scoped, not filtered after the fact.
- [ ] ⭐ **Sampled at the call site before storage.** The sampling decision is made in our code
      before `writeDataPoint`, because the platform's `head_sampling_rate` cannot drop
      individual lines from a collected request. Sampling rates per `(dataset, class)` are
      declared in configuration and asserted at boot (F04).
- [ ] Sampling rates are **different by class**, and the important classes are never sampled:

| Class | Rate | Why |
| --- | --- | --- |
| Failures, dead letters, DLQ entries, unmapped types | **1.0 — never sampled** | rare and load-bearing |
| Rule-evaluation misses | 1.0 | needed for F164's suppression accounting |
| Successful deliveries | configurable, default **0.05** | volume without signal |
| Ingress acknowledgements | default **0.02** | lowest information density |

- [ ] Every sampled datapoint carries its own `sample_rate` as a double, so a query can be
      weighted by it exactly the way `_sample_interval` weights Cloudflare-side samples. The two
      weights multiply; both are surfaced.
- [ ] ⭐ **The 250-datapoints-per-invocation cap is enforced in code**, not discovered in
      production: a per-invocation counter, an assertion, and a metric when the budget is
      approached. A batched delivery consumer that writes one datapoint per message can exhaust
      it at 250 messages with `max_batch_size` set above that.
- [ ] `blob` totals stay under **16 KB per datapoint** and the index under **96 bytes**, both
      asserted at compile time by the typed writer — `orgid` is 32 chars, so a compound index
      like `orgid + destination` is still well under 96 bytes and is permitted.
- [ ] Nothing is written from a context without a `DATASET` binding; the writer throws at
      startup rather than silently dropping.
- [ ] **Retention is Cloudflare's, not ours**: three months. We do not present AE data as a
      durable record and we do not backfill it into D1.

**Design** — Analytics Engine is the right tool for exactly one job here: long-tail product
analytics at zero query cost, with unlimited cardinality, that would otherwise mean either a
warehouse or writing every counter into D1 and paying for it in rows read and written. It is
the wrong tool for correctness-critical counting, for two reasons.

First, the counts are **estimates under load**. The SQL API documents that `COUNT()` must be
replaced by `SUM(_sample_interval)` *"if you are doing statistical analysis"* — which means a
dashboard built naively over AE will silently report exact-looking numbers that are not. Second,
the price of ingestion is about to change (F196), and AE retention is fixed at three months,
which is shorter than our 90-day delivery metadata.

So the split is: **D1 holds exact counts for anything we alert on or bill on; AE holds trend
data for anything we want to understand.** Every query helper therefore carries its provenance,
and the UI renders "estimated" next to a number that came from AE.

Choosing the index per dataset, and choosing it as `orgid`, is the single most consequential
decision in this feature. Because Cloudflare samples per index, indexing on something like
`event_type` would sample the popular types across every tenant; indexing on `orgid` confines
sampling to whichever tenant is actually generating volume, and even then the UI can say
"estimate" for one tenant's chart without making the other 49 customers' numbers wrong.

**Schema**

```ts
// F191 — one index per dataset is a platform constraint, not a preference.
export type DatasetName = 'noti_delivery' | 'noti_ingress' | 'noti_routing' | 'noti_platform';

export const DATASET_INDEX: Record<DatasetName, string> = {
  noti_delivery: 'orgid',          // tenant-scoped volume; sampling stays inside one tenant
  noti_ingress:  'connectionid',
  noti_routing:  'orgid',
  noti_platform: 'stage',
};

// Blobs are a CLOSED enum set. There is nothing to redact because there is
// nothing free-form (F195 removes the exit point rather than guarding it).
export type BlobField =
  | 'event_type_id' | 'destination_provider' | 'outcome' | 'error_code'
  | 'rule_id' | 'state' | 'queue' | 'job' | 'stage';

export type DoubleField =
  | 'latency_ms' | 'attempt' | 'count' | 'bytes' | 'group_size' | 'sample_rate';

export type MetricClass =
  | 'failure'        // rate 1.0 — never sampled
  | 'rule_miss'      // rate 1.0 — F164 suppression accounting
  | 'success'        // default 0.05
  | 'ack';           // default 0.02

export const SAMPLE_RATE: Record<MetricClass, number> = {
  failure: 1, rule_miss: 1, success: 0.05, ack: 0.02,
};

// Compile-time budget, enforced by the typed writer (F191):
//   1 index · <=96 B index · <=20 blobs · <=20 doubles · <=16 KB blobs per datapoint
//   <=250 datapoints per Worker invocation  (runtime counter + metric at 80%)
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Datapoint budget (250/invocation) approached | `metrics_budget_near` at 80%, write continues to 250, remaining events are dropped **with a counter**, never silently |
| Index string > 96 bytes | Programming error; throws at the typed writer, caught by a unit test over every index we emit |
| Blob total > 16 KB | Programming error; same guard |
| Analytics Engine binding missing | Startup fails (F04), not runtime degradation |
| Query returns rows with mixed `_sample_interval` | The query helper **must** use `SUM(_sample_interval)`; a helper that omits it fails a lint rule |

**Security** — Metrics carry **no payload, no repository name, no actor login, no URL**. Tenant
isolation is structural: `orgid` is the index, and every query is scoped to a single `index1`
value before any aggregation. A metric cannot become an analytics side channel (which
`docs/SECURITY.md` explicitly forbids: *"Do not expose raw private event payloads to other
tenants, analytics, AI providers or error trackers"*).

**Tests**
- `every_datapoint_carries_at_most_one_index`
- `index_and_blob_limits_are_asserted_by_the_typed_writer`
- `per_invocation_datapoint_budget_is_enforced_and_reported`
- `failure_and_dead_letter_datapoints_are_never_sampled`
- `sampled_datapoints_carry_their_own_sample_rate`
- `metric_blobs_contain_no_payload_repository_or_actor`
- `query_helpers_never_use_count_without_sample_interval` (lint)

**Deps** — F04, F13, F196, F198.

---

## F192 — Scheduled job runner and job health

**Priority** P0 · **Status** 🟡 `runCronJobs` records every execution in `job_state` (one upserted row per job) and `job_runs` (failures and outcome changes; migration 0027: ok, failed, skipped, integer counters, closed error class; 14-day retention), one typed cadence table (`src/observability/cadence.ts`), staleness at 3x cadence from D1 (`job-health.ts`) shown in the summary and as the `job_stale` alert, a DLQ consumer run record (ADR 0024; `tests/observability/job-runner.test.ts`). Not built: `job_cursors`, leases, resumable cursors, `cpu_ms`, `partial`, `job_failing`, a separate `job_never_ran` (a never-run job goes stale after 3 cadences of tracking). · **Referenced by F51, F171, F174, F190**

**Story** As an operator, I want every background job to report whether it ran, how much it did
and how fresh it is, so that a job which quietly stopped is indistinguishable from a job with
nothing to do — never again.

**Acceptance** — F190 owns *which* jobs exist and on what cadence. This owns *how a job runs*.

- [ ] One `runJob(name, ctx)` wrapper owns the entire lifecycle so no job can opt out:

```ts
type JobOutcome = 'ok' | 'partial' | 'failed' | 'skipped_locked';

type JobResult = {
  job: string;
  outcome: JobOutcome;
  started_at: number; finished_at: number;
  cpu_ms: number; items_seen: number; items_done: number;
  cursor: string | null;             // resume point, persisted
  error_code?: TaxonomyCode;         // F13
};
```

- [ ] Results are written to `job_runs` in **D1**, not to logs, so a Free-plan ingestion stop
      does not erase the evidence that a job stopped.
- [ ] ⭐ **Staleness is an alert, not a log line** (F200): a job whose
      `MAX(finished_at)` is older than `3 × its cadence` raises `job_stale`. A job that has
      never run raises `job_never_ran`. These are checked by the health endpoint (F10), which is
      the one thing that does not depend on log ingestion.
- [ ] Every job is **chunked and resumable** via a persisted `cursor`, bounded to fit the
      **30-second cron CPU budget**. ⭐ All jobs run on intervals shorter than one hour, so the
      applicable cron CPU limit is 30 s, not the 15 min that applies at `>= 1 hour`
      ([workers/platform/limits](https://developers.cloudflare.com/workers/platform/limits/),
      read 2026-10-13) — this resolves the contradiction recorded in
      `01-platform-runtime.md`.
- [ ] Concurrency: a job acquires a **lease** row with a conditional `UPDATE … WHERE
      state='free'` (the same atomic-claim pattern as F172, and for the same reason — D1
      serialises writes). A job whose previous lease is unexpired exits `skipped_locked`
      rather than duplicating work.
- [ ] A job that exceeds its CPU budget **stops cleanly at the last committed cursor** and
      records `partial`. It never continues past the budget hoping.
- [ ] `cpu_ms` is measured per job and alerted on a rising trend, because a job approaching the
      cron limit is the standard way a background system degrades quietly.
- [ ] Job errors carry an `error_code` from the F13 taxonomy. Free text is never the
      classification.
- [ ] Every job declares its expected cadence in one table, and the fleet, the staleness
      check, and the runbook (F201) all read from that one table.

**Design** — The failure mode this feature exists to prevent is the most common way a system
looks healthy while it is losing data: a job that stopped running at the last deploy, with no
error anywhere, because nobody was measuring its freshness. A cron that fires and returns
`ok` writes nothing; a cron that *did not fire* writes nothing either. Only an explicit
staleness check against a separate clock distinguishes the two, which is why the check lives in
the health endpoint and the result lives in D1.

The lease follows F172 deliberately. D1 is single-threaded, so a conditional `UPDATE` is
genuinely atomic here and there is no reason to invent a more elaborate scheme. Two overlapping
runs of the retention purge would be a data-loss incident, not a performance annoyance.

The 30 s budget is why every job is resumable rather than "just make it faster". The
alternative — a job that must complete in one pass — forces the job to do less work and leaves
data behind whenever the dataset outgrows the assumption.

**Schema**

```ts
// F192 — F190 owns which jobs exist; this owns how one runs.
export type JobName =
  | 'outbox_reconciler' | 'dedup_purge' | 'retention_purge'
  | 'github_delivery_failure_poll' | 'github_reconcile'
  | 'destination_health' | 'connection_token_refresh';

export type JobOutcome = 'ok' | 'partial' | 'failed' | 'skipped_locked';

export type JobResult = {
  job: JobName;
  outcome: JobOutcome;
  started_at: number; finished_at: number;
  cpu_ms: number; items_seen: number; items_done: number;
  cursor: string | null;                 // resume point, persisted
  error_code?: TaxonomyCode;             // F13 — never free text
};
```

```sql
-- Results live in D1, not in logs: on Free, ingestion STOPS when the daily
-- allowance is reached (F196) — evidence must survive that.
CREATE TABLE job_runs (
  job TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
  outcome TEXT NOT NULL, cpu_ms INTEGER NOT NULL DEFAULT 0,
  items_seen INTEGER NOT NULL DEFAULT 0, items_done INTEGER NOT NULL DEFAULT 0,
  cursor TEXT, error_code TEXT, stage TEXT,
  PRIMARY KEY (job, started_at)
);
CREATE INDEX ix_job_runs_latest ON job_runs(job, finished_at DESC);

CREATE TABLE job_cursors (        -- one live lease per job (F172 pattern, D1 is single-writer)
  job TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'free',
  cursor TEXT, lease_expires_at INTEGER, holder TEXT, updated_at INTEGER NOT NULL
);
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Lease held by another run | `skipped_locked`, no error, no metric spike |
| Job exceeds CPU budget | Stop at last cursor, `partial`, `job_cpu_budget_exceeded` |
| Job throws | `failed` with `error_code`; retried on the next tick with jitter |
| Job fails repeatedly | `job_failing` alert after 3 consecutive failures (F200) |
| Cursor is stale beyond the retention horizon | Restart from the beginning of the window, record `cursor_reset` |
| Cron CPU is 15 min not 30 s on a future plan | The wrapper's own measured `cpu_ms` alert catches it before it bites |

**Security** — Jobs run with the same repository layer and the same `orgid` predicates as the
request path (F24); a job is not a privileged context. Job code never receives a decrypted
destination secret unless the job's declared purpose requires it, and the retention purge
deletes ciphertext without decrypting it.

**Tests**
- `every_job_writes_a_result_row_to_d1`
- `job_staleness_is_detected_from_d1_not_from_logs`
- `overlapping_job_runs_are_prevented_by_the_lease`
- `a_job_that_exceeds_its_budget_stops_at_the_last_cursor`
- `jobs_are_chunked_and_resume_from_the_persisted_cursor`
- `job_errors_use_the_taxonomy_not_free_text`
- `cadence_table_is_the_single_source_for_fleet_staleness_and_runbook`

**Deps** — F04, F10, F13, F171, F172, F174, F190, F200, F201.

---

## F193 — Correlation id propagation

**Priority** P0 · **Status** 🟡 Our UUID is minted at ingress before parsing, `external_request_id` and `cf_ray` captured, `x-request-id` echoed, id on every in-request log line, and (ADR 0024) stored on `deliveries`, `notification_outbox` and `delivery_attempts`, carried in the queue message, bound in the consumers' log lines, shown in the delivery view and found by `GET /api/deliveries?correlationId=` (`tests/sources/correlation.test.ts`, which also asserts that a foreign workspace gets 404 or nothing). ADR 0046: a cron-run outbox row names its id in every line, a failed send logs `outbox_send_failed`, a failed noise-release batch logs each notification's id, and `correlation_missing` is logged once per message or row without one (`tests/sources/correlation.test.ts`). Held events: a released notification gets a fresh id and links back through `held_events.id` and `released_in` (`tests/noise/correlation.test.ts`); the ingress id is not stored on a held event (a column would need a migration). Error bodies carry the id (ADR 0028). ADR 0050: the delivery detail dialog shows the id in monospace under "Details for support", copyable, with a link to the delivery log filtered by it, and the log takes the id as a filter (`web/src/a11y/request-and-impact.a11y.test.tsx`). Not built: `X-Noti-Correlation-Id` storage, Analytics Engine blobs, the support bundle, the ingress id on held events. · **Extends F11 — does not redefine it**

**Story** As a support engineer, I want one identifier that survives the whole path from webhook
receipt to rendered message, so that a customer can quote it and I can find the exact event.

**Acceptance** — F11 mints the id and fixes the log key set. This specifies where it must
**travel**, and the three places it is currently absent.

- [ ] Minted at ingress, before any parse, so a signature failure — which never reaches a
      consumer — is still traceable (F11).
- [ ] Propagated to: the D1 `events` row, the outbox row, the **queue message body**, every
      consumer log line, the `deliveries` and `delivery_attempts` rows, the evaluation trace
      (F137), Analytics Engine blobs (F191), the dead-letter record (F181), the support
      evidence bundle (F202), and the user-visible delivery detail.
- [ ] ⭐ The queue message carries it explicitly. Queue messages carry identifiers only (F173),
      and `correlation_id` is an identifier, so this adds 36 bytes to a body capped at 4 KB by
      construction against a 128 KB platform limit.
- [ ] Format: UUIDv4, lower-case, canonical 8-4-4-4-12. It is an **opaque handle** — it
      carries no timestamp, no tenant prefix and no sequential component, because a partially
      guessable id invites enumeration of other tenants' event streams.
- [ ] The same `correlation_id` **may** span multiple deliveries (one event, many
      destinations). The per-delivery identity is `delivery_id`; conflating the two would make
      "show me everything about this notification" ambiguous.
- [ ] User-supplied correlation: a customer may supply their own id in a header we accept
      (`X-Noti-Correlation-Id`), which is **stored alongside** ours, not instead of it, and is
      length-capped at 64 chars and character-restricted. Ours is never replaced, because a
      provider could then choose a value that collides with a real one.
- [ ] A message or row that arrives without a `correlation_id` (pre-migration rows, a hand-made
      message) logs `correlation_missing` exactly once (F11) and continues — the missing field
      is never a reason to drop a notification.
- [ ] Retention: `correlation_id` is retained as long as the row it annotates. After the event
      row is purged (F51), the delivery metadata keeps it for the remainder of its 90 days, so
      a customer reporting an old notification still finds something.

**Design** — The id exists to convert a support conversation into a lookup. That only works if
it is on *both* sides of every boundary, and the boundaries that are easy to forget are the
ones that matter: the queue message (where a crash makes the id vanish from the visible path),
the evaluation trace (where "why did I get this" is answered), and the Analytics Engine blob
(where a trend becomes a single event). A correlation id that appears only in logs is worth
little once the log retention window is 3 days on Free.

Propagating a **provider-supplied** id alongside ours, rather than instead of it, is the
security call. Provider ids are enumerable and collision-prone; ours is a v4 UUID that we minted
before we knew anything about the payload.

**Schema**

```ts
// F193 — F11 mints the id and fixes the log key set. This is where it must travel.
export type CorrelationId = string & { readonly __brand: 'uuidv4' };  // 8-4-4-4-12, lower-case

export type PropagatedIds = {
  correlation_id: CorrelationId;        // ours; never replaced
  external_correlation_id?: string;     // provider-supplied, 64-char cap, stored separately
  cf_ray?: string;                      // captured alongside, never a substitute
};

// Carried on the queue message body (identifiers only, F173) — 36 bytes added
// to a body capped at 4 KB by construction against a 128 KB platform limit.
export type QueueMessage = {
  delivery_id: string;
  orgid: string;
  dedup_key: string;
  correlation_id: CorrelationId;
  attempt: number;
};

// One correlation_id MAY span many deliveries (one event, several destinations).
// The per-delivery identity is delivery_id; conflating them makes
// "show me everything about this notification" ambiguous.
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Missing `correlation_id` on a message or row | `correlation_missing` logged once; processing continues |
| Supplied header id too long or with illegal characters | Header ignored; ours used; `correlation_id_rejected` metric |
| Supplied header id equals an existing one | Stored as `external_correlation_id`; no collision with our internal id space |
| Row purged | Delivery metadata retains the id for its own retention window |

**Security** — A `correlation_id` is a **capability-adjacent identifier**: possessing one lets
a support engineer read one event. It is therefore (a) never guessable, (b) never returned to a
user who is not authorized for that org, and (c) not usable as an authorization input anywhere.
A `GET` of a delivery by correlation id resolves the org first and returns `404` (not `403`) if
the caller is not a member, so the endpoint does not confirm that an id exists.

**Tests**
- `correlation_id_is_stable_from_ingress_through_delivery_and_ledger`
- `correlation_id_is_present_in_the_queue_message_body`
- `correlation_id_survives_into_the_evaluation_trace_and_metric_blob`
- `external_correlation_id_is_stored_separately_and_never_replaces_ours`
- `missing_correlation_id_logs_once_and_does_not_drop_the_delivery`
- `delivery_lookup_by_correlation_id_returns_404_for_non_members`

**Deps** — F11, F50, F51, F173, F181, F184, F191, F202.

---

## F194 — Structured log event catalogue

**Priority** P0 · **Status** 🟡 `log()` in `src/platform/log.ts` emits one redacted JSON line with `correlation_id`, `external_request_id` and `cf_ray` inside a request; `msg` is a closed catalogue with a description and declared fields per event (`src/platform/log-events.ts`; an unknown event or undeclared field is a compile error), `docs/LOGS.md` is generated from it and drift-tested, every call site including the former raw `console.error` ones goes through `log()`, and each line is held to a 4096-byte budget without mid-JSON truncation (ADR 0051; `tests/platform/log.test.ts`, `tests/platform/log-events.test.ts`, `tests/docs/logs-doc.test.ts`). Not built: per-invocation byte budget and `logs_dropped_budget` counter, `debug` level and sampling, dotted event names, typed field values, invocation logs off for the consumer. · **Extends F11's key set — does not duplicate it**

**Story** As an engineer debugging at 2am, I want every log line to have the same shape and to
name a known event, so that I can filter without reading.

**Acceptance**
- [ ] A log line is **one JSON object per `console.*` call**. Cloudflare's own guidance is that
      logging a JSON object is what makes fields indexable: `console.log({user_id: 123})`
      becomes filterable, while `console.log("user_id: " + 123)` becomes a text blob
      ([workers-logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/),
      read 2026-10-13).
- [ ] F11's fixed key set is the base and is unchanged. This feature adds the **catalogue**:
      every `msg` value is a member of a closed union, declared in code.

```ts
type LogEvent =
  | 'ingress.received' | 'ingress.rejected' | 'ingress.acked' | 'ingress.duplicate'
  | 'rule.evaluated' | 'rule.compile_failed' | 'rule.cache_miss'
  | 'outbox.claimed' | 'outbox.dispatched' | 'outbox.stalled'
  | 'delivery.attempt' | 'delivery.accepted' | 'delivery.delivered' | 'delivery.failed'
  | 'delivery.dead_lettered' | 'delivery.suppressed_duplicate'
  | 'queue.message_deduped' | 'queue.message_retry'
  | 'job.started' | 'job.chunk_complete' | 'job.finished'
  | 'circuit.opened' | 'circuit.closed'
  | 'config.invalid';
```

- [ ] Levels: `debug` (sampled at 0.1 by default), `info`, `warn`, `error`. `error` is reserved
      for conditions that require an operator.
- [ ] ⭐ **Every `warn`/`error` has a machine-readable companion.** A line that matters for
      alerting is also written to D1 (F192/F200). A log line is evidence; it is never the
      detector.
- [ ] The base key set plus additions:

| Key | Type | Notes |
| --- | --- | --- |
| `ts, level, msg, correlation_id, workspace_id, integration_id, delivery_id, event_type, destination, outcome, error_code` | — | F11's set, verbatim |
| `rule_id`, `rule_version` | string, int | F137 |
| `attempt`, `latency_ms`, `http_status`, `provider_code` | int | F184 |
| `queue`, `job`, `stale`, `sample_rate` | string, int, num | F192, F191 |
| `cf_ray` | string | captured alongside, never replacing the correlation id |

- [ ] **No key is added without adding it to this table.** The type is the check; an unknown key
      is a compile error.
- [ ] Per-line size is budgeted against the **256 KB per-request platform cap**, which covers
      *all* `console.log`, exceptions, request metadata and headers for a single request — after
      which *"the system does not record additional context for that request"*
      ([workers/platform/limits](https://developers.cloudflare.com/workers/platform/limits/),
      read 2026-10-13). Batching a queue consumer that logs per message would hit it, so the
      budget is enforced: one summary line per invocation plus bounded per-message lines.
- [ ] A line that would exceed the budget is **dropped and counted**, never truncated mid-JSON
      (a truncated JSON line is unparseable and wastes the same bytes).
- [ ] Development/staging/production sampling rates are declared in `wrangler.jsonc` per
      environment (`observability.head_sampling_rate`), which is why that setting exists
      separately per environment.
- [ ] `observability.logs.invocation_logs = false` is set for the delivery consumer, which has
      one invocation per batch and no useful invocation-level shape; it is a direct ingestion
      saving with no diagnostic loss.

**Design** — The fixed key set from F11 is necessary but not sufficient. A key set tells you the
shape; a **catalogue** tells you what can possibly have happened, and that is what makes
`msg` filterable as an enum rather than as free text someone greps for. It is also what makes
"which log lines exist?" answerable, which is the question every on-call hour asks.

The budget point is not obvious and was worth the research: the 256 KB limit is **per request**,
not per line, and it counts exceptions and request metadata too. A queue consumer with
`max_batch_size: 10` that logs 20 KB per message hits it on the fifth message and then loses
*all* logging for the rest of that invocation, including the error that explains why. Bounded
logging is therefore a correctness control for the debug path, not a tidy-up.

Disabling invocation logs on the delivery consumer is the one zero-risk saving available: the
invocation record for a queue consumer carries only the queue name and timing, both of which we
record more precisely ourselves in `delivery_attempts`.

**Schema**

```ts
// F194 — F11's fixed key set is the base, unchanged. This adds the catalogue:
// every `msg` is a member of a closed union, so an unknown event is a compile error.
export type LogEvent =
  | 'ingress.received' | 'ingress.rejected' | 'ingress.acked' | 'ingress.duplicate'
  | 'rule.evaluated' | 'rule.compile_failed' | 'rule.cache_miss'
  | 'outbox.claimed' | 'outbox.dispatched' | 'outbox.stalled'
  | 'delivery.attempt' | 'delivery.accepted' | 'delivery.delivered' | 'delivery.failed'
  | 'delivery.dead_lettered' | 'delivery.suppressed_duplicate'
  | 'queue.message_deduped' | 'queue.message_retry'
  | 'job.started' | 'job.chunk_complete' | 'job.finished'
  | 'circuit.opened' | 'circuit.closed'
  | 'config.invalid';

export type Level = 'debug' | 'info' | 'warn' | 'error';

export type LogLine = {
  // F11's set, verbatim
  ts: number; level: Level; msg: LogEvent;
  correlation_id?: string; workspace_id?: string; integration_id?: string;
  delivery_id?: string; event_type?: string; destination?: string;
  outcome?: string; error_code?: TaxonomyCode;
  // additions, each one a deliberate cost decision (F196)
  rule_id?: string; rule_version?: number;
  attempt?: number; latency_ms?: number; http_status?: number; provider_code?: string;
  queue?: string; job?: JobName; stale?: boolean; sample_rate?: number;
  cf_ray?: string;
  // an unknown key here is a compile error, which is the point
};

// Per-invocation budget against the 256 KB platform cap, which covers ALL
// console.log + exceptions + request metadata + headers for one request.
export type LogBudget = { emitted_bytes: number; dropped: number; cap_bytes: number };
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Unknown `msg` value | Compile error; the union is exhaustive |
| Line would exceed the per-invocation budget | Dropped, counted in `logs_dropped_budget` |
| Log line fails to serialize | Drop the fields, keep the line (F12) |
| Platform truncates a log | `$cloudflare.truncated` is set by Cloudflare; our budget is set well below it so we detect our own case first |

**Security** — Every value passes F12's `redact()` **before** the `console` call, never on the
way to storage. Rule names and destination names are user content: capped and escaped (F94).
The catalogue is a deny-by-default surface — adding a key to it is a review event, which is the
review gate we want for a place where a secret would be invisible.

**Tests**
- `log_msg_is_a_member_of_the_closed_catalogue`
- `log_lines_match_the_declared_key_set_exactly`
- `structured_logging_is_used_for_every_line`
- `per_invocation_log_budget_is_enforced_and_dropped_lines_are_counted`
- `invocation_logs_are_disabled_on_the_delivery_consumer`
- `log_output_contains_no_denylisted_key` (inherited from F12, re-run over the catalogue)

**Deps** — F04, F11, F12, F94, F137, F184, F191, F192, F195.

---

## F195 — Redaction enforcement points

**Priority** P0 · **Status** 🟡 `redact()` runs on every `log()` line and delivery diagnostics are minted codes only (`src/platform/redact.ts`, `tests/platform/redact.test.ts`); for the console exit point, ESLint `no-console` is an error in `src/` except `src/platform/log.ts`, and `tests/security/log-redaction-site.test.ts` asserts from the AST that no other file references `console`, that `log.ts` redacts in exactly one call, that every catalogued event is redacted exactly once with no planted secret surviving, and that a redaction failure drops fields and keeps the line (ADR 0051). Not built: property test over provider bodies, the inventory and one-site tests for the other exit points (D1 detail columns, dead-letter view; Analytics Engine and support bundle do not exist yet). · **Enforces F12 — does not redefine it**

**Story** As a customer, I want the redaction guarantee to hold at every place data leaves our
process, not just in logs, so that adding a new feature cannot quietly reintroduce a leak.

**Acceptance** — F12 owns the denylist and the algorithm. This owns the **call sites**, and the
reason it is a separate feature: redaction that is correct but applied at five of nine exit
points is a control that fails silently.

| Exit point | Rule |
| --- | --- |
| `console.*` | `redact()` at the call site (F12). `JSON.stringify(providerResponse)` is a lint error. |
| Error objects | `redact()` preserves `name` and `code`, scrubs `message` (F12). Applied before the error enters a job result or a delivery row. |
| D1 columns | `error_detail_redacted` is redacted **before** the write (F184), never on read. |
| Analytics Engine blobs | Only the closed low-cardinality enum set is permitted (F191); anything else is a programming error, which removes the exit point rather than guarding it. |
| Dead-letter detail view | Rendered payload redacted exactly as the test preview is (F181, F98). |
| Support evidence bundle | Redacted at pack time; the bundle is a separate artifact with its own retention (F202). |
| Rule names / destination names in a destination message | Length-capped and escaped per F94, never interpolated as markup. |
| AI providers | **Not wired in V1.** When AI is added, it is a new exit point and requires its own entry in this table before any payload leaves. |

- [ ] A static check asserts every `console.*` call in `src/` takes its argument from
      `redact()` or is a literal with no interpolated provider data. The check is a lint rule,
      not a review habit.
- [ ] A property-based test generates synthetic provider responses (Lark, Slack, Teams, Discord
      error bodies) and asserts no denylisted key survives a round trip through any exit point.
- [ ] The destination **hostname** is loggable; the full URL is not. Path is truncated to the
      first segment (F08). Lark custom-bot URLs are bearer secrets (F101) and are never logged
      at any verbosity.
- [ ] `email` stays on the denylist by default. Tenant PII reaching logs is opt-in, per
      workspace, and the opt-in is recorded.
- [ ] ⭐ Redaction failures **drop fields, never the line** (F12). A log that fails to emit is
      worse than a log with gaps, and a redaction bug must not become an outage.
- [ ] Every redaction call site has a test. The count of sites and the count of tests are
      asserted to be equal by a static check, so a new exit point cannot skip its test.
- [ ] The support bundle is the only artifact that carries customer data outside our database,
      and it carries a **creation reason, an actor and an expiry** (F202).

**Design** — F12 already requires redaction at the call site and already forbids raw
`JSON.stringify`. What it does not do is enumerate the places where data can leave, and the
list grows as the product grows: logs were one, D1 detail columns were already there, Analytics
Engine blobs are new, the support bundle is new, and an AI provider would be a genuinely
dangerous one. A control with no inventory degrades.

The approach here is deliberately asymmetric. For low-cardinality enums (metric blobs) we
remove the exit point by construction rather than guarding it — there is nothing to redact if
only a closed set of enum values may be written. For free-form provider data we guard at the
call site, because there is no way to remove it. New exits should always prefer the first
strategy.

**Schema**

```ts
// F195 — F12 owns the denylist and the algorithm. This is the INVENTORY of
// places data leaves the process. Adding a row here is a review event.
export type RedactionSite =
  | 'console'              // redacted at the call site (F12)
  | 'error_object'         // preserves name + code, scrubs message
  | 'd1_error_detail'      // redacted BEFORE the write, never on read (F184)
  | 'analytics_blob'       // closed enum only — the exit point is removed, not guarded
  | 'dead_letter_view'     // redacted exactly as the test preview (F181, F98)
  | 'support_bundle'       // redacted at pack time (F202)
  | 'destination_message'  // user text: capped + escaped per F94
  | 'ai_provider';         // NOT WIRED IN V1 — adding one requires a row here first

export type RedactionPolicyVersion = 1;

// A new site without a test is a lint failure: sites and their tests are
// asserted to be one-to-one.
export const REDACTION_SITES: readonly RedactionSite[] = [
  'console', 'error_object', 'd1_error_detail', 'analytics_blob',
  'dead_letter_view', 'support_bundle', 'destination_message',
];
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| `redact()` itself throws | Drop the fields, emit the line with `redaction_failed`, continue |
| A blob value is not in the permitted enum set | Programming error; the typed writer throws; caught by a unit test over every emitted blob |
| Support bundle exceeds its size budget | Truncated at the **bundle** level (field list, then attempt list), `bundle_truncated: true`, stated in the bundle header |

**Security** — This feature **is** the control that makes `docs/SECURITY.md`'s prohibition on
exposing payloads to *"other tenants, analytics, AI providers or error trackers"* enforceable
rather than aspirational. It has not been the subject of a security audit — `docs/SECURITY.md`
states plainly that *"No formal security audit has been performed"* — so these tests are our
evidence, not a certification, and this file makes no claim beyond that.

**Tests**
- `every_console_call_takes_redacted_input` (lint)
- `redaction_call_sites_and_their_tests_are_one_to_one`
- `no_blob_value_outside_the_permitted_enum_set_is_writable`
- `destination_urls_never_appear_at_any_verbosity`
- `redaction_failure_drops_fields_and_keeps_the_line`
- `support_bundle_is_redacted_at_pack_time`

**Deps** — F08, F12, F98, F101, F181, F184, F191, F202.

---

## F196 — Observability cost control under the 2026-12-01 pricing change

**Priority** P1 · **Status** ❌ No log sampling, ingestion estimate, per-environment budget, degraded mode or observability block in `wrangler.jsonc`; the cost-control ADR is not written (ADR 0011 defers it). Date-driven: Cloudflare pricing changes 2026-12-01. · **Date-driven: 7 weeks from this spec**

**Story** As an operator, I want observability spend bounded by design rather than discovered on
a bill, so that the December pricing change cannot turn a traffic spike into a surprise.

**Acceptance** — the change is documented and dated: *"Beginning December 1, 2026, all
Cloudflare logs and traces will use the same pricing model… Existing Workers Observability
customers on Free, Pro, and Business plans automatically move to this pricing on December 1,
2026."* ([observability/pricing](https://developers.cloudflare.com/observability/pricing/),
read 2026-10-13).

| Plan | Included ingestion | Included storage | Additional ingestion | Additional storage |
| --- | --- | --- | --- | --- |
| Free | **0.5 GB/day** | 7-day retention, not separately metered | **not available** | — |
| Paid | **50 GB / billing cycle** | **10 GB-month / cycle** | **$0.25 / GB** | **$0.10 / GB-month** |

- [ ] ⚠️ ⭐ **On Free, exceeding the daily allowance stops ingestion entirely**: *"Cloudflare
      stops ingesting new data when the account reaches its daily limit. Ingestion resumes when
      the allowance resets at 00:00 UTC."* There is no overage tier and no alert before it
      happens — logging simply stops. **Consequence, and it is architectural:** on Free,
      observability is unavailable during a spike, which is the only time it is wanted. Every
      alerting signal therefore lives in **D1** (F192, F200), and no detection depends on log
      ingestion.
- [ ] On Paid, *"Paid usage continues automatically after an allowance is exhausted"* — so an
      overrun bills rather than truncating. We add a **budget alert** on Cloudflare's billable
      usage rather than assuming truncation, and we do not rely on Cloudflare to stop the meter.
- [ ] ⭐ **Sample before storage, in our code, at the call site.** The docs are explicit that
      *"Sampling data before storage reduces both ingestion and storage usage"* — both meters,
      not one. The platform's `head_sampling_rate` cannot achieve this: it samples by request
      and *"All logs within the context of the request are collected"*
      ([workers-logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/),
      read 2026-10-13). Per-line sampling is our job (F191, F194).
- [ ] **Ingestion is measured pre-compression and includes** *"the event body, the default
      enriched attributes, and custom attributes"* — so the size of a log line is our line plus
      Cloudflare's enrichment, and custom attributes are not free. We therefore keep the custom
      key set small and stop adding keys for marginal value.
- [ ] Declared per-environment budgets, asserted by a startup check (F04) and reported:

| Environment | `head_sampling_rate` | `debug` rate | Expected logs/day |
| --- | --- | --- | --- |
| local | 1 | 1 | n/a |
| staging | 1 | 1 | low volume, retention is cheap |
| production | **0.05** | **0.1** | **⚠️ UNVERIFIED — to be measured**, see below |

- [ ] ⭐ **⚠️ UNVERIFIED — we have not measured our daily ingestion volume and this file states
      no number for it.** *What to check:* before 2026-12-01, enable billable usage, measure
      actual GB/day at production traffic for 14 days including one synthetic peak, and set
      `head_sampling_rate` from the measurement. A figure asserted here without that measurement
      would be exactly the fabricated benchmark `AGENTS.md` forbids.
- [ ] A **daily ingestion estimate** is computed in-product from our own datapoint and line
      counts and compared against the plan allowance, alerting at 50% and 90% of 0.5 GB. This
      is a D1-computed number, not a Cloudflare-reported one, precisely because Cloudflare's
      number stops existing on Free.
- [ ] Storage is managed by retention, not by deletion: 7 days on the shared allowance. Nothing
      we write to logs is needed beyond a week, because the durable record is D1.
- [ ] The decision is recorded as an ADR: **we treat Cloudflare log storage as a diagnostic aid
      with a one-week horizon, never as a system of record.**
- [ ] On Free, a documented, tested **degraded mode**: when the daily ingestion budget is
      exhausted, the Worker raises `observability_budget_exhausted` in D1 once per day, drops to
      error-only logging, and the runbook (F201) says what to do.

**Design** — The pricing change is not interesting as a number; it is interesting as a forcing
function. Before it, the worst outcome of too much logging was a cost. After it, on Free the
worst outcome is **losing the ability to see anything during an incident**, with no warning and
no overage. That is a reliability regression disguised as a pricing change, and it is the
reason F193–F195 keep durable evidence in D1 and the reason F200 alerts read from D1.

Sampling before storage is the only lever that reduces *both* meters, and it has to be ours
because the platform's head sampling is the wrong granularity: it drops whole requests, and the
requests we most want to drop the *noisy lines from* are the ones with the interesting errors in
them.

The two plans need different strategies and we should not pretend otherwise. Free gets
degrade-and-alert; Paid gets measure-and-budget. `docs/IMPLEMENTATION.md` must state which one
production runs on, because F180 already notes that a 14-day dead-letter retention guarantee
requires Workers Paid and must be stated to customers rather than assumed — this is the same
discipline applied to logs.

**Schema**

```ts
// F196 — budgets are declared and validated at boot (F04). The production log
// volume is deliberately NOT stated: it has not been measured.
export type ObservabilityBudget = {
  stage: 'local' | 'staging' | 'production';
  head_sampling_rate: number;      // wrangler observability.head_sampling_rate
  debug_rate: number;              // our own debug-line rate, on top of head sampling
  daily_allowance_gb: number;      // Free: 0.5 · Paid: 50/30 days (read 2026-10-13)
  alert_at_pct: readonly number[]; // [0.5, 0.9]
};

// meters are separate and do not roll over; overage is metered on Paid only
export type PlanAllowance = {
  free: { ingestion_gb_per_day: 0.5; storage_gb_month: null; overage: 'none — ingestion STOPS' };
  paid: { ingestion_gb_per_cycle: 50; storage_gb_month: 10;
          overage_ingestion_per_gb: 0.25; overage_storage_per_gb_month: 0.10 };
};

// D1-computed estimate, because Cloudflare's number stops existing on Free.
export type IngestionEstimate = {
  day: string; stage: 'local' | 'staging' | 'production';
  estimated_gb: number; allowance_gb: number; fraction: number;
  degraded: boolean;              // error-only mode after Free exhaustion
};
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Daily allowance reached (Free) | Ingestion stops; `observability_budget_exhausted` in D1; error-only mode; runbook entry |
| Allowance exhausted (Paid) | Overage billing at $0.25/GB; budget alert fires from our own estimate |
| Estimated volume > 90% of allowance | `observability_budget_near` alert, sampling rates reviewed |
| Sample rates changed in production | Audited config change (F28); not a hotfix |
| Cloudflare changes the pricing before December | Re-read the pricing page and update this feature; the sampling strategy stands regardless |

**Security** — Sampling decisions are made on **class**, never on content: a line is sampled
because it is a successful delivery, not because it contains something we would rather not
store. Content-based sampling would make the sampling policy a data-retention policy, and the
two have different audit requirements.

**Tests**
- `free_plan_exhaustion_degrades_to_error_only_and_records_it_in_d1`
- `paid_plan_budget_alert_fires_from_our_own_estimate_not_from_cloudflare`
- `sampling_decisions_are_made_at_the_call_site_before_write`
- `production_sampling_rates_are_declared_per_environment_and_validated_at_boot`
- `no_detection_path_depends_on_log_ingestion`
- `ingestion_estimate_matches_platform_reported_ingestion_within_the_documented_tolerance`

**Deps** — F04, F11, F28, F180, F191, F192, F194, F200, F201.

---

## F197 — Delivery SLIs: accepted is not delivered

**Priority** P0 · **Status** 🟡 Per-workspace confirmed-delivery ratio, retry rate and dead-letter counts from D1 with numerator, denominator, window and null on empty; Teams reported as accepted (`src/observability/slis.ts`, `src/api/observability.ts`, `tests/observability/slis.test.ts`). Not built: acceptance, routing and duplicate rates (listed as notMeasurable), publication gate, any UI. · **The most honesty-sensitive feature in this file**

**Story** As a customer, I want the reliability number to mean what the word means, so that I can
decide whether to keep my own alerting or delete it.

**Acceptance** — four distinct rates, each computed from the D1 ledger, each with its own
definition. We publish no fifth.

| SLI | Definition | Source | Exact? |
| --- | --- | --- | --- |
| **Acceptance rate** | `events` durably stored ÷ ingress requests that reached durable acceptance, per provider | D1 | exact |
| **Routing rate** | events producing ≥1 delivery ÷ accepted events | D1 | exact |
| **Confirmed-delivery rate** *(per destination)* | deliveries with a provider-confirmed outcome ÷ delivery attempts | D1 | exact |
| **Duplicate rate** | deliveries suppressed by dedup, claim or provider idempotency ÷ attempts | D1 | exact |

- [ ] ⭐ **`confirmed-delivery` is destination-dependent and the UI must show which definition
      applies.** Per F100:

| Destination | What a success is |
| --- | --- |
| Lark custom bot / Lark app | provider `code: 0` — **delivered** |
| Slack webhook / Web API | `ok: true` — **delivered** |
| Teams **Workflows** | **202 — accepted only** |
| Discord (`wait=true`) | created message returned — delivered |
| Telegram | `message_id` returned — delivered |

- [ ] ⭐ **For Teams Workflows we publish an *acceptance* rate and label it as one.** Teams
      returns `202 Accepted with no meaningful body`; the flow can still fail after the 202
      (F99). There is no read-back API in the MVP path (F104), so the distinction is not
      measurable — it is not measured and it is not estimated.
- [ ] The UI string for a Teams delivery is **"Accepted by Teams"**, never "Delivered". There is
      a test asserting the literal string "Delivered" never appears against a Teams row (F185's
      `no_user_facing_text_claims_exactly_once` is the sibling guard).
- [ ] ⭐ **No published SLI claims exactly-once delivery, and no SLI is a percentage of
      "notifications that reached a human".** At-least-once is the contract
      ([queues/reference/delivery-guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)):
      *"in rare occasions, may be delivered more than once"*, and *"exactly once delivery incurs
      additional overheads in any messaging system"*. `AGENTS.md` and F185 both forbid the
      claim; the vocabulary is banned in code, docs, UI and marketing.
- [ ] Every SLI states its **denominator** and its **window** next to the number. A percentage
      with an unstated denominator is not published.
- [ ] Every SLI is computed from **D1**, exact for the retention window (90 days of delivery
      metadata). Anything longer is a trend and is labelled estimated (F191/F198).
- [ ] An SLI with **no data** renders as *"no deliveries in this period"* — never as `100%`,
      never as `0%`, never as an empty chart.
- [ ] When we have not measured something, the SLI is marked `not_measured` and does not appear
      on any public surface. `⚠️` No SLI in this table has been measured yet; none of them may
      be shown externally until it has.
- [ ] A status page, when we publish one, publishes **only** the acceptance rate and the
      confirmed-delivery rate per destination, with the Teams distinction visible. It does not
      publish an availability percentage for something we cannot observe.

**Design** — The entire feature is the `accepted` / `delivered` distinction, and it is not a
pedantic one. Teams Workflows returns `202` whether or not the flow subsequently succeeds. If we
report "99.9% delivered" for Teams we are reporting a number about our own HTTP client, not
about the customer's channel, and the customer will discover the gap exactly when a flow breaks
and no message appears — which is the moment our number mattered.

Keeping D1 as the source of all four SLIs is what makes them exact and what makes them survive
a log-ingestion outage (F196). The cost is that SLIs are only available for the 90-day delivery
window, which is why the "accepted rate" has a 90-day horizon and not a lifetime one. That is
stated rather than papered over with an all-time average.

We deliberately do not define an SLI for "user received the message". The only evidence we could
obtain is downstream of the destination, which we do not own and cannot instrument. Publishing a
number that looks like end-user experience while measuring HTTP status codes would be the same
class of dishonesty as the Teams problem, one level up.

**Schema**

```ts
// F197 — four rates, four denominators, four windows. No fifth rate is defined.
export type SliName =
  | 'acceptance_rate'        // events durably stored / ingress reaching durable acceptance
  | 'routing_rate'           // events producing >=1 delivery / accepted events
  | 'confirmed_delivery_rate'// per destination definition, see capability table
  | 'duplicate_rate';        // suppressed by dedup/claim/idempotency / attempts

export type Sli = {
  name: SliName;
  value: number | null;             // null => no data, NOT 0 and NOT 1
  numerator: number; denominator: number;
  window_days: number;
  exact: true;                      // D1 only; an AE-derived figure is not an SLI
  definition_note: string;           // rendered next to the number, always
  measured: boolean;                // false => not publishable (F204 slis.publish)
};

// The accepted/delivered distinction, per destination (F100).
export type DeliveryOutcomeKind = 'delivered' | 'accepted' | 'unconfirmed';

export type OutcomeByDestination = {
  lark_custom_bot: 'delivered'; lark_app: 'delivered';
  slack_webhook: 'delivered';    slack_api: 'delivered';
  teams_workflows: 'accepted';   // 202, no read-back in the MVP path (F104)
  discord_wait_true: 'delivered'; telegram: 'delivered';
};
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Teams `202` with no body | `accepted`, never `delivered`; UI string is "Accepted by Teams" |
| Provider returns `ok:true` with no message id (Slack `internal_error`) | Success **plus** a possible-duplicate flag (F185) |
| Discord 204 because `wait` was not set | Not confirmation; treated as `unconfirmed`, and this is a bug we assert cannot happen (F100) |
| SLI window contains no attempts | "No deliveries in this period" |
| Metric-derived figure presented as an SLI | Rejected — SLIs come from D1 only |
| Unmeasured SLI requested for publication | Refused by the publication gate (F204) |

**Security** — SLIs are tenant-scoped queries (F24). A workspace can see its own rates and
nothing else; an aggregate platform-wide rate is computed from a counter, not by fanning out
across tenants. No SLI exposes another tenant's event content, counts keyed to a tenant, or
repository names.

**Tests**
- `teams_202_is_recorded_and_reported_as_accepted_never_delivered`
- `confirmed_delivery_rate_is_computed_per_destination_definition`
- `slis_state_their_denominator_and_window`
- `an_empty_window_renders_as_no_data_not_zero_or_one_hundred_percent`
- `no_sl_value_is_computed_from_analytics_engine`
- `no_user_facing_text_claims_exactly_once_delivery`
- `no_unmeasured_sli_is_publishable`

**Deps** — F24, F51, F99, F100, F104, F184, F185, F191, F198, F204.

---

## F198 — Latency, queue depth and reliability measurement

**Priority** P1 · **Status** 🟡 Exact end-to-end and queue-delay p50/p95 from `deliveries` timestamps at one-second resolution plus backlog age from D1, no averages (`src/observability/slis.ts`, `tests/observability/slis.test.ts`). Not built: ack and attempt latency, `delivery_attempts`, Analytics Engine percentiles, UI.

**Story** As an operator, I want to know where time is going between "GitHub sent it" and "the
message appeared", so that a slow channel is diagnosed rather than guessed at.

**Acceptance** — four latency stages, each measured with an explicit start and end, none of them
overlapping.

| Stage | From → To | Why it matters |
| --- | --- | --- |
| **Ack latency** | request received → `202` sent | must sit inside GitHub's 10-second budget (F64) |
| **Queue delay** | durable acceptance → first delivery attempt | is the outbox draining? is the consumer alive? |
| **Attempt latency** | outbound `fetch` start → response | which destination is slow |
| **End-to-end** | `X-GitHub-Delivery` received → attempt finished | the number a customer experiences |

- [ ] Every stage is a `delivery_attempts` timestamp difference (F184), not an estimate from
      log timestamps.
- [ ] Percentiles use Analytics Engine's `quantileExactWeighted(q)(column, _sample_interval)` —
      the only percentile function the SQL reference documents, and the one that is correct
      under Cloudflare-side sampling. The `quantileWeighted` alias is the same function.
- [ ] ⭐ **Every percentile computed from Analytics Engine is labelled an estimate.** `p95` from
      AE is a sampled estimate by construction (F191). Percentiles computed from D1 within the
      retention window are exact and are what alerts use; AE percentiles are for trend and for
      windows older than 90 days.
- [ ] No `AVG` is published as a latency figure anywhere. An average over a latency distribution
      with a bounded tail is not a number a user can plan against.
- [ ] **Queue depth** is measured from D1 as pending/claimed row counts and ages, not from
      Cloudflare's queue metrics, because the two diverge when a consumer is disabled (F180's
      "a DLQ with no active consumer evaporates after four days" is a case where the platform
      looks healthy and nothing is being consumed).
- [ ] Backlog age is the alerting signal, not depth: 5,000 messages draining in 10 seconds is
      healthy; 5 messages pending for an hour is an outage (F200).
- [ ] **Rate metrics use `SUM(_sample_interval * double1) / SUM(_sample_interval)`** wherever
      they come from AE, per the SQL API's documented form. `COUNT()` is never used for a rate.
- [ ] Every metric emitted from a consumer invocation respects the 250-datapoint cap (F191); a
      per-message datapoint with `max_batch_size: 10` is fine, with `max_batch_size: 100` is not.
- [ ] ⚠️ **No latency target is stated in this spec.** Targets are set from measurements taken in
      a staging drill and recorded in an ADR with the date and the method. Stating a p95 target
      we have not measured would be the fabricated-benchmark failure `AGENTS.md` prohibits.

**Design** — The four-stage decomposition is the thing worth having. "The notification is late"
has three quite different causes — we were slow to acknowledge, the queue backed up, or
Lark/Teams took eight seconds — and they have three different fixes and three different owners.
Collapsing them into one end-to-end number makes all three look like the same problem, which is
how a destination outage gets misdiagnosed as a platform outage.

Queue depth versus backlog age is the second deliberate choice. Depth is what looks alarming in
a dashboard during a healthy catch-up; age is what actually predicts missing notifications.
Alerting on depth produces an operator habit of ignoring the alert.

**Schema**

```ts
// F198 — four stages with DISJOINT start and end events, from delivery_attempts (F184).
export type LatencyStage =
  | 'ack'          // request received -> 202 sent       (GitHub 10 s budget, F64)
  | 'queue_delay'  // durable acceptance -> first attempt
  | 'attempt'      // outbound fetch start -> response
  | 'end_to_end';  // X-GitHub-Delivery -> attempt finished

export type LatencyPoint = { stage: LatencyStage; latency_ms: number; estimated: boolean };

// The only percentile function the AE SQL reference documents, and the only
// correct one under Cloudflare-side sampling. `quantileWeighted` is its alias.
export type PercentileQuery = string;
//   SELECT quantileExactWeighted(0.95)(double1, _sample_interval) FROM noti_delivery
//        WHERE index1 = ? AND timestamp > NOW() - INTERVAL '1' DAY
// Rates use the documented weighted form:
//   SUM(_sample_interval * double1) / SUM(_sample_interval)

// Backlog AGE is the alerting signal. Depth is not (F200).
export type Backlog = { destination_queue: string; depth: number; oldest_age_s: number };
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| `_sample_interval` missing from a query | Query helper fails lint; figure is not shown |
| Percentile over an empty set | No data |
| Queue depth nonzero but age low | No alert (F200) |
| Attempt timestamps missing (pre-migration rows) | Stage is `unknown`, excluded from percentiles and counted |
| Datapoint budget exhausted | Remaining datapoints dropped with a counter (F191) |

**Security** — Latency metrics carry no payload and no repository names. `repository` as a metric
dimension would leak a tenant's repository names into our analytics, which `docs/SECURITY.md`
prohibits; if repository-level latency is ever needed it is hashed first (F196's rule).

**Tests**
- `latency_stages_have_disjoint_start_and_end_events`
- `percentile_queries_use_quantile_exact_weighted_with_sample_interval`
- `ae_derived_percentiles_are_labelled_estimated`
- `no_average_is_published_as_a_latency_figure`
- `backlog_age_not_depth_is_the_alerting_signal`
- `queue_depth_is_read_from_d1_not_from_platform_metrics`

**Deps** — F64, F180, F184, F191, F200.

---

## F199 — Product analytics views

**Priority** P1 · **Status** ❌ No product analytics views: no events table, 'this month in one sentence' buckets, top rules or suppression breakdown. Only adjacent: delivery summary counts on the Overview (`GET /api/deliveries/summary`) and the F197 SLI API. Needs an events/ingress ledger first.

**Story** As a user, I want to see what I am being sent and what I am not, in words rather than
numbers, so that I can tune my setup instead of guessing.

**Acceptance** — the views the dashboard must offer, and the honesty rule each one obeys.
These are **aggregates**. The per-row screens are F213 (delivery log) and F214 (event log and
single-event trace), and nothing here replaces them: an aggregate that is not backed by a
drill-down is a number the user cannot act on.

| View | Shows | Honesty rule |
| --- | --- | --- |
| **This month in one sentence** | *"You received 412 events. 14 were sent. 380 were grouped into digests. 18 were suppressed by your rules."* | Accounts for **every** received event; the four buckets sum to the total or the view is broken |
| **Volume by destination** | messages per hour per destination (F153) | distinguishes product ceiling from provider rate limit |
| **Top rules** | rules by messages produced | from D1, exact |
| **Rules that suppressed the most** | with the suppression reason breakdown | the "hit list of alerts to kill or tune" pattern |
| **Delivery reliability** | the four SLIs (F197) | Teams labelled acceptance-only |
| **Unmapped events** | `unmapped:<raw>` types and drift (F42) | never silently dropped |
| **Time spent tuning** | visits to settings vs configuration changes | *a tuning metric for us, not a customer-facing vanity number* |

- [ ] ⭐ **Every number states its provenance**: "exact" (D1, within retention) or "estimated"
      (Analytics Engine, sampled). The distinction is visible on the number, not in a footnote.
- [ ] The headline sentence is computed from `events` counts by outcome —
      `delivered | grouped | digested | suppressed | failed | dead_lettered` — and a test asserts
      the buckets sum to the received total. A dashboard whose parts do not sum is worse than no
      dashboard, because it invites the user to reconcile a number we got wrong.
- [ ] Suppression reasons use the **stable slugs** from F137 (`no_rule_matched`,
      `field_unknown`, `catalog_drift`, `critical_lock`, `bot_preset`, `preference`, `quiet_hours`,
      `ceiling`, `inhibition`) — never free text.
- [ ] Empty states **name the cause** (*"No events in the last 7 days"* / *"0 dead letters in 30
      days"*), never render an empty chart.
- [ ] ⭐ **No chart is ever populated with sample, illustrative or invented data.** An empty
      dataset renders empty. This extends `DESIGN.md` §15's ban on fake screenshots and
      "floating dashboard collage" into the data layer, and the `AGENTS.md` design contract's
      prohibition on inventing live metrics.
- [ ] Views follow `DESIGN.md`: Paper White canvas, Civic Navy headings, Geist, Tabler Outline
      icons, canonical spacing scale, status colours only where they carry semantics, keyboard
      navigation, and 320 px reflow.
- [ ] Failure is visually distinct from success **without relying on colour alone** (WCAG 2.2
      AA), using a text marker, consistent with F145.
- [ ] The declining/noise signal: rules that produced notifications nobody engaged with are
      surfaced, because incident.io's decline-rate insight is the most actionable product signal
      in this category (`COMPETITIVE-FEATURE-SET.md` §1.1, ⚠️ vendor blog). ⚠️ We have no
      engagement signal today — we cannot see whether a notification was read. Until we do, this
      view shows **only** volume and explicitly does not claim an acceptance or decline rate.

**Design** — F164 already owns the *reporting*; this owns the *views*. The unifying rule is that
every number answers "what happened to my notifications", and the first view answers all of it in
one sentence because a non-technical user should not have to open four dashboards to learn that
they are receiving 412 events and being shown 14 of them.

Making the buckets sum to the total is a test, not a UI detail. An event that is received,
routed, then dropped by the DLQ has to land in exactly one bucket, and the only way to be sure is
to assert the sum. The `failed` and `dead_lettered` buckets exist precisely so that "we lost it"
is never invisible — the alternative is a headline that quietly excludes failures.

Decline rate is the obvious thing to want and the thing we cannot honestly build. incident.io
gets it from user acknowledgement inside their product; we send to Slack and Lark, where we have
no read signal and no user acknowledgement. Shipping a "nobody cares about this alert" metric
derived from volume alone would be a fabricated engagement claim wearing a data costume. The
view exists as volume only, says so, and the gap is written down rather than filled with a
proxy.

**Schema**

```ts
// F199 — every number declares its provenance. An AE-derived figure is an estimate.
export type Provenance = { source: 'd1'; exact: true } | { source: 'analytics_engine'; exact: false; sample_weighted: true };

export type HeadlineBuckets = {
  received: number;                 // the total every other bucket must sum to
  delivered: number;
  grouped: number;                  // F141/F142
  digested: number;                 // F144
  suppressed: number;
  failed: number;                   // exhausted but not yet dead-lettered
  dead_lettered: number;            // F180
  window_days: number;
  provenance: Provenance;
};                                  // a test asserts the buckets sum to `received`

export type SuppressionReason =
  | 'no_rule_matched' | 'field_unknown' | 'catalog_drift' | 'critical_lock'
  | 'bot_preset' | 'preference' | 'quiet_hours' | 'ceiling' | 'inhibition';

export type View = {
  id: 'headline' | 'volume_by_destination' | 'top_rules' | 'top_suppressing_rules'
      | 'delivery_reliability' | 'unmapped_events' | 'tuning_time';
  empty_state: string;              // always names the cause; never an empty chart
  data: unknown | null;             // null renders the empty state — NEVER sample data
};
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Buckets do not sum to the received total | Test failure; the view is not shipped in that state |
| Analytics Engine query returns a sampled figure | Rendered as "estimated" with the sample weighting applied |
| D1 retention window has expired | Range selector clamps to 90 days and says so |
| No data in the window | Named empty state |
| A suppression reason slug is unknown | Rendered as `other` and counted; the unknown slug raises a metric (F166) |

**Security** — Every query is tenant-scoped in the `WHERE` clause (F24). Repository names and
actor logins are never used as metric dimensions; where a top-N list is shown it is derived from
D1 under the tenant predicate, not from a shared dataset.

**Tests**
- `headline_buckets_sum_to_the_received_total`
- `every_number_displays_its_provenance_exact_or_estimated`
- `suppression_reasons_render_as_stable_slugs`
- `empty_states_name_the_cause_and_never_render_a_chart`
- `no_chart_renders_sample_or_invented_data`
- `views_are_tenant_scoped_and_never_expose_another_workspace`
- `no_decline_rate_is_claimed_without_an_engagement_signal`

**Deps** — F24, F42, F51, F137, F145, F153, F164, F166, F191, F197, F213, F214.

---

## F200 — Alerting on our own failure modes

**Priority** P0 · **Status** 🟡 Stall detection (`stall.ts`) plus, from ADR 0024, `alert_state` and an engine over a twelve-alert registry built from D1 and boot-report signals (`job_stale`, `outbox_stall`, `dead_letter_spike`, `breaker_open` (ADR 0042), `breaker_open_many`, `key_config_fault`, `credentials_quarantined_nonzero`, `credential_decrypt_failures` (ADR 0054), `queue_backlog`, `ingress_drop_rate`, `cron_heartbeat_missing`, `dlq_consumer_no_progress`): fire, dedupe, re-notify, resolve; sinks are the log and an optional chat webhook (`ALERT_WEBHOOK_URL`, URL policy, 10 s, no retry loop). Not built: any page-a-human integration (PagerDuty and the like), `dlq_growth` from real queue depth (needs the Queues API), `d1_overloaded`, `ingress_gap` and the other alerts that need data we do not collect. Thresholds are unmeasured.

**Story** As an on-call engineer, I want to be told when the system is losing notifications
before a customer tells me, so that the first report is our apology rather than our discovery.

**Acceptance** — every alert reads its input from **D1**, never from log ingestion (F196: on
Free, ingestion *stops* when the allowance is exceeded).

| Alert | Condition | Window | Severity |
| --- | --- | --- | --- |
| `outbox_stalled` | any `notification_outbox` row `state='pending'` older than 5 min | rolling | **page** |
| `dlq_growth` | dead-lettered deliveries above a workspace baseline | 1 h, vs 7-day baseline | **page** |
| `d1_overloaded` | any D1 `D1 DB is overloaded.` error observed | 5 min | **page** |
| `ingress_gap` | expected provider deliveries absent for a connected source | 2 h of inactivity on a source that previously delivered | **page** |
| `job_stale` | `MAX(job_runs.finished_at)` older than `3 × cadence` | per job | **page** |
| `job_failing` | 3 consecutive `failed` outcomes | per job | **page** |
| `consumer_lag` | oldest un-processed outbox row > 15 min | rolling | warn → page |
| `circuit_open` | a destination circuit breaker open > 5 min (F183) | per destination | warn |
| `destination_revoked` | `410 Gone` from a provider | on occurrence | warn + user notice |
| `delivery_success_rate_drop` | confirmed-delivery rate below its 7-day baseline | 1 h vs baseline | warn |
| `catalog_drift` | a rule references a removed catalog entry | on write | warn |
| `config_invalid` | startup assertion failed (F04) | at boot | **page** |
| `observability_budget_near` | estimated ingestion > 90% of allowance | daily | warn |
| `acceptance_rate_drop` | durable acceptance below 99.5% over 1 h | 1 h | **page** |

- [ ] Alerts are **evaluated in D1** by a scheduled evaluation (F192), and the evaluation result
      is written back to D1. Alert evaluation is not a log query and never has been.
- [ ] ⭐ **`outbox_stalled` at 5 minutes is a page, not a warning.** A notification product that
      silently drops is worse than one that is noisy; the alert must be more annoying than the
      failure it prevents.
- [ ] `ingress_gap` is scoped to a connection that **previously delivered**, so a quiet
      repository does not page forever. The detection window and the threshold are per connection.
- [ ] `d1_overloaded` matches the exact documented strings — `D1 DB is overloaded. Requests
      queued for too long.` and `D1 DB is overloaded. Too many requests queued.` — and counts
      them at the **call site**, because Cloudflare's recommended action for both is to
      *"send fewer requests by spreading the load over time"* rather than to retry
      ([d1/observability/debug-d1](https://developers.cloudflare.com/d1/observability/debug-d1/),
      read 2026-10-13). An alert volume of this error is a **sharding signal** for F06, and it
      says so in the runbook.
- [ ] Every alert has: a runbook link (F201), a severity, an owner, and a **suppression policy**
      so a known-red alert during an incident does not page again.
- [ ] Alerts fire on **state change**, not on every evaluation: a transition into the condition,
      with a re-notify interval.
- [ ] Thresholds are configuration with documented rationale. Defaults are stated as starting
      points and **must be reviewed against staging measurements before launch** — no default
      here is a measured value, because none has been measured.
- [ ] ⚠️ There is **no alert on "no data"** from the log pipeline, because on Free that state is
      indistinguishable from "nothing is wrong". Absence of telemetry is itself a monitored
      condition: `job_stale` and `job_never_ran` cover the case where *our own* detectors stop.
- [ ] Delivery destination for alerts is chosen at deploy time and is never a customer
      destination (an outage in a customer's Slack must not be where our page goes).

**Design** — The whole table is the answer to "what breaks silently". Every row is a condition
where the system continues to look healthy while notifications are lost: an outbox nobody
drains, a DLQ nobody consumes, a source that stopped sending, a consumer that stopped running.
None of them produces an exception, which is exactly why they need explicit detectors.

`ingress_gap` is the one that is genuinely hard, and it is the one that catches the failure class
we cannot detect any other way: the source quietly stopped delivering. Everything else is
detectable from our own state. Detecting this requires per-connection activity tracking and a
connection-specific window, because "no events for an hour" is normal for a quiet repository and
an outage for a busy one. The signal is noisy by nature, so it is scoped and tuned per
connection rather than being global.

The D1-overload alert pointing at sharding is deliberate. F06 already anticipates sharding as
the escape from the single-writer ceiling; this alert is the trigger condition, and the runbook
entry names it.

**Schema**

```sql
-- F200 — every alert's evaluation state is persisted in D1. Alert evaluation is
-- never a log query, because on Free ingestion stops at the daily allowance (F196).
CREATE TABLE alert_state (
  alert      TEXT PRIMARY KEY,
  firing     INTEGER NOT NULL DEFAULT 0,
  since      INTEGER,
  last_eval  INTEGER NOT NULL,
  notified_at INTEGER,                 -- state-change notification, not per-evaluation
  renotify_after INTEGER,              -- re-notify interval while still firing
  runbook_ref TEXT NOT NULL,           -- asserted to exist (F201)
  severity   TEXT NOT NULL CHECK (severity IN ('warn', 'page')),
  owner      TEXT NOT NULL
);
```

```ts
export type AlertName =
  | 'outbox_stalled'            // page — pending outbox row > 5 min
  | 'dlq_growth'                // page — vs 7-day baseline
  | 'd1_overloaded'             // page — exact documented error strings
  | 'ingress_gap'               // page — a source that previously delivered has gone quiet
  | 'job_stale' | 'job_failing' // page — never silently stopped (F192)
  | 'consumer_lag' | 'circuit_open' | 'destination_revoked'
  | 'delivery_success_rate_drop' | 'catalog_drift'
  | 'config_invalid'            // page — F04
  | 'observability_budget_near' | 'acceptance_rate_drop';

// Suppression policy + runbook link are part of the definition, not metadata:
// an alert without a runbook entry is a CI failure (F201).
export type AlertDefinition = {
  name: AlertName; severity: 'warn' | 'page'; runbook_ref: string;
  notify: 'state_change'; renotify_after_s: number;
  suppressed_by_incident: boolean;
};
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Alert evaluation itself fails | `alert_evaluator_failed` alert; alerting on the alerting system is a known blind spot and is stated in the runbook rather than solved |
| Alert fires for a known reason during an incident | Suppressed by the incident record, visible in the post-incident review |
| No data for a workspace | Not an alert; absence of events is a legitimate state |
| Threshold crossed in staging with synthetic load | Expected; staging alert routes are disabled by environment (F03) |

**Security** — Alert routing targets are internal endpoints, never customer destinations. Alert
payloads carry workspace ids and error codes, never payload content, tokens or URLs (F195).
Thresholds and suppression policy are configuration changes and are audited (F28).

**Tests**
- `every_alert_input_is_read_from_d1_not_from_logs`
- `outbox_stalled_fires_after_five_minutes_and_pages`
- `d1_overloaded_matches_the_exact_documented_error_strings`
- `ingress_gap_only_fires_for_connections_that_previously_delivered`
- `alerts_fire_on_state_change_with_a_re_notify_interval`
- `every_alert_has_a_runbook_link_severity_and_owner`
- `staging_alert_routes_are_disabled_per_environment`

**Deps** — F03, F06, F13, F28, F64, F173, F183, F192, F195, F196, F201.

---

## F201 — Incident response runbook

**Priority** P1 · **Status** 🟡 `docs/RUNBOOK.md` states the delivery model and no-audit caveat, with severity table and procedures tied to real tables, an incident template, an entry per built alert, a cron job table and a correlation lookup, and `tests/observability/alert-runbook.test.ts` ties every alert to its entry and runs the new SQL. Not built: customer-message and capability fields per alert, any rehearsal (the runbook lists itself as unrehearsed).

**Story** As an on-call engineer at 3am, I want the runbook to tell me what to check first, so
that I act on evidence rather than on hunches while a customer's alerts are missing.

**Acceptance** — one runbook document, one entry per F200 alert, plus a fixed shape.

- [ ] Every entry is: **symptom → how to confirm → immediate mitigation → root-cause path →
      what to tell the customer → what to record.** "What to tell the customer" is mandatory; an
      incident where nobody decides what to say produces an under-communication, which is worse
      than a slightly late statement.
- [ ] Every mitigation step is an **action that already exists in the product** — replay (F182),
      redeliver, rollback a rule (F139), disable a rule, flush a circuit breaker (F183). An entry
      that says "inspect the database manually" is an entry that admits a gap; it must be filed
      as one.
- [ ] Each step names the **capability required** (F204), because the person on call may not be
      the person with the capability and that should be visible before they need it.
- [ ] Each entry carries the **diagnostic queries**, tenant-scoped, written out literally so they
      can be pasted rather than reconstructed.

| Alert | First check | Immediate mitigation | Customer message |
| --- | --- | --- | --- |
| `outbox_stalled` | oldest pending row age; is the deliver consumer deployed and its lease current | run the reconciler (F174); if the consumer is missing, redeploy | *"We are investigating delayed notifications; none have been lost."* |
| `dlq_growth` | group by `error_code` and destination (F181) | replay after fixing credentials (F182) | *"Some notifications failed to send to `<destination>`; the cause is `<plain-language cause>`."* |
| `d1_overloaded` | error rate by operation; consumer concurrency; queue depth | reduce concurrency; shard if sustained (F06) | Usually none — the accepted rate has not dropped. |
| `ingress_gap` | connection `last_seen_at`; GitHub App installation state; webhook deliveries page (F65) | re-verify installation permissions; reconcile (F69) | *"We have not received events from `<source>` since `<time>`."* |
| `job_stale` | `job_runs` last success; was the Worker deployed | run the job manually with the persisted cursor | Usually none. |
| `circuit_open` | destination host; consecutive terminal failures | surface to the user; let them decide (F183 — we never auto-disable) | *"We have paused sending to `<destination>` because it is failing. Nothing is lost; it resumes automatically."* |
| `destination_revoked` | `410 Gone`; the provider's own UI | disable the destination; tell the user to reconnect (F13) | *"The `<destination>` connection was deleted in `<provider>`. Reconnect it."* |
| `acceptance_rate_drop` | ingress error mix; D1 write failures | shed load; verify durable acceptance before acking (F169) | *"Some events are being delayed before we accept them."* |

- [ ] ⭐ **The runbook states the delivery model at the top.** At-least-once; duplicates possible;
  `accepted` is not always `delivered` (F197). An on-call engineer who does not know this will
  spend the first ten minutes of an incident trying to work out whether the system is broken.
- [ ] It states that **no security audit has been performed**, matching `docs/SECURITY.md`, and
      that a security incident is escalated, not triaged in-house.
- [ ] Post-incident: a template requiring **what we measured, what we inferred, and what we do
      not know** — with the unknown left as unknown. `AGENTS.md` forbids reporting a result we
      did not produce.
- [ ] The runbook is **rehearsed**: F05 requires a rollback rehearsal before releases touching
      `deliveries` or `event_receipts`, and F181/F182's manual redelivery path is exercised in
      staging at least once per release. A runbook that has never been followed is documentation.
- [ ] The alert table and the runbook are **generated from the same source of truth** as the job
      cadence table (F192), so an alert cannot exist without a runbook entry — a test asserts it.
- [ ] ⭐ **This runbook is the availability and delivery-loss runbook. Security incidents are a
      different document.** `15-security-and-compliance.md` F242 owns incident response and
      disclosure for the four scenarios it defines (cross-tenant exposure, credential compromise,
      silent delivery loss, degraded availability); F240 owns the security release checklist and
      F241 the accepted-risk register. The boundary is drawn at the first sign of a security
      event, not at the first sign of an outage: an entry here may begin *"if you suspect
      credential exposure, stop and escalate to F242 — do not triage it here."*
- [ ] Every claim in the runbook about a platform limit cites the URL and read date, as
      `01-platform-runtime.md` requires.

**Design** — The runbook exists because the median on-call engineer is not the person who built
the system, and because in this product the most likely incident is *silence* — a stalled outbox,
an unconsumed DLQ, a source that stopped sending. None of those throw. All of them are in the
alert table precisely because they are quiet, so the runbook is mostly about quiet failures and
how to distinguish them from each other quickly.

Making "what to tell the customer" a mandatory field is the part most runbooks omit and the part
that matters most to the customer. The draft messages are written before the incident, when
nobody is tempted to speculate, and they are deliberately plain: none of them claims an event was
delivered, none of them claims exactly-once, and the duplicate disclosure (F185) is in the
template rather than improvised.

The generated-from-one-source rule is what stops the runbook rotting. Alert definitions and runbook
entries are written together, and a test fails the build if an alert has no entry. A runbook
that has drifted from the alerts it documents is worse than none, because it is trusted.

**Schema**

```ts
// F201 — generated from the same table as F200's AlertDefinition, so an alert
// cannot exist without a runbook entry (asserted by a test).
export type RunbookEntry = {
  alert: AlertName;
  symptom: string;
  how_to_confirm: readonly string[];      // literal, pasteable, tenant-scoped queries
  immediate_mitigation: readonly MitigatingAction[];
  root_cause_path: readonly string[];
  customer_message: string;               // MANDATORY — drafted before the incident
  required_capability: string;            // F204, e.g. 'delivery.replay'
};

export type MitigatingAction =
  | { action: 'run_reconciler'; ref: 'F174' }
  | { action: 'replay_delivery'; ref: 'F182'; capability: 'delivery.replay' }
  | { action: 'rollback_rule'; ref: 'F139'; capability: 'rule.rollback' }
  | { action: 'flush_circuit_breaker'; ref: 'F183' }
  | { action: 'reconcile_source'; ref: 'F69' }
  | { action: 'redeploy'; ref: 'F02' };

// Post-incident: what we measured / inferred / do NOT know. The unknown stays
// unknown — AGENTS.md forbids reporting a result we did not produce.
export type PostIncident = {
  measured: readonly string[];
  inferred: readonly string[];
  not_known: readonly string[];           // never omitted, never filled with a guess
};
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Alert fires with no runbook entry | Test failure, not a production condition — prevented structurally |
| Mitigation requires a capability the responder lacks | Named in the entry; escalation path stated |
| Root cause is not in the runbook | Entry is amended post-incident; the gap is filed as a tracked item |
| Incident requires manual data access | Escalate; do not improvise ad-hoc queries against production D1 |

**Security** — Runbook mitigations are audited actions (F28) and are capability-gated (F204).
No entry instructs an operator to disable signature verification, widen the destination
allowlist, or log a payload for debugging — and if one ever did, that would be a finding against
the runbook, not an exception to it. Production data access is via the tenant-scoped
administrative surface only.

**Tests**
- `every_alert_has_a_runbook_entry` (generated from the same table)
- `every_runbook_entry_names_symptom_confirmation_mitigation_and_customer_message`
- `every_mitigation_is_an_action_that_exists_in_the_product`
- `every_runbook_entry_names_the_capability_required`
- `the_runbook_states_the_at_least_once_delivery_model`
- `post_incident_template_requires_declaring_what_is_unknown`

**Deps** — F05, F13, F65, F69, F174, F181, F182, F183, F185, F192, F200, F204, F240, F241, F242.

---

## F202 — Support evidence bundle

**Priority** P1 · **Status** ❌ No support bundle, no lookup by correlation id, no `observability.bundle` capability, no bundle expiry job. Blocked on F193 propagation into rows and queue messages.

**Story** As a support engineer, I want to gather everything about one notification into a
single redacted artifact, so that I stop asking customers for screenshots and logs.

**Acceptance**
- [ ] A bundle is built from **one `correlation_id`** (F193) and contains: the normalized
      envelope, the delivery rows and every attempt with its taxonomy code, the evaluation trace
      (F137), the correlation-bearing log lines from the retention window, the job runs and
      alert evaluations in that window, and the D1 write timings for the relevant rows.
- [ ] ⭐ **Redacted at pack time** (F195), not at read time. The bundle is a separate artifact
      with its own lifecycle, and an artifact that only becomes sensitive when read is a design
      error.
- [ ] The bundle carries a **header**: created at, created by, `correlation_id`, org, bundle
      schema version, redaction policy version, and `truncated: true/false` with what was
      elided.
- [ ] Size budget of **1 MB**, exceeded by eliding in a fixed order: log lines → attempt
      history → envelope. The envelope is last because it is the thing the customer is asking
      about.
- [ ] ⭐ **Expiry.** Bundles are deleted after **7 days** and the expiry is a scheduled job
      (F192) with its own staleness alert. A support artifact that outlives its purpose is a
      liability, not an archive.
- [ ] Access is capability-gated (F204) and audited (F28). A bundle is downloadable only by a
      member of that workspace's organization, and every download is recorded with the actor.
- [ ] ⭐ **Cross-tenant bundles are impossible by construction.** The query resolves `orgid`
      first; an id belonging to another org returns `404`, not `403`, so the endpoint does not
      confirm existence.
- [ ] The bundle states what it **does not** contain, so nobody concludes from its absence that
      something did not happen: no queue internals, no provider request bodies, no credentials,
      no other tenant's data.
- [ ] Where a claim in the bundle depends on something we could not observe — "accepted by
      Teams, delivery unconfirmed" — the bundle says that in the same terms as the UI (F197).
- [ ] ⭐ The bundle **does not** include the delivery's rendered payload unless the viewer holds
      the relevant capability, and even then it is the redacted rendering (F98, F181).
- [ ] A test asserts that a bundle generated from a fixture containing every denylisted field
      contains none of them.

**Design** — The alternative to a bundle is a support engineer reading production logs, which
means either excessive access or an unreliable reconstruction. The correlation id already crosses
every boundary (F193), so the bundle is an assembly problem rather than a search problem — it
gathers things that are known to exist and are known to be retained.

Two design choices matter more than the feature itself. **Redaction at pack time** means the
bundle is safe to store and to attach to a ticket system we do not control, which is the whole
point of producing one. **A fixed expiry** means the artifact does not become a shadow database;
the durable record is D1 and the bundle is a convenience with a short life.

The "what this does not contain" list matters because of how these artifacts get used. An
engineer handed a bundle showing no provider response bodies should be able to conclude "we do
not retain those", not "there were none". Silence in an evidence artifact is ambiguous unless
the artifact says so.

**Schema**

```ts
// F202 — assembled from ONE correlation_id (F193). Redacted at pack time, not
// at read time: the artifact is safe to store and to attach to a ticket system.
export type EvidenceBundle = {
  schema_version: number;
  header: {
    created_at: number; created_by: string;
    correlation_id: CorrelationId; orgid: string;
    redaction_policy_version: RedactionPolicyVersion;
    expires_at: number;                       // created + 7 days (F192 job)
    truncated: boolean; elided: readonly ('log_lines' | 'attempt_history' | 'envelope')[];
    not_contained: readonly string[];         // what is absent, so absence is not ambiguous
  };
  envelope: NormalizedEnvelope | null;
  deliveries: readonly DeliveryRow[];
  attempts: readonly DeliveryAttempt[];      // redacted taxonomy codes
  evaluation_trace: EvaluationTrace | null;
  logs: readonly LogLine[];                  // within the retention window only
  job_runs: readonly JobResult[];
  d1_write_timings: readonly { table: string; ms: number }[];
  rendered_payload?: string;                 // redacted; capability-gated (F181)
};
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Bundle exceeds 1 MB | Fixed-order elision, `truncated: true`, elided sections named in the header |
| Some sources already purged by retention | The section is marked `expired` with the purge date, not omitted silently |
| `correlation_id` unknown | `404`; no partial bundle is created |
| `correlation_id` belongs to another org | `404`, identical response, no existence disclosure |
| Bundle download without capability | `403` naming the required capability; audited |

**Security** — Bundles contain customer event data. They are stored encrypted, expire in 7 days,
are access-logged, and are excluded from the retention guarantees we make about D1. The
`orgid`-first resolution and `404`-on-mismatch make them non-enumerable across tenants.
`docs/SECURITY.md` prohibits exposing raw private event payloads to other tenants, analytics or
third parties; a bundle is tenant-scoped, access-logged and time-boxed for exactly that reason.

**Tests**
- `bundle_contains_every_section_from_one_correlation_id`
- `bundle_is_redacted_at_pack_time`
- `bundle_elides_in_the_declared_order_and_states_what_was_elided`
- `bundle_expires_after_seven_days_via_a_monitored_job`
- `cross_tenant_bundle_access_returns_404`
- `bundle_states_what_it_does_not_contain`
- `bundle_preserves_accepted_not_delivered_wording`

**Deps** — F24, F28, F51, F98, F137, F181, F184, F192, F193, F195, F197, F204.

---

## F203 — What we deliberately do not measure

**Priority** P1 · **Status** 🟡 Scattered guards only: `web/src/deliveries/deliveries.test.ts` bans exactly-once wording in the en catalogue, `src/observability/slis.ts` lists `notMeasurable` SLIs, and the runbook states the model. Not built: the normative refusal table, a banned-string test over docs, dashboard and marketing, a release review record. · **A specification of refusals**

**Story** As a maintainer, I want the metrics we refuse to compute written down, so that nobody
later "improves" the dashboard by inventing one.

**Acceptance** — each entry states the metric, why we refuse, and what we show instead. This is
a normative list; adding an entry is easy, removing one requires an ADR.

| Not measured | Why | Shown instead |
| --- | --- | --- |
| **Exactly-once delivery rate** | Impossible. The remote effect and the local ack are separate system transitions with an irreducible crash window, and no destination except Lark's app API has server-side idempotency (F188). Cloudflare: *"exactly once delivery incurs additional overheads in any messaging system"*. | The at-least-once model, stated (F185), plus the **duplicate rate** we *can* measure |
| **"Read by a human" / engagement** | We send to Slack, Lark and Teams. We have no read receipt, no acknowledgement, and no visibility into whether anyone acted. | Volume per rule and per destination, explicitly labelled as volume |
| **Decline rate** | Depends entirely on the signal above. A volume proxy would be a fabricated engagement claim. | Top rules by volume + rules that suppressed the most (F199) |
| **Notification quality / relevance score** | Requires a model and a ground truth we do not have. `AGENTS.md`: never silently fabricate event facts. | Nothing. We do not rank our customers' alerts. |
| **Per-user latency** | We cannot attribute a notification to a reader. We would be measuring Slack's or Lark's read behaviour, not ours. | End-to-end latency per destination and per rule |
| **Repository-name or actor-login metric dimensions** | `docs/SECURITY.md` prohibits exposing private event data to analytics. A tenant's repository names in our metrics is a disclosure. | Hashed dimensions, where a dimension is genuinely needed |
| **Token / cost per delivery to a customer** | We do not yet have a price, and a fabricated number on a pricing page is the single most damaging thing we could do. F253 fixes the billable unit (**one delivered message**); F254 owns the price and is undecided. | Nothing, until F254 has a verified cost basis |
| **"System uptime" as a percentage** | We can measure our Worker returning 200. We cannot measure whether the customer's notification arrived. Reporting the former under the name "uptime" is the Teams problem again. | Acceptance rate and confirmed-delivery rate, per destination, with their definitions (F197) |
| **Security incident rate / audit findings** | **No formal security audit has been performed** (`docs/SECURITY.md`). Reporting a security posture we have not assessed would be the most dangerous line in the product. | A link to `docs/SECURITY.md`, which says the same thing |
| **Competitor / market benchmarks** | We have not run a benchmark. `AGENTS.md` forbids fabricated results. | Nothing. Qualitative competitor claims cite `docs/specs/COMPETITIVE-FEATURE-SET.md` and its URLs. |
| **Latency percentiles from Analytics Engine presented as exact** | AE sampling makes every AE percentile an estimate. Presenting it as exact is a small lie repeated daily. | Percentiles from D1 within retention, labelled; AE trends labelled estimated (F198) |
| **User satisfaction / NPS** | We have no instrument and no sample. | Nothing |

- [ ] A test asserts the banned strings do not appear in the dashboard, marketing pages or docs:
      `"exactly once"`, `"guaranteed delivery"`, `"never missed"`, `"100% delivered"`.
- [ ] Every future metric proposal is checked against this table. A metric that is not on it must
      either be added here (with a reason it is now measurable) or not built.
- [ ] ⭐ The table is **not** aspirational. "Not measured" means not computed anywhere — not in
      a dashboard, not in a cron, not in a weekly internal report. A metric that exists only
      internally and then leaks into a sales conversation is worse than one that was never built.
- [ ] Removing a refusal requires an ADR stating what changed — usually that the underlying
      signal became available (e.g. Slack interaction callbacks would make decline rate real).
- [ ] The list is reviewed at each release and the review is recorded.

**Design** — This file is unusual and it is deliberate. Every other spec says what to build;
this one says what to refuse, and it is the one most likely to be eroded by well-meant feature
requests. Each entry exists because the corresponding metric is *nearly* measurable with a proxy,
and every proxy is a lie with a decimal point on it.

The pattern across the refusals is consistent: we can measure our own actions accurately
(accepted, attempted, confirmed by the provider, suppressed, failed, retried, duplicated) and we
cannot measure the destination's or the human's behaviour. The moment a proposed metric crosses
that line, it stops being a measurement and becomes a story. The largest entries here —
exactly-once, engagement, uptime — are exactly the three that marketing departments ask for and
that no honest implementation can supply.

The entry on cost-per-delivery is the one that will be tested soonest, since F253 fixes the
billable unit. The rule is that the *unit* can be defined before the price is, and the price
appears on a pricing page only when it is real. (⚠️ `11-grouping-and-noise.md` cites the billing
feature as **F233**; `15-security-and-compliance.md` uses F233 for *tenant isolation* and
`16-ai-and-roadmap.md` uses F253/F254 for metering and pricing. **F253** is the current ID; the
collision should be fixed at the next reindex.)

**Schema**

```ts
// F203 — a specification of refusals. Removing an entry requires an ADR.
export type RefusedMetric =
  | 'exactly_once_delivery_rate'   // impossible; at-least-once is the contract (F185)
  | 'read_by_human' | 'engagement' | 'decline_rate' | 'relevance_score'
  | 'per_user_latency'
  | 'repository_or_actor_metric_dimension'   // SECURITY.md prohibition
  | 'cost_per_delivery_to_customer'          // F253 fixes the unit; F254 owns the price
  | 'system_uptime_percentage'
  | 'security_posture' | 'audit_findings'   // no formal audit has been performed
  | 'competitor_benchmark'
  | 'analytics_engine_percentile_as_exact'
  | 'satisfaction_or_nps';

export type Refusal = {
  metric: RefusedMetric;
  reason: string;
  shown_instead: string | null;      // null => "nothing, and that is correct"
  adr_required_to_remove: true;
};

// Banned strings asserted absent from UI copy, marketing pages and docs.
export const BANNED_CLAIMS = [
  'exactly once', 'guaranteed delivery', 'never missed', '100% delivered',
] as const;
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| A banned phrase appears in UI copy | Test failure with the offending string and file |
| A dashboard query would produce a refused metric | The view is not built; the refusal is cited |
| A refused metric exists in an internal report | Removed, and the reason recorded here |
| Someone asks to remove a refusal | Requires an ADR; never a code change |

**Security** — This feature is a security control as much as an honesty one. The refusals about
payload-derived dimensions, cross-tenant aggregation and security posture are the ones where a
well-intentioned dashboard could create a disclosure. Each refusal names the specific
prohibition it enforces.

**Tests**
- `banned_phrases_appear_nowhere_in_ui_marketing_or_docs`
- `no_dashboard_view_computes_a_refused_metric`
- `removing_a_refusal_requires_an_adr` (CI check on the spec file)
- `refusals_are_reviewed_and_the_review_is_recorded`

**Deps** — F185, F188, F197, F198, F199, F253, F254.

---

## F204 — Operator capability gates for recovery actions

**Priority** P0 · **Status** 🟡 `delivery.replay` is admin-only via `authorize()`; the 403 names the capability and denials are audited (`src/auth/permissions.ts`, `src/auth/workspace.ts`, `tests/api/deliveries.test.ts`). Not built: `slis.publish`, `rule.rollback`, `observability.bundle`, `retention.purge`, `incident.declare`, replay dry-run count and per-hour bounds. · **Implements the `replay` capability referenced by F182**

**Story** As a workspace admin, I want recovery actions to be restricted to people who should
have them, so that a routine mistake cannot be repeated at scale by someone who meant well.

**Acceptance** — F24 defines the auth-side capability table. This defines the **operational
surface**: which recovery actions exist, who may run them, and what each one costs.

| Capability | admin | member | Action |
| --- | --- | --- | --- |
| `delivery.replay` | ✅ | ❌ | replay one dead letter or all for a destination (F182) |
| `delivery.view_rendered_payload` | ✅ | ✅ | see the redacted rendering (F181) |
| `rule.rollback` | ✅ | ❌ | restore a previous rule version (F139) |
| `rule.disable` | ✅ | ✅ | turn a rule off without deleting it |
| `observability.bundle` | ✅ | ❌ | generate and download a support bundle (F202) |
| `slis.publish` | ✅ | ❌ | mark an SLI as externally publishable (F197) |
| `retention.purge` | ✅ | ❌ | trigger an out-of-cycle purge (F51) |
| `destination.disable` | ✅ | ✅ | stop routing to a destination (F179) |
| `incident.declare` | ✅ | ❌ | open an incident record |

- [ ] ⭐ **Every capability is checked server-side on every mutating route.** A hidden button is
      never the control (F24).
- [ ] A `403` names the missing capability so support can diagnose it without reading code.
- [ ] ⭐ **Every recovery action is rate-limited and bounded**, because these are the actions
      that can fan out into a customer's channel:
      - `delivery.replay`: max 1,000 deliveries per invocation, max 10 invocations per hour per
        org, with a dry-run count returned first (*"this will resend 412 notifications"*).
      - `rule.rollback`: one rule per invocation.
      - `retention.purge`: chunked and resumable, never a single unbounded statement.
      - `observability.bundle`: max 10 per hour per org, with a size budget.
- [ ] ⭐ **Every action is audited** with actor, org, capability, target, affected count and
      `correlation_id` (F28, F193). Replay and rollback in particular must be attributable, since
      both can re-send content a customer has since retracted.
- [ ] A member may always take the **safe** direction: disable a rule or a destination. They may
      not take the direction that re-sends or deletes.
- [ ] `slis.publish` is the capability that gates F203's refusals: a metric not measured cannot
      be published by anyone, and the refusal list (F203) is the check.
- [ ] ⭐ A capability check failure is **audited as well as rejected**. A burst of 403s on
      `delivery.replay` is either a confused user or a probe, and both are worth a line.
- [ ] Capabilities are enforced by the same `authorize(actor, orgId, capability)` helper F24
      requires, so a missed check is a missing argument rather than a missing `if`.
- [ ] The runbook (F201) names the required capability per entry, so the responder learns the
      constraint before they need it.
- [ ] No capability grants cross-org access. An operator acting on another workspace's delivery
      uses a platform-operator path with its own audit and its own capability, not an elevated
      workspace role.

**Design** — The asymmetry between "stop sending" and "send again" is the whole feature.
Disabling a rule or a destination is always recoverable: the user can turn it back on. Replaying
a delivery and rolling back a rule both put content into a customer's channel that may no longer
be wanted, and a replay can do it hundreds of times in one invocation. Members get the
irreversible-in-practice actions gated behind `admin`; everyone gets the reversible ones.

The dry-run count on replay is the F161 preview pattern applied to recovery: the cost of the
action is not knowable after the fact, so it must be shown before. *"This will resend 412
notifications to Lark #alerts"* is a sentence that turns a support conversation into a decision.

`slis.publish` is included because F203's refusals need an enforcement point. Without it, the
honest default can be overridden by anyone with dashboard access, and an honesty guarantee with
no gate is a preference.

**Schema**

```ts
// F204 — F24 defines the auth-side capability table. This is the OPERATIONAL
// surface: which recovery actions exist, who may run them, and what they cost.
export type Capability =
  | 'delivery.replay' | 'delivery.view_rendered_payload'
  | 'rule.rollback' | 'rule.disable'
  | 'observability.bundle' | 'slis.publish'
  | 'retention.purge' | 'destination.disable' | 'incident.declare';

export type RecoveryAction = {
  capability: Capability;
  rate_limit: { max_per_invocation: number; max_per_hour_per_org: number };
  dry_run_required: boolean;         // 'this will resend 412 notifications'
  audited: true;                     // actor, org, capability, target, count, correlation_id
  bounded: true;                     // chunked; never a single unbounded statement
};

// Load-bearing: an undefined capability FAILS CLOSED and pages. A typo in a
// capability name must never produce a permission grant.
export function authorize(actor: UserId, orgId: string, c: Capability): Decision;
// Decision = { ok: true } | { ok: false; code: 403; missing_capability: Capability };
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Missing capability | `403` naming the capability; audited |
| Replay would exceed the per-invocation cap | Refused with the count and the chunking plan; never partially executed silently |
| Replay target already succeeded | Refused (F182) |
| Action exceeds its hourly budget | `429` with `Retry-After` |
| Rule to roll back was deleted concurrently | `409`, re-read prompt |
| Capability check itself fails (missing capability in the table) | **Fail closed** and page: an undefined capability must never mean "allowed" |

**Security** — Fail-closed on an unknown capability is the load-bearing property. F24's stated
goal — *"a missed check must be a missing argument, not a missing `if`"* — means a capability
name that is not in the table cannot be checked, and an unchecked capability must deny. A typo in
a capability name must never produce a permission grant.

Cross-org operator access is a separate, audited path. It is not implemented by granting a
`super_admin` role inside Better Auth's organization model, which would make one workspace's
admin equal to the platform and make every authorization audit ambiguous.

**Tests**
- `every_mutating_recovery_route_checks_a_capability_server_side`
- `missing_capability_returns_403_naming_it_and_is_audited`
- `replay_is_bounded_and_returns_a_dry_run_count_before_executing`
- `rule_rollback_is_admin_only_and_audited`
- `an_undefined_capability_fails_closed_and_pages`
- `no_capability_grants_cross_organization_access`
- `every_runbook_entry_names_its_required_capability`

**Deps** — F24, F28, F51, F139, F161, F179, F181, F182, F193, F197, F201, F202, F203.