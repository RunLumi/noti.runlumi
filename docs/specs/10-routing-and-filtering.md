# 10 — Routing & Filtering

> The configuration surface between "an event arrived" and "a message was sent".
> Every filter reads **normalized fields only** (F41) and compares them to
> **literals only** — never to computed expressions (F167).
>
> Cloudflare and GitHub facts below were read **2026-10-13**. Source of record:
> `docs/specs/README.md#sources`.

## The two rules everything else follows from

| Rule | Consequence |
| --- | --- |
| **A filter may compare a field to a literal. It may not compute.** | No expression language, no regex-in-routing UI, no cross-field comparison, no user functions. A rule that needs arithmetic is a product conversation, not a config change (F167). |
| **Rules are evaluated in the consumer, never at ingress.** | D1 is *"inherently single-threaded, and processes queries one at a time"* ([d1/platform/limits](https://developers.cloudflare.com/d1/platform/limits/), read 2026-10-13). Ingress has a hard 10-second acknowledgement deadline (F64) and must not fan out *rules × destinations × D1 reads*. See F136. |

## Constraints we design against

| Fact | Value | Source |
| --- | --- | --- |
| D1 is single-threaded per database | *"Each individual D1 database is inherently single-threaded, and processes queries one at a time."* | [d1/platform/limits](https://developers.cloudflare.com/d1/platform/limits/) |
| D1 max bound params per statement | 100 | same |
| D1 max queries per Worker invocation | 1000 Paid / 50 Free | same |
| D1 `batch()` is a transaction | *"Batched statements are SQL transactions… it aborts or rolls back the entire sequence."* | [d1/worker-api](https://developers.cloudflare.com/d1/worker-api/d1-database/) |
| D1 overload error strings | `D1 DB is overloaded. Requests queued for too long.` / `D1 DB is overloaded. Too many requests queued.` Cloudflare's recommended action for both is *"Optimize the queries… send fewer requests by spreading the load over time, or shard the queries"* — **not** "retry". | [d1/observability/debug-d1](https://developers.cloudflare.com/d1/observability/debug-d1/) |
| D1 auto-retry | Reads only (up to 2). Writes are **not** retried automatically. | [d1/best-practices/retry-queries](https://developers.cloudflare.com/d1/best-practices/retry-queries/) |
| Queues delivery | At least once; **no ordering guarantee**; batch retry is all-or-nothing unless overridden per message | [queues/reference/how-queues-works](https://developers.cloudflare.com/queues/reference/how-queues-works/) |
| Queues message size | 128 KB total incl. metadata | [queues/platform/limits](https://developers.cloudflare.com/queues/platform/limits/) |
| Worker CPU / wall time | 30 s default CPU on Paid (→5 min via `limits.cpu_ms`); **15 min wall** for a queue consumer and for cron | [workers/platform/limits](https://developers.cloudflare.com/workers/platform/limits/) |
| ⭐ Cron CPU | *"30 seconds (< 1 hour interval) · 15 min (>= 1 hour interval)"* | same |

> **Correction to `01-platform-runtime.md`.** That file records an unresolved contradiction
> between the Limits page ("30 s") and the pricing page ("15 min") for cron CPU. The Limits
> page is not self-contradictory: **30 s applies to cron intervals shorter than one hour**,
> and 15 min only to `>= 1 hour`. Every job in F190 runs on sub-hour intervals, so the budget
> is 30 s and the conservative reading we already chose is the correct one, not merely prudent.
> All jobs are therefore built to 30 s (F192).

## Non-negotiable invariants for this spec

- ⭐ **Authorization never comes from a rule.** Tenant resolution is the verified GitHub App
  installation (F25, F57). A rule can only *narrow* the set of events an authorized connection
  receives. A rule that names a repository outside its connection's installation scope is
  rejected at write time, not ignored at evaluation time.
- ⭐ **Every event gets a decision.** Matched, or suppressed with a named reason. "No rule
  matched" and "matched but the field was unknown" are different outcomes and are stored
  differently (F124, F137).
- ⭐ **No rule silently discards a critical event.** A rule that would suppress an event type
  marked critical at workspace level (F148) is rejected at write time with an explanation.

---

## F121 — Routing rule model

**Priority** P0 · **Status** not started · **Fixes** D3

**Story** As a user, I want one object that says which events, under which conditions, go where
and in what format, so that I can understand and change my setup as a whole rather than as a
list of unrelated switches.

**Acceptance**
- [ ] A rule has exactly these top-level keys and no others. Unknown keys are rejected, not
      ignored:

```ts
type RoutingRule = {
  name: string;                    // ≤64 chars, unique per orgid
  event_types: EventTypeId[];      // non-empty, FK → event_types.id (F42)
  condition_groups: ConditionGroup[];
  destinations: DestinationRef[];  // non-empty
  format: 'auto' | 'plain_text' | 'markdown' | 'native_card';
  priority: number;                // integer, 0–999; lower evaluates first
  enabled: 0 | 1;
};
```
- [ ] `destinations` entries are `{ destination_id, override? }` and must resolve to a
      destination owned by the same `orgid` **and** attached to the same connection as the rule.
- [ ] `format: 'auto'` resolves per destination through `capabilities()` (F92). It never
      silently downgrades: the degradation is declared (F93).
- [ ] A rule **belongs to one connection**. A rule may not span connections — cross-connection
      fan-out is achieved by separate rules, which keeps provenance unambiguous (F137).
- [ ] `priority` collisions are legal; ties break on `rule.id` ascending, which is total and
      stable (F132).
- [ ] Write-time validation runs before persistence and rejects: an unauthorized repository
      (F126), an event type outside the catalog, a destination from another org, or a filter
      field that is not in the registry (F125).
- [ ] The serialized form is the filter-config schema gated by F167. The test that keeps it
      from drifting — `filter_config_schema_rejects_computed_expressions` — is owned by F167 and
      runs against the schema F123 defines.

**Design** — Today routing is `SELECT * FROM integrations WHERE repo=? AND enabled=1` where
`repo` is `event.repository.full_name`, an **attacker-supplied request body field**, with no
tenant predicate (D3). There is no rule object at all: an "integration" row is simultaneously
the credential, the destination, the filter and the enable flag. Splitting them is the whole
change. The rule is deliberately **small** — it selects and it dispatches. Grouping, digest,
quiet hours and preferences live in `11-grouping-and-noise.md` and are referenced by name
(`group_by`, `digest`, `quiet_hours`) rather than embedded, so that changing the noise model
never requires a rule migration.

**Trade-off** — no rule inheritance, no nested rules, no rule-as-a-group. F163 covers
per-repository overrides as a separate, most-specific-wins layer rather than as rule nesting.
Nesting is where Alertmanager's routing tree became a migration liability.

**Schema**

```ts
// F121 — the persisted document. Storage DDL lives in F122.
export type RoutingRule = {
  schema_version: number;
  name: string;
  event_types: string[];                  // EventTypeId[]
  condition_groups: ConditionGroup[];
  destinations: { destination_id: string; override?: DestinationOverride }[];
  format: 'auto' | 'plain_text' | 'markdown' | 'native_card';
  mode: 'first_match' | 'fan_out';
  priority: number;                       // 0..999
  enabled: 0 | 1;
};

export type DestinationOverride = {
  format?: 'plain_text' | 'markdown' | 'native_card';
  quiet_hours_id?: string;                // references F146, never embeds policy
  group_by?: GroupByField;                // references F141, never embeds policy
};
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Unknown top-level key | `400`, names the key. Never stripped silently. |
| `destinations` references another org's destination | `403` + audit event; the id is not echoed in the error body |
| Event type not in the catalog | `400` with the closest catalog entries offered |
| Repository outside the connection's installation scope | `400` naming the repository as not covered by this connection |
| Rule would suppress a workspace-critical event type | `400` with the F148 explanation, not a silent no-op |

**Security** — A rule is user-controlled input: `name` is free text and passes F94 escaping at
every render site. `name` is length-capped, control-character-rejected, and never interpolated
into markup. Rules are stored plaintext (they contain no credentials) but destination
references are resolved server-side — the client never supplies a URL.

**Tests**
- `rule_schema_rejects_unknown_top_level_keys`
- `rule_cannot_reference_another_orgs_destination`
- `rule_rejects_a_repository_outside_its_installation_scope`
- `rule_cannot_span_connections`
- `rule_cannot_suppress_a_critical_event_type`
- `priority_ties_break_deterministically_on_rule_id`

**Deps** — F41, F42, F92, F125. **Fixes** D3.

---

## F122 — Rule persistence, tenancy and audit

**Priority** P0 · **Status** not started

**Story** As a support engineer, I want to see what a customer's routing configuration was at
any past moment, so that "it worked yesterday" is a question I can answer.

**Acceptance**
- [ ] Every rule table carries `orgid TEXT NOT NULL REFERENCES organization(id)`.
- [ ] Rules are **versioned in place**: a change writes a new `rule_versions` row and bumps
      `rules.current_version`. Nothing is mutated destructively.
- [ ] The version stores the **serialized, validated** rule JSON plus its `schema_version`, so a
      version can be re-evaluated years later without depending on today's code.
- [ ] Every create / update / enable / disable / delete writes an audit event (F28) with the
      actor, the org, the rule id and the diff.
- [ ] Deleting a rule is a `deleted_at` tombstone, not a `DELETE` — deliveries referencing it
      must still be able to name it (F137).
- [ ] `updated_at` is bumped by the server, never by the client.

**Schema**

```sql
-- F122
CREATE TABLE routing_rules (
  id          TEXT PRIMARY KEY,
  orgid       TEXT NOT NULL REFERENCES organization(id),
  connectionid TEXT NOT NULL REFERENCES connections(id),
  name        TEXT NOT NULL,
  priority    INTEGER NOT NULL DEFAULT 100,
  enabled     INTEGER NOT NULL DEFAULT 1,
  is_default  INTEGER NOT NULL DEFAULT 0,   -- F134
  current_version INTEGER NOT NULL,
  config_schema_version INTEGER NOT NULL,
  deleted_at  INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (orgid, name)
);

CREATE TABLE routing_rule_versions (
  rule_id     TEXT NOT NULL REFERENCES routing_rules(id),
  version     INTEGER NOT NULL,
  config_json TEXT NOT NULL,       -- validated RoutingRule, canonical JSON
  config_hash BLOB NOT NULL,       -- SHA-256, used for change detection + cache key
  schema_version INTEGER NOT NULL,
  actor_user_id TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (rule_id, version)
);

CREATE TABLE routing_rule_event_types (
  rule_id    TEXT NOT NULL REFERENCES routing_rules(id),
  event_type_id TEXT NOT NULL REFERENCES event_types(id),
  PRIMARY KEY (rule_id, event_type_id)
);

CREATE TABLE routing_rule_destinations (
  rule_id     TEXT NOT NULL REFERENCES routing_rules(id),
  destination_id TEXT NOT NULL REFERENCES destinations(id),
  format_override TEXT,            -- NULL → rule.format
  PRIMARY KEY (rule_id, destination_id)
);

CREATE INDEX ix_rules_org_enabled ON routing_rules(orgid, enabled, priority, id);
```

**Design** — Denormalizing event types and destinations into join tables rather than storing
one JSON blob is deliberate. The two lookups the consumer performs are *"rules whose
`event_types` intersect this event"* and *"destinations for the matched rule"*; both want an
index and a bounded result set. A JSON blob forces a full scan of every rule in the org per
event, which on a single-threaded D1 is exactly the cost we are trying to avoid (F136).
`config_json` remains as the version snapshot, not as the read path.

`config_hash` exists so the consumer cache key is a hash comparison rather than a
deserialization-and-diff per message.

**Errors** — a migration that fails must leave the schema at the last good version (F05).

**Security** — `orgid` is not user-supplied on any write path; it comes from the session
(F24). Every read filters on `orgid` in the `WHERE` clause, not in application code after the
fact. No query interpolates a user string.

**Tests**
- `every_rule_table_carries_a_not_null_orgid`
- `rule_update_creates_a_version_and_leaves_the_previous_intact`
- `deleted_rule_is_a_tombstone_and_still_resolvable_by_id`
- `rule_reads_are_tenant_scoped_in_the_where_clause`
- `no_rule_query_exceeds_100_bound_parameters`

**Deps** — F05, F24, F28, F42.

---

## F123 — Condition groups: `all` / `any`

**Priority** P0 · **Status** not started

**Story** As a user, I want to say "send me pull requests **and** only ones that are **either**
failures **or** on the release branch", so that I can express the routing I actually mean
without learning a language.

**Acceptance**

```ts
type ConditionGroup = { match: 'all' | 'any'; conditions: Condition[] }; // 1..8 conditions
type Condition      = { field: string; op: Operator; value: Literal };
type Operator       = 'eq' | 'neq' | 'in' | 'not_in' | 'contains' | 'glob'
                    | 'gt' | 'gte' | 'lt' | 'lte';          // exact set, F124
type Literal        = string | number | boolean | readonly (string | number)[];
```

- [ ] A rule matches iff **every** group matches. Groups are implicitly AND-ed and are
      displayed to the user as *"all of these are true"*.
- [ ] Within a group, `match: 'all'` AND-s the conditions, `match: 'any'` OR-s them. Each is
      rendered as a readable clause.
- [ ] ⭐ **Groups do not nest.** A `ConditionGroup` cannot contain another `ConditionGroup`.
      The Zod schema is a union, not a recursive type, so infinite recursion is impossible
      rather than merely discouraged.
- [ ] A rule with `condition_groups: []` matches every event of its selected types. That is the
      "no conditions" case and it is legal — but the UI always says so explicitly.
- [ ] Maximum 8 conditions per group, 6 groups per rule. Both bounds are enforced with a named
      message, not a silent truncation.
- [ ] `value` is a **literal**, never an expression, a template, a reference to another rule,
      or a URL. Strings are matched with the field's declared comparison semantics (F124).
- [ ] The whole structure is serializable to JSON with no functions, no `RegExp` objects and no
      prototypes — which is what makes F167 testable.

**Design** — Two levels, `all` across groups and `all`/`any` within, is the smallest algebra
that covers every routing sentence the product documents in the competitive set. Sentry uses the
same qualifier pair and calls it *"a single qualifier per block — all / any / none"*
(<https://docs.sentry.io/product/monitors-and-alerts/alerts/create-alerts/>, verified in
`COMPETITIVE-FEATURE-SET.md`). We omit `none` because `none` is not expressible without
negating an arbitrary condition, and once you allow `none` you have invented a third
qualifier whose semantics users must learn for no capability they lacked.

**Trade-off** — no nesting. A user who wants *"failures on main, or anything by Alice"*
expresses it as two rules, which is also two independently auditable units (F137) and two
independently suppressible units in the event log. This is the F167 boundary: **if a rule
cannot be written as typed field-to-literal comparisons, it is not configurable — it is a
feature request.**

**Schema**

```ts
// F123 — a non-recursive union. Nesting is unrepresentable, not merely forbidden.
export type ConditionGroup =
  | { match: 'all'; conditions: readonly Condition[] }   // 1..8
  | { match: 'any'; conditions: readonly Condition[] };  // 1..8

export type Condition = {
  field: string;        // resolved through the F125 registry; never a free path
  op: Operator;         // validated against the field's allowed set
  value: Literal;
};

export type Operator =
  | 'eq' | 'neq' | 'in' | 'not_in'
  | 'contains' | 'not_contains'
  | 'glob' | 'not_glob'
  | 'gt' | 'gte' | 'lt' | 'lte';

export type Literal =
  | string | number | boolean
  | readonly (string | number | boolean)[];
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Nested group in `conditions` | `400`, schema rejects it structurally |
| `conditions` empty | `400` (an empty group can never match; it is a mistake, not a wildcard) |
| `value` is an object or array of arrays | `400`, literal types only |
| Operator not valid for the field's type | `400`, names the allowed operators for that field (F125) |
| Bounds exceeded | `400` with the limit and the current count |

**Security** — A typed, non-recursive, literal-only structure **cannot** be turned into code
execution, template injection or ReDoS. There is no evaluator for a user string anywhere in
this path. That property is the security argument, and it is asserted by a test, not by review.

**Tests**
- `all_groups_must_match_for_the_rule_to_match`
- `group_match_any_ors_its_conditions`
- `groups_cannot_nest`
- `empty_condition_group_is_rejected`
- `filter_group_conditions_accept_only_literals`
- `condition_bounds_are_enforced_with_named_messages`

**Deps** — F121, F124, F167.

---

## F124 — Comparison semantics and three-valued logic

**Priority** P0 · **Status** not started

**Story** As a user, I want "is not a bot" to behave correctly when the source never told us
whether someone is a bot, so that my alerts do not silently disappear.

**Acceptance**
- [ ] Every comparison returns one of **`true` | `false` | `unknown`**. `unknown` is produced
      when the field is absent, explicitly `null`, or outside the envelope for this event type.
- [ ] Kleene semantics, and they are load-bearing:

| Expression | `unknown` result | Rationale |
| --- | --- | --- |
| `actor.isBot eq false` | `unknown` | we do not know |
| `actor.isBot neq true` | `unknown` | **not** `true` — absence of evidence is not evidence |
| `actor.isBot in [false]` | `unknown` | same |
| `path glob 'src/**'` | `false` | a set field with no element can never match a glob |

- [ ] Only `true` matches a rule. `unknown` never satisfies a condition and never satisfies its
      negation.
- [ ] ⭐ **`unknown` is never silent.** An event that reached a rule and produced at least one
      `unknown` is recorded with `decay_unknown_fields: [...]` in the evaluation trace
      (F137) and is visible in the event log as *"this event did not match because GitHub did
      not report whether the actor is a bot"*.
- [ ] String comparison is **case-insensitive and Unicode-normalised (NFC)** for identity-like
      fields (`repo`, `branch`, `actor.login`, `label`); **case-sensitive** for everything else.
- [ ] Numeric comparison is on `Number`, never string comparison, so `"10" < "9"` can never
      occur.
- [ ] Length caps are enforced at comparison time as well as at parse time: a string field
      longer than its registry cap compares as `unknown`, never as a truncated match.
- [ ] `contains` on a set field means "element equals"; on a string field it means
      case-insensitive substring. The registry declares which, so the meaning is never inferred
      from the value.

**Design** — Two-valued logic is the single most dangerous shortcut available in a filter
engine, because it converts "we don't know" into "no" and the user has no way to find out.
`isBot: null` is the canonical case: F43 requires providers that do not distinguish bots to
report `null` *"never `false`, which would be a lie"*, and F151 forbids treating `null` as a
bot. A filter engine that collapses `null` to `false` reintroduces the lie at the last hop.

The asymmetry in the table is deliberate: a glob over an absent set is `false` because the
claim "at least one changed path matches `src/**`" is definitely false when there are no paths,
whereas "the actor is not a bot" is not definitely true when nobody said.

**Trade-off** — `unknown` produces more evaluation-trace noise. We accept it: the alternative
is a filter engine that quietly answers questions the data cannot answer.

**Schema**

```ts
// F124 — three-valued. A boolean here would be a lie the compiler could not see.
export type Truth = true | false | 'unknown';

export type Comparison = (field: FieldValue) => Truth;

export type FieldValue =
  | { kind: 'absent' }            // field not present for this event type
  | { kind: 'null' }              // provider explicitly reported nothing
  | { kind: 'string'; v: string }
  | { kind: 'number'; v: number }
  | { kind: 'boolean'; v: boolean | null }
  | { kind: 'set'; v: readonly string[] }
  | { kind: 'invalid'; why: string };   // over-length, wrong type -> unknown
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Field absent from the envelope for this event type | `unknown`, field name recorded |
| Field present but `null` | `unknown` |
| Value exceeds the registry's length cap | `unknown`, `truncated` flag in the trace |
| Type mismatch (string field given a number literal) | Rejected at **write** time; if it reaches evaluation it is `unknown`, not a coercion |

**Security** — NFC normalisation happens **before** comparison, not before storage, so a
lookalike character cannot be used to smuggle a different repository past a rule. Comparison
functions are pure and bounded: no regex is constructed from user input anywhere in this path,
so no ReDoS surface exists.

**Tests**
- `absent_field_yields_unknown_not_false`
- `null_boolean_field_does_not_satisfy_a_negated_condition`
- `glob_over_an_empty_set_is_false`
- `numeric_comparison_does_not_coerce_strings`
- `string_comparison_is_nfc_normalised_and_case_insensitive_for_identity_fields`
- `over_length_value_compares_as_unknown`

**Deps** — F43, F125, F151.

---

## F125 — Filter field registry

**Priority** P0 · **Status** not started · **Blocks** every other feature in this file

**Story** As a user, I want the filter list to be short, typed and honest about what each field
means, so that I can pick the right one without documentation.

**Acceptance** — the registry is a closed, code-owned table. The UI renders it; it is not
queried from the client.

| Field path | Type | Cardinality | Operators | Nullable | User-facing label |
| --- | --- | --- | --- | --- | --- |
| `type` | string | single | `eq in not_in` | no | "Event type" |
| `data.outcome` | string | single | `eq in not_in` | no | "Result" |
| `data.repository.fullName` | string | single | `eq in not_in` | no | "Repository" |
| `data.actor.login` | string | single | `eq in not_in contains` | no | "By" |
| `data.actor.isBot` | boolean\|null | single | `eq neq` | **yes** | "From a bot" |
| `data.actor.isGhost` | boolean\|null | single | `eq neq` | **yes** | "From a deleted user" |
| `data.branch` | string | single | `eq in not_in glob` | yes | "Branch" |
| `data.baseBranch` | string | single | `eq in not_in glob` | yes | "Into branch" |
| `data.labels` | string[] | set | `contains not_contains` | yes | "Label" |
| `data.paths` | string[] | set | `glob not_glob` | yes | "Changed files" |
| `data.number` | number | single | `eq neq gt gte lt lte in` | yes | "Number" |
| `data.title` | string | single | `contains` | yes | "Title contains" |
| `data.provider` | string | single | `eq in` | no | "Source" |

- [ ] Each registry entry declares: path, TypeScript type, cardinality, **allowed operator
      set**, nullable, max string length, case-sensitivity, and the user-facing label. A
      condition whose operator is not in the field's allowed set is rejected (F123).
- [ ] ⭐ `data.title` is the **only** free-text field, it supports `contains` only, and it is
      **off by default** behind an "Advanced" disclosure in the UI. It is the one field that
      invites the unbounded-expectation failure mode, and it is bounded deliberately rather
      than omitted.
- [ ] ⭐ A field that is **not** in this table cannot be filtered on, even by a crafted API
      request. The filter builder resolves `field` through the registry; an unknown path is a
      `400`, never a dynamic property lookup. `path` is never evaluated as JavaScript.
- [ ] Adding a field is a code change plus a catalog bump — a reviewable diff, not a runtime
      configuration.
- [ ] Each entry declares `first_available_version`, so a rule authored against `v1` never
      changes meaning when `v2` adds fields.
- [ ] Registry and catalog are validated in one unit test: every path in the registry resolves
      against at least one published `dataschema` (F46).

**Design** — The registry is the mechanism that keeps F167 enforceable. An expression language
is what lets a filter reach a field we did not anticipate; a registry makes the reachable field
set a compile-time fact. It is also what makes the UI honest: the operator list per field is
data, so the "contains only" restriction on `title` cannot drift away from the widget that
offers it.

Free text is included deliberately and once. Excluding `title` entirely would push users into
filters we cannot support; including it as a first-class equality field would invite
`title eq "fix: asdf"`. `contains` on a capped, normalised, non-regex comparison is the honest
middle, and it is behind an Advanced disclosure because a non-technical user who reaches for
it has already left the preset path.

**Trade-off** — no computed fields, no "changed files count", no "time of day". Each of those
is a product decision that changes what a *preset* can guarantee, and would need its own
semantics, preview and test. They are roadmap items, not V1.

**Schema**

```ts
// F125 — code-owned. Adding an entry is a reviewed diff, never runtime configuration.
export type FieldSpec = {
  path: string;                       // dotted path into the envelope, resolved via a lookup map
  type: 'string' | 'number' | 'boolean' | 'string[]';
  nullable: boolean;
  cardinality: 'single' | 'set';
  operators: readonly Operator[];     // exhaustive for this field
  maxLength?: number;                 // strings only
  caseSensitive: boolean;             // false for identity-like fields
  label: string;                      // user-facing, shown verbatim in the UI
  advanced?: boolean;                 // collapsed behind "Advanced" (data.title only)
  firstAvailableVersion: number;
};

export const FIELD_REGISTRY: Readonly<Record<string, FieldSpec>> = { /* … */ };
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Unknown field path | `400`, listing the available field labels |
| Operator not allowed for that field | `400`, listing the allowed operators |
| Field exists in the registry but not on this event type | Accepted; evaluates to `unknown` at runtime (F124) |
| Registry entry with no matching `dataschema` path | Test failure, not a runtime error |

**Security** — No dynamic property access. Field paths are resolved against a compiled lookup
map, never `obj[a.b]`. A registry is therefore not a prototype-pollution vector and cannot be
used to reach `constructor` or `__proto__`.

**Tests**
- `registry_is_closed_and_rejects_unknown_field_paths`
- `registry_operator_sets_match_the_ui_widgets`
- `every_registry_field_resolves_against_a_published_dataschema`
- `title_is_the_only_free_text_field_and_is_contains_only`
- `field_lookup_never_uses_dynamic_property_access`

**Deps** — F41, F42, F46, F167.

---

## F126 — Repository filter capability

**Priority** P0 · **Status** not started

**Story** As a user in an agency, I want to route a client repository to that client's channel
and nothing else, so that one client's alerts can never reach another client's chat.

**Acceptance**
- [ ] `data.repository.fullName` is compared **exactly**, case-insensitively, after NFC
      normalisation. No globs, no prefixes, no `*`.
- [ ] Multiple repositories use `in` / `not_in` with a flat list.
- [ ] The value list offered by the UI comes from the connection's **authorized installation
      repository set** (F67) — never from free text, never from the event body.
- [ ] ⭐ A repository outside the connection's installation scope is rejected at **write** time
      with the message *"`<repo>` is not covered by this connection"*. It is not saved as a
      never-matching rule.
- [ ] Comparison is against `data.repository.fullName` **as normalized by F62**, never against
      `event.repository.full_name` from the raw body. If normalization disagrees with the raw
      body, normalization wins and the disagreement raises a metric.
- [ ] Renamed repositories therefore stop matching, loudly: the event is recorded as
      `suppressed` with reason `repository_not_in_allowlist`, and the UI links to the repository
      that has been renamed, if F69's reconciliation has already recorded it.

**Design** — Globs here would be a security feature masquerading as a convenience. A
`acme/*` pattern means "anything this tenant can see under the acme org", and the blast radius
of that mistake is a cross-client notification — the single most damaging class of bug in this
product (`F141` makes the same argument about grouping). GitHub's own branch/path filters do
support `*` and `**` globs, and we adopt those for `branch` and `path` where the blast radius is
one branch inside a repository the tenant already owns. Repository identity is the tenant
boundary; it does not get a pattern language.

Renames are the real cost of exactness, and the honest handling is to be loud about the miss
rather than to quietly wildcard it away.

**Schema**

```ts
// F126 — repository identity. Exact match only; no glob variant exists by design.
export type RepositorySpec = {
  path: 'data.repository.fullName';
  type: 'string';
  nullable: false;
  cardinality: 'single';
  operators: ['eq', 'in', 'not_in'] as const;
  maxLength: 200;                     // 'owner/repo', normalized lowercase for comparison
  caseSensitive: false;
  label: 'Repository';
};

// Write-time: every literal is checked against the connection's authorized
// installation repository set (F67) before the rule is persisted.
export function assertRepositoriesInScope(
  spec: RepositorySpec, literals: readonly string[], authorized: ReadonlySet<string>,
): { ok: true } | { ok: false; rejected: { value: string; reason: 'out_of_scope' }[] };
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Repository not in the connection's installation scope | `400` at write time |
| Repository renamed upstream | Event `suppressed`, reason `repository_not_in_allowlist`, surfaced in the integration health view |
| `fullName` missing from the envelope | `unknown` (F124); the rule does not match |

**Security** — The repository filter is a **narrowing** control only. It never grants access:
an event for a repository the installation does not cover never reaches rule evaluation at all
(F57, F67). A bug that made a filter *widen* access would have to defeat the installation
lookup first, which is an independent, tested path.

**Tests**
- `repository_filter_is_exact_match_only`
- `repository_outside_installation_scope_is_rejected_at_write_time`
- `repository_rename_is_surfaced_as_a_suppression_reason`
- `repository_comparison_uses_the_normalized_field_not_the_raw_body`

**Deps** — F62, F67, F124.

---

## F127 — Branch filter capability

**Priority** P0 · **Status** not started

**Story** As a user, I want "only the release branch" and "not the sandbox branch", so that
routine work on experimental branches does not page me.

**Acceptance**
- [ ] `glob` on `data.branch` and `data.baseBranch` supports exactly `*` (any run of characters
      within one path segment) and `**` (any run including `/`), with `\` escaping a literal
      `*`. This matches GitHub's documented branch-filter glob semantics
      (<https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax>,
      read 2026-10-13).
- [ ] `eq` / `in` give an exact branch list, which is what the UI offers by default.
- [ ] ⭐ **We do not implement ordered `!` negation.** GitHub documents the footgun directly:
      *"The order that you define patterns matters. A matching negative pattern (prefixed with
      `!`) after a positive match will exclude the ref. A matching positive pattern after a
      negative match will include the ref again."* Order-dependent matching is not a feature a
      non-technical user can reason about; `not_in` with an explicit list covers the real need
      (F142's precedent: never expose the mechanism, expose the choice).
- [ ] `data.baseBranch` and `data.branch` are separate fields. "Into `main`" and "from
      `main`" are different questions and the UI asks them separately.
- [ ] Branch values are compared after NFC normalisation and case-insensitively (F124).
- [ ] A branch pattern is compiled once per rule version and cached with it (F136), not
      recompiled per event.
- [ ] `branches` on a `workflow_run` event means the branch of the triggering workflow, per
      GitHub's own definition; F62 sets `data.branch` to that value and it is asserted there.

**Design** — Glob support is here because GitHub users already have this vocabulary from
Actions and from branch protection, and because the alternative (exact branch names only)
would force a rule per branch. The `*`/`**` set is deliberately the smallest one that covers
`main`, `releases/**` and `fix/**`.

Not implementing `!` is the one place we knowingly accept expressiveness loss. Alertmanager's
matcher-parser migration is the standing evidence that ordering-sensitive string grammars
become multi-year liabilities (`COMPETITIVE-FEATURE-SET.md` §5). `not_in` is total, order-free
and previewable (F139).

**Schema**

```ts
// F127 — '*' and '**' only, matched by a hand-written linear-time walker.
// No RegExp is constructed from user input anywhere in this path.
export type GlobSpec = {
  path: 'data.branch' | 'data.baseBranch';
  type: 'string';
  nullable: true;
  cardinality: 'single';
  operators: ['eq', 'neq', 'in', 'not_in', 'glob'] as const;  // NO 'not_glob'
  maxLength: 255;
  caseSensitive: false;
  label: 'Branch';
};

export type CompiledGlob =
  | { kind: 'literal'; value: string }
  | { kind: 'prefix'; value: string }          // 'releases/**'
  | { kind: 'suffix'; value: string }          // '**-rc'
  | { kind: 'segments'; parts: readonly string[] };  // 'src/**/index.ts'

export function compileGlob(pattern: string): CompiledGlob;  // throws GlobError on unsupported syntax
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Unsupported glob character (`+`, `?`, character classes) | `400`, names the supported set |
| Unbalanced or trailing `\` | `400` |
| `branch` absent for this event type | `unknown`; the UI disables the field for that type |
| Pattern list over the bound (32 patterns per field) | `400` with the count |

**Security** — Patterns are compiled with a **hand-written linear-time matcher**, not
`RegExp`. A regex built from user input is a catastrophic-backtracking vector; a `*`/`**`
trie-walk over a bounded string is not. Strings are length-capped at parse time, so the walk
is bounded too.

**Tests**
- `branch_glob_supports_star_and_double_star_only`
- `branch_negation_via_bang_is_not_implemented`
- `branch_matching_is_case_insensitive_and_nfc_normalised`
- `branch_matcher_is_linear_time_on_adversarial_input`
- `branch_patterns_are_compiled_once_per_rule_version`

**Deps** — F62, F124, F125, F136.

---

## F128 — Label filter capability

**Priority** P1 · **Status** not started

**Story** As a user, I want "only things labelled bug" so that the triage channel stays about
bugs.

**Acceptance**
- [ ] `data.labels` is a **set**. `contains` means "some element equals the literal";
      `not_contains` means "no element equals the literal".
- [ ] Comparison is case-insensitive and NFC-normalised; GitHub label names are
      case-preserving but case-insensitive for lookup.
- [ ] The `in`/`eq` operators are **not** valid on a set field. `labels eq 'bug'` is a `400`,
      not a stringified-array comparison.
- [ ] The UI's label picker is populated from labels **observed on this connection's recent
      events**, not from a GitHub API call at author time. The source of truth is what we have
      actually received, and the picker states how fresh the list is.
- [ ] `labels` is `[]` (not `null`) when the provider sent an empty array; `null` means the
      field was absent. Both yield `false` for `contains` and `true` for `not_contains`,
      because "there are no labels" is a fact, not an absence of fact.
- [ ] Label values are length-capped and passed through F94 escaping at every render site.

**Design** — No outbound GitHub call at author time: it would put an API round trip in the
middle of a configuration interaction, consume the 5,000 req/hr budget (F49), and — worse —
suggest a list of labels that may not correspond to anything the customer's installation can
produce. Deriving the picker from observed events means the picker only ever offers labels
that have genuinely produced notifications, which is the correct bias for a routing tool.

**Schema**

```ts
// F128 — set semantics. `contains` is element membership, never substring.
export type LabelSpec = {
  path: 'data.labels';
  type: 'string[]';
  nullable: true;                     // null = absent; [] = "there are no labels" (a fact)
  cardinality: 'set';
  operators: ['contains', 'not_contains'] as const;   // eq/in rejected on sets
  maxLength: 100;
  caseSensitive: false;
  label: 'Label';
};

// Picker source: labels observed on THIS connection's recent events. Never an API call.
export type ObservedLabel = { label: string; last_seen_at: number; count_30d: number };
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| `eq`/`in` used on a set field | `400`, names the set operators |
| Picker list older than the stated freshness window | Badge shown; no error |
| `labels` absent | `false` for `contains`, `true` for `not_contains` |

**Security** — Label names are attacker-influenced text from a repository the tenant chose.
They are capped, escaped per destination (F94), and never used as a storage key or a path.

**Tests**
- `label_contains_is_element_membership_not_substring`
- `label_eq_is_rejected_on_a_set_field`
- `empty_label_array_is_false_for_contains_and_true_for_not_contains`
- `label_picker_is_derived_from_observed_events_not_an_api_call`

**Deps** — F49, F62, F125.

---

## F129 — Path pattern filter capability

**Priority** P1 · **Status** not started · **⚠️ has a documented upstream failure mode**

**Story** As a user, I want "only when files under `src/` change", so that documentation-only
pull requests do not wake my team.

**Acceptance**
- [ ] `data.paths` is the normalized changed-file list. `glob` = at least one element matches;
      `not_glob` = no element matches.
- [ ] Same `*` / `**` semantics as branch (F127), same linear-time matcher, same rejection of
      unsupported characters.
- [ ] `paths` is **only populated for event types that carry a changed-file list** —
      `push`, `pull_request`, and commits attached to them. For every other type the field is
      absent and the UI disables the control with *"not available for this event type"*.
- [ ] ⚠️ **The changed-file list in the payload is not authoritative and must not be presented
      as if it were.** GitHub documents these failure cases for its own path filtering: if a
      push contains **more than 1,000 commits** the filter *"will always run"*; if generating
      the diff times out it *"will always run"*; and if the generated diff contains **more than
      3,000 files** and the matching files are not in the first 3,000 returned, it *"will not
      run"* (<https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax>,
      read 2026-10-13). Ours differs in that we always receive the event, but the same
      truncation applies to the payload we are given.
- [ ] ⭐ Therefore: when the event carries a `commits` count or file list that exceeds a
      documented threshold (see the unverified item below), `data.paths` is set to `null` and
      the envelope is marked `paths_incomplete: true`. A path filter over an incomplete list
      evaluates to `unknown`, **never** to `false`.
- [ ] The UI states the limitation once, in the field's help text: *"Large pushes may not list
      every changed file. When that happens this filter is skipped and the event is labelled."*
- [ ] `paths_incomplete` appears in the delivery detail and in the evaluation trace (F137), so
      a user who filtered something out can tell "no path matched" from "we did not know".

**⚠️ UNVERIFIED** — the exact threshold at which GitHub truncates `commits[]`,
`commits[].added/removed/modified` in a `push` or `pull_request` payload. The workflow-syntax
page documents the 3,000-file behaviour of *its own* diff generation, not the webhook payload.
**What to check:** capture a real webhook payload for a push exceeding 1,000 commits and a PR
exceeding 3,000 changed files and record which array is truncated and at what length. Until
that is measured, `paths_incomplete` must default to *on* for any event whose commit count
exceeds the largest value observed in the fixture suite. Do not hardcode a number we have not
seen.

**Design** — A path filter that silently returns "false" on a truncated list is a filter that
drops real alerts, which is the worst possible failure for a CI notification router. Three-valued
logic (F124) gives us the correct behaviour for free: unknown fields do not match, and the
reason is recorded. The honest cost is that some events pass through unfiltered, and that has
to be *said* rather than hidden.

**Schema**

```ts
// F129 — plus two envelope additions in F62 / F129:
//   data.paths: string[] | null      — null means INCOMPLETE, never "no paths"
//   data.pathsIncomplete: boolean    — set whenever paths is null because of truncation
export type PathSpec = {
  path: 'data.paths';
  type: 'string[]';
  nullable: true;
  cardinality: 'set';
  operators: ['glob', 'not_glob'] as const;
  maxLength: 512;                    // per path, matching GitHub's own limit
  caseSensitive: true;               // paths are case-sensitive on every provider we support
  label: 'Changed files';
  availableFor: readonly EventTypeId[];   // push, pull_request, …
};

// NOT AVAILABLE on any other event type -> the UI disables the control with a
// reason rather than hiding it.
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Path list incomplete or truncated | `paths = null`, `paths_incomplete: true`, filters evaluate `unknown` |
| Event type has no changed-file list | Field absent, UI control disabled with an explanation |
| Pattern over the bound | `400` with the count |
| Empty path list (`[]`) | `false` for `glob` — "no paths matched" is a fact |

**Security** — Path values come from a repository the tenant controls and are attacker-influenced
(forks, PR branches). They are never used to construct a filesystem path on our side, never used
as an R2 key, and never rendered as markup.

**Tests**
- `path_glob_matches_when_any_element_matches`
- `incomplete_path_list_yields_unknown_not_false`
- `paths_incomplete_is_surfaced_in_the_delivery_detail`
- `path_field_is_unavailable_for_event_types_without_changed_files`
- `path_matcher_is_linear_time_on_adversarial_input`

**Deps** — F62, F124, F137.

---

## F130 — Pull request / issue number filter capability

**Priority** P1 · **Status** not started

**Story** As a user triaging one thread, I want "only PR 482", so that I can follow a single
conversation without a rule that fires on every number.

**Acceptance**
- [ ] `data.number` is an integer, compared with `eq neq gt gte lt lte in`. Never as a string.
- [ ] `in` accepts up to 200 numbers per condition, deduplicated, order-insensitive.
- [ ] Numeric bounds are supported so a rule can say "anything below 100" — the mechanism is a
      range, but the UI presents it as *"new items only"* with an optional starting point, not
      as `gt 99`.
- [ ] The field is **shared** by `pull_request`, `issue` and, where meaningful, other numbered
      entities. The UI label changes with the event type (*"Pull request number"* /
      *"Issue number"*), the field path does not.
- [ ] ⚠️ A number is **repository-scoped, not tenant-scoped**. `data.number` must never be
      evaluated without a repository condition in the same rule's match, because "482" means
      nothing on its own. The UI requires a repository condition when a number condition is
      present, and the evaluator records `number_without_repository` as a configuration warning
      at write time rather than failing the rule.
- [ ] `data.number` is `null` for unnumbered event types; that is `unknown`, not `0`.
- [ ] Large values (above 2^31) are accepted as integers; GitHub numbers are far below this but
      we do not invent a ceiling.

**Design** — The warning rather than the hard failure is deliberate: a hard failure would block a
legitimate configuration (a single-repo integration where the repository is already implied by
the connection's scope), while silently accepting it produces a rule that matches every
repository's PR 482. Warning at write time, recording the warning permanently on the rule, and
showing it in the UI gets the user to a correct rule without a hard stop. `gt 99` expressed as
"new items only" is the F142 pattern: the mechanism is never the interface.

**Schema**

```ts
// F130
export type NumberSpec = {
  path: 'data.number';
  type: 'number';
  nullable: true;
  cardinality: 'single';
  operators: ['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte'] as const;
  label: 'Number';                   // label varies by event type in the UI, path does not
};

// Numbers are repository-scoped. A number condition without a repository condition
// in the same match is accepted but permanently flagged on the rule.
export type RuleWarning = 'number_without_repository';

export type RuleRecord = {
  id: string; orgid: string; connectionid: string;
  warnings: readonly RuleWarning[];
};
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Number literal out of integer range | `400` |
| `in` list over 200 entries | `400` with the count |
| Number condition without a repository condition | Accepted; rule flagged with a persistent `number_without_repository` warning |
| `data.number` absent | `unknown` |

**Security** — Numeric field, no string coercion, so no type-confusion path. The
number-without-repository warning exists partly because an unbounded number match is a
cross-repository firing pattern that a user can mistake for a targeted rule.

**Tests**
- `number_comparison_is_integer_only`
- `number_in_list_is_deduplicated_and_order_insensitive`
- `number_condition_without_repository_condition_is_flagged_not_rejected`
- `absent_number_is_unknown_not_zero`

**Deps** — F62, F124, F125.

---

## F131 — Event type selection and outcome conditions

**Priority** P0 · **Status** not started · **Fixes** part of D12, D16

**Story** As a user, I want to pick "CI failed" from a list of checkboxes rather than type a
string format, so that I can tell the difference between "no match" and "I misspelled it".

**Acceptance**
- [ ] `event_types[]` references the closed catalog (F42). The client sends ids, never free-form
      strings that become routing keys.
- [ ] The picker is grouped by catalog `category` (`pull_request`, `issue`, `ci`, `release`,
      `repo`) and shows each entry's **default outcome** next to its name, because that is the
      thing users actually want to know ("CI failed" is a `failure`).
- [ ] An open/close pair is presented as two distinct entries with their own labels (*"Pull
      request opened"*, *"Pull request closed"*), because F44 models them as **state
      transitions**, not as one event with a flag.
- [ ] Every catalog entry has a **test toggle**: selecting it runs a real fixture envelope
      through the rule and shows the exact rendered notification before the rule is saved. Not
      a mock, not a placeholder — the same renderer the destination will use (F98's test-send).
- [ ] Events whose type arrives at runtime outside the catalog are stored as
      `unmapped:<raw>` (F42) and appear in the picker under **"Not yet classified"** with a
      label, so a user can see them without them being routable by an unvalidated string.
- [ ] ⚠️ Removing an event type from the catalog never silently breaks an existing rule: the
      rule is flagged `catalog_drift` with the missing ids, still evaluates (matching nothing
      for that id), and appears in the integration health view until fixed.
- [ ] `data.outcome` is filterable as a plain enum field (`success | failure | neutral`), so
      "Failures only" is one condition rather than a selection of dozens of type ids.

**Design** — Outcome as a first-class filter is what makes the highest-value preset possible.
"Failures only" is the entry point in F154 and the one a non-technical user reaches for
immediately; expressing it as an enumeration of every CI failure event type across every
provider is a combinatorial maintenance burden and a bad first-run experience. Normalizing
outcome at ingest (F44) is precisely what makes it a one-field filter here.

Because F46 makes `type` the identity of a breaking schema change and `dataschema` the
identity of any change, the catalog id is stable enough to be a foreign key. `catalog_drift`
exists because catalog entries are removed (a GitHub action is retired) and a hard delete would
leave an existing rule pointing at nothing with no signal.

**Schema**

```sql
-- F131 — selection is a FK, never a free-text routing key (F42).
CREATE TABLE routing_rule_event_types (
  rule_id      TEXT NOT NULL REFERENCES routing_rules(id) ON DELETE CASCADE,
  event_type_id TEXT NOT NULL REFERENCES event_types(id),
  PRIMARY KEY (rule_id, event_type_id)
);

CREATE TABLE rule_catalog_drift (
  rule_id      TEXT NOT NULL REFERENCES routing_rules(id),
  missing_type_id TEXT NOT NULL,
  detected_at  INTEGER NOT NULL,
  resolved_at  INTEGER,
  PRIMARY KEY (rule_id, missing_type_id)
);
```

```ts
// 'outcome' is an ordinary registry field (F125), which is what makes the
// "Failures only" preset one condition instead of dozens of type ids.
export type OutcomeFilter = { field: 'data.outcome'; op: 'in' | 'eq';
                             value: ('success' | 'failure' | 'neutral')[] };
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Unknown event type id | `400` with near-miss suggestions from the catalog |
| Rule references a catalog id later removed | `catalog_drift` flag, rule still loads, surfaces in health view |
| Unmapped runtime type arrives | Stored, surfaced, never routable by raw string |
| Rule selects only `neutral` types and no conditions | Valid; the UI notes it may produce high volume (F164) |

**Security** — The catalog is **server-owned**. A client-supplied free-text type becomes a
routing key today (`classifyGithubEvent` returns `kind + '.' + action` freely, D16) and is
exactly the unbounded key space this feature removes. Free text in this field is rejected.

**Tests**
- `event_type_selection_rejects_free_text`
- `outcome_condition_replaces_enumerating_every_failure_type`
- `picker_shows_every_catalog_entry_with_its_default_outcome`
- `removed_catalog_entry_flags_existing_rules_as_catalog_drift`
- `unmapped_runtime_type_is_visible_but_not_routable`

**Deps** — F42, F44, F46, F154. **Fixes** part of D12, D16.

---

## F132 — Rule priority, evaluation order, fan-out and conflict resolution

**Priority** P0 · **Status** not started

**Story** As a user with a specific exception, I want my exception to beat my general rule, so
that "everything from Alice goes to the triage channel" is not swallowed by "everything goes to
the team channel".

**Acceptance** — evaluation is a single ordered pass with two explicit, user-selectable modes.

| Setting | Default | Meaning |
| --- | --- | --- |
| **Send to** | *First matching rule only* | Stop at the first match |
| **When several rules match** | as above | Send to one destination, or to all |

- [ ] Rules are ordered by `(priority ASC, rule.id ASC)`. The tie-break is **total and
      stable**, so evaluation is deterministic and a test can assert an exact order.
- [ ] Rules are **pre-filtered by event type** before any condition is evaluated: the candidate
      set is the rules whose `event_types` intersect the event's type. This is the index that
      makes evaluation cheap (F136).
- [ ] ⭐ **Short-circuit:** within a rule, conditions evaluate in declaration order and stop at
      the first `false`. The evaluation trace records which condition decided it (F137), so a
      user can see *why* without re-deriving it.
- [ ] **First-match mode:** evaluation stops at the first matching rule. That rule's destinations
      receive the event. Later rules are not evaluated and are recorded as
      `not_evaluated: first-match-stopped` in the trace.
- [ ] **Fan-out mode (all matching rules):** every matching rule contributes its destinations.
      The union is **deduplicated by `destination_id`**, so one destination referenced by three
      rules produces exactly **one** delivery, attributed to the **highest-priority** matching
      rule. This is the rule that makes fan-out safe, and it is tested explicitly.
- [ ] Two rules with different formats targeting the same destination: the **highest-priority**
      rule's format wins, and the conflict is shown in the UI as a warning at write time, not
      resolved silently at delivery time.
- [ ] ⭐ **No "stop processing" semantic for a non-matching rule.** There is no equivalent of
      Alertmanager's `continue: false` sibling-tree control, because our rule set is flat and
      there is no tree to continue past. Recorded here so a future contributor does not add it
      by analogy.
- [ ] Evaluation order is independent of row insertion order and of the order rows come back
      from SQLite; both are asserted by a test that shuffles insertion order.

**Design** — Defaulting to first-match is the honest default for a non-technical audience: "the
first rule that applies wins" is a sentence everyone understands, whereas fan-out silently
multiplies volume and is the mechanism by which alerting systems surprise their users.
Sentry's model — multiple independent If/Then blocks against the same trigger — is the same
fan-out idea and we support it, but as an explicit choice rather than as the default.

Deduplicating the destination union in fan-out mode is the part that is easy to get wrong.
Without it, three rules mentioning the same Slack channel produce three identical messages, and
the user's reaction is to blame the product. With it, fan-out is safe and the cost is that
format precedence has to be *explained* rather than *chosen*, which is why it is a write-time
warning.

**Trade-off** — priority is a number, which is a mild abstraction. The UI exposes drag-to-reorder
and shows the resulting order as an ordered list of sentences; the number is the storage, not
the interface. We deliberately do not implement Alertmanager's nested route tree (F167).

**Schema**

```ts
// F132 — evaluation order is total, so a test can assert an exact sequence.
export type CandidateOrder = readonly string[];   // (priority ASC, rule.id ASC)

export type MatchMode = 'first_match' | 'fan_out';

// Fan-out: the destination union is deduplicated and attributed to the
// highest-priority matching rule. Two rules naming the same destination produce
// exactly ONE delivery.
export type ResolvedTarget = {
  destination_id: string;
  attributed_rule_id: string;
  format: 'plain_text' | 'markdown' | 'native_card';
};

export type Decision =
  | { outcome: 'matched';        targets: readonly ResolvedTarget[] }
  | { outcome: 'suppressed';     reason: 'no_rule_matched' | 'unknown_only'; trace: EvaluationTrace }
  | { outcome: 'not_routed';     reason: 'critical_lock' | 'preference' | 'quiet_hours' };
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Two matching rules, one destination, different formats | Highest priority wins; conflict recorded as a rule warning |
| Priority tie | `rule.id` ascending; total order, always |
| No rule matches | Event recorded `suppressed`, reason `no_rule_matched`, visible in the event log |
| Candidate set empty after event-type pre-filter | Same as no rule matched; the pre-filter is **not** recorded as a failure |

**Security** — Rule selection never changes tenant scope. The candidate set is already bounded
by the connection's installation (F67) before evaluation begins. Destination ids are re-resolved
through the tenant-scoped repository layer at delivery time (F24), so a rule that referenced a
since-deleted destination fails closed rather than delivering to a recycled id.

**Tests**
- `rules_evaluate_in_priority_then_id_order`
- `evaluation_is_independent_of_row_insertion_order`
- `first_match_mode_stops_evaluation_and_records_the_stop`
- `fan_out_deduplicates_destinations_and_attributes_the_highest_priority_rule`
- `condition_short_circuit_records_the_deciding_condition`
- `event_type_prefilter_narrows_the_candidate_set_before_condition_evaluation`
- `no_continue_semantic_exists_in_the_evaluator`

**Deps** — F121, F136, F137.

---

## F133 — Format selection and per-destination overrides

**Priority** P1 · **Status** not started

**Story** As a user, I want Slack to get a rich card while a plain webhook gets readable text,
so that I am not forced to pick one format for the whole rule.

**Acceptance**
- [ ] `rule.format` is the default for every destination on the rule.
- [ ] `routing_rule_destinations.format_override` overrides it for one destination.
- [ ] `format: 'auto'` resolves per destination from `capabilities()` (F92). It never produces a
      silent downgrade: the resolved format and the reason are stored on the delivery row.
- [ ] An override to `native_card` on a destination whose capabilities exclude it is **rejected
      at write time** with the destination's actual capability list — not applied and downgraded
      at send time.
- [ ] The UI shows the **effective format per destination**, resolved, with the source level
      named (*"Card · set on this destination"* / *"Card · from the rule"*). Same precedence
      discipline as F147's three-level preferences; one shared resolver so they cannot disagree.
- [ ] An override to `markdown` on a destination with no markdown support is accepted and
      degraded through F93's ladder, with the degradation rendered visibly in the message. The
      difference from `native_card` is deliberate: markdown degrades to text and survives,
      native card has no equivalent and would be lost.
- [ ] Format is stored per **attempt**, not per delivery, so a replay after a capability change
      records what actually happened.

**Design** — Two levels rather than a per-destination matrix because the second level is
rarely needed and every extra level is another precedence rule a user must learn. The
important property is that the *resolved* format is stored on the attempt: without that, a
delivery rendered after a destination capability change is unexplainable, and F92's honest
degradation ladder cannot be audited.

The `native_card`-rejected / `markdown`-degraded asymmetry is a judgement call, stated here so
it can be revisited: offering a card format that cannot be rendered is a configuration lie, while
offering markdown that falls back to text is a formatting preference that survives.

**Schema**

```ts
// F133 — two levels, one shared resolver with F147 so precedence cannot diverge.
export type FormatLevel =
  | { source: 'rule';        format: 'auto' | 'plain_text' | 'markdown' | 'native_card' }
  | { source: 'destination'; format: 'plain_text' | 'markdown' | 'native_card' };

export type ResolvedFormat = {
  requested: FormatLevel['format'];
  rendered: 'plain_text' | 'markdown' | 'native_card';
  degraded: boolean;
  degradation_reason?: 'no_markdown_support' | 'no_card_support' | 'body_cap_exceeded';
};

// Stored per ATTEMPT, not per delivery: a replay after a capability change must
// record what actually happened.
export type AttemptFormat = { delivery_attempt_id: string } & ResolvedFormat;
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Override `native_card` on a destination without card support | `400` at write time, listing real capabilities |
| Override `markdown` on a destination without markdown | Accepted; rendered through F93 with a visible degradation note |
| No override, `auto`, capability unavailable | Resolved to the best supported format, reason stored |
| Destination deleted while a rule still references it | Delivery fails closed with `destination_revoked` (F13); rule flagged |

**Security** — Format selection is server-resolved. The client cannot request a format outside
the registry set, and the renderer's escaping (F94) is applied regardless of the resolved
format, so choosing `markdown` never becomes a way to inject raw markup.

**Tests**
- `destination_override_beats_rule_format`
- `auto_resolves_per_destination_and_stores_the_reason`
- `native_card_override_on_an_incapable_destination_is_rejected_at_write_time`
- `markdown_override_degrades_visibly_rather_than_being_rejected`
- `effective_format_and_its_source_are_always_visible`
- `resolved_format_is_recorded_per_attempt`

**Deps** — F92, F93, F94, F147.

---

## F134 — Default rules and workspace bootstrap

**Priority** P1 · **Status** not started

**Story** As a new user, I want my workspace to receive something sensible the moment I connect
GitHub, so that my first ten minutes are not an empty channel and a configuration form.

**Acceptance**
- [ ] Every workspace is seeded with one enabled default rule at creation: **"Everything →
      your primary destination, immediately"** (F154's `Everything` preset, the documented
      default for new users).
- [ ] Default rules are created with `is_default = 1` and are **editable and deletable**. When
      deleted they are tombstoned like any other rule (F122) and no replacement is created.
- [ ] ⭐ A default rule is never re-applied over a user's changes. There is no "reset to
      defaults" that overwrites; the action is *"restore default"*, which **creates a new rule**
      with the default name suffixed and tells the user both now exist.
- [ ] Default rules are subject to the same critical-event lock (F148) and the same write-time
      validation as any other rule. There is no privileged default.
- [ ] Applying a preset (F154) is a **previewed diff** (*"This will stop sending 3 event types
      and group comments for 5 minutes"*), implemented against this same model: presets produce
      a candidate rule set which is diffed against the current one, never applied blind.
- [ ] The default rule's existence is stated at connection time: *"We'll start sending you
      everything; change that whenever you like."*

**Design** — A workspace with zero rules is indistinguishable from a broken integration, and
that is the worst first impression a non-technical user can have. One catch-all rule removes the
empty state without pretending to know what they want — it does exactly what the name says, and
the presets are one click away.

`is_default` exists solely so the UI can say *"this is the rule we started you with"* and so
the restore action can find it after deletion. It grants no behavioural privilege. Treating
defaults as ordinary, fully-editable rules is what prevents the Zapier-class failure where the
platform silently reconfigures a workspace months later.

**Schema**

```ts
// F134 — a default rule is an ordinary rule. is_default grants no privilege.
export type SeedAction =
  | { kind: 'create_default_rule'; connectionid: string; destination_id: string }
  | { kind: 'restore_default';    rule_id: string; as_name: string };  // creates a NEW rule

// A default rule is created inside workspace creation, in the same db.batch()
// (F09) as the workspace row — so a workspace with no default rule cannot exist.
export type WorkspaceCreationBatch = {
  statements: readonly D1PreparedStatement[];
  // 1 INSERT workspace
  // 2 INSERT connection
  // 3 INSERT routing_rule (is_default = 1)
  // 4 INSERT routing_rule_event_types
  // 5 INSERT routing_rule_destinations
};
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Workspace creation transaction fails halfway | No default rule and no workspace; one `batch()` (F09) |
| Default rule's destination was deleted | Rule is flagged `destination_revoked`, delivery fails closed, no silent re-targeting |
| Preset applied over custom rules | Refused unless the user accepts the previewed diff |
| Default rule deleted | Tombstoned; no replacement created |

**Security** — The default rule's destination must be resolved server-side from the workspace's
first verified connection; the client cannot seed a rule pointing at an arbitrary destination.
Seeding runs inside the same authorization context as workspace creation.

**Tests**
- `workspace_creation_seeds_exactly_one_default_rule`
- `default_rule_is_ordinary_and_fully_editable`
- `deleting_a_default_rule_creates_no_replacement`
- `restoring_a_default_creates_a_new_rule_rather_than_overwriting`
- `presets_apply_as_a_previewed_diff`
- `default_rule_respects_the_critical_event_lock`

**Deps** — F09, F148, F154, F163.

---

## F135 — Rule templates

**Priority** P2 · **Status** not started

**Story** As a user setting up a second repository, I want to copy the rules I already trust,
so that I do not rebuild them from scratch and get them subtly different.

**Acceptance**
- [ ] A template is a named, parameterised rule skeleton with **declared parameters**
      (`repository`, `branch`, `destination`, `label`, `event_type`). Parameters are typed and
      bound from a closed picker, never typed as free text.
- [ ] Instantiating a template creates **ordinary rules** (F121) with literal values baked in.
      There is no runtime template entity, so a template cannot change the behaviour of rules
      that were created from it. This is the same additivity principle as F155's presets.
- [ ] Templates are **workspace-owned and versioned**; editing a template is a new version.
      Existing instantiations are untouched.
- [ ] A template ships with a **recommended destination** that must be re-chosen if it belongs
      to a different workspace. Cross-workspace template sharing is out of V1 scope.
- [ ] Templates **cannot contain credentials, URLs, or free text outside their declared
      parameters**. A template containing a literal string that is not a declared parameter is a
      validation failure at save time.
- [ ] The V1 library is small and reviewed: *CI failures only*, *PRs needing review*,
      *Release notifications*, *Bot-free human activity*. Anything not on the list is a user
      copy, not a template.

**Design** — Templates are the escape valve that makes the no-expression-language constraint
bearable. Without them, a user who needs "the same thing but for another repository" has no
path. With them, the shared thing is a **literal, inspectable rule**, so there is still no
computation anywhere in the evaluation path.

They are deliberately *not* a marketplace and *not* a cross-workspace library: both would need
a trust model and a moderation story that V1 cannot honestly provide. Four reviewed templates
cover the documented ground; copying a rule covers everything else.

**Trade-off** — templates are a second thing to learn next to rules and presets. Justified by
the copy alternative being the real alternative users already reach for, and by the fact that
a copied rule is always understandable because it is a literal rule.

**Schema**

```ts
// F135 — a template is a parameterised skeleton. It is never a runtime entity:
// instantiating it produces ordinary literal rules (F121).
export type TemplateParameter =
  | { name: 'repository';  kind: 'picker'; source: 'connection_repositories' }
  | { name: 'branch';      kind: 'picker'; source: 'recent_branches' }
  | { name: 'destination'; kind: 'picker'; source: 'workspace_destinations' }
  | { name: 'label';       kind: 'picker'; source: 'observed_labels' }
  | { name: 'event_type';  kind: 'picker'; source: 'catalog' };

export type RuleTemplate = {
  id: string; orgid: string; name: string;
  version: number;                                   // edits create versions; instantiations are unaffected
  skeleton: RoutingRule;                             // with ParameterRef values
  parameters: readonly TemplateParameter[];
  human_description: string;
};

// A literal in the skeleton that is not a declared parameter is a validation
// failure at save time — this is what stops a template carrying a URL or a secret.
export type ParameterRef = { $param: string };
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Template contains an undeclared literal | `400` at save |
| Template references a destination in another workspace | Parameterised out; instantiation requires an explicit destination |
| Template version referenced by a saved draft no longer exists | The draft keeps its own copy of the instantiated rule |

**Security** — A template is configuration, not code. The declaration that templates cannot
contain URLs or credentials is enforced by the same validator as the rule schema, so a
template cannot become a way to persist an SSRF payload (F96) or a secret.

**Tests**
- `template_instantiation_creates_ordinary_literal_rules`
- `editing_a_template_does_not_change_existing_instantiations`
- `template_rejects_undeclared_literals_urls_and_credentials`
- `template_parameters_are_bound_from_closed_pickers`
- `shipped_template_library_is_the_reviewed_set`

**Deps** — F121, F155.

---

## F136 — Filter evaluator, compiled predicates and the evaluation budget

**Priority** P0 · **Status** not started · **The reason rules are evaluated in the consumer**

**Story** As an operator, I want rule evaluation to cost a bounded amount of work per event, so
that adding rules does not degrade delivery for everyone on the platform.

**Acceptance**

```ts
type EvaluationTrace = {
  candidate_rule_ids: string[];
  matched_rule_ids: string[];
  evaluated: { rule_id: string; result: true | false | 'not_evaluated';
               decided_by?: string; unknown_fields: string[] }[];
  mode: 'first_match' | 'fan_out';
  destination_ids: string[];
  outcome: 'matched' | 'suppressed' | 'unknown_only';
  reason?: string;                 // stable slug, never free text
};

function evaluate(
  rules: CompiledRuleSet,
  envelope: CloudEvent,
): EvaluationTrace;                // pure; no I/O; no D1 access
```

- [ ] ⭐ **Evaluation is a pure function.** It performs **no D1 reads, no `fetch`, no clock
      read** (time is passed in). Every input it needs — rules, destinations, capabilities — is
      resolved **before** the call. This is what makes it unit-testable and what makes the dry
      run (F139) trustworthy.
- [ ] ⭐ **The evaluation point is the `noti-deliver` consumer**, not ingress. Ingress must
      acknowledge GitHub inside **10 seconds** (F64) and must never queue behind a destination;
      adding rule evaluation there couples the two (F07). Evaluation is CPU-only, so it costs
      nothing against the 30 s Paid CPU budget (F189/F192).
- [ ] Rules are fetched **once per consumer invocation**, for the orgs present in the batch, in
      a single `db.batch()`, and compiled to predicates cached by `config_hash` in module scope.
- [ ] ⭐ Cache invalidation is by `config_hash`: a rule write bumps the hash and publishes an
      invalidation onto a control queue consumed by the delivery consumer. Worst-case staleness
      is bounded by a **60-second TTL on the cache entry** so a missed invalidation message
      cannot leave a workspace routing to deleted destinations indefinitely.
- [ ] Budget, stated as a budget and verified by a staging drill — **no claim is made about
      measured latency until one is measured** (`AGENTS.md`):
      - Candidate set after event-type pre-filter: **≤ 32 rules**.
      - Conditions evaluated per event: **≤ 64** (8 conditions × 6 groups × rule cap, pre-filtered).
      - Compiled predicate evaluation: target **< 5 ms CPU**, asserted as a microbenchmark
        ceiling in CI, not as a production figure.
      - D1 round trips per consumer invocation: **≤ 3** (rule fetch, destination fetch, claim).
      - Exceeding 32 candidates is a **metric and a UI warning**, not a silent truncation: the
        evaluator evaluates all of them and we report that the workspace is over budget.
- [ ] A `db.batch()` in the consumer stays under **100 bound parameters per statement**; rule and
      destination fetches are chunked (F09).
- [ ] The compiled form is a **closure tree over primitive comparisons** — no interpreter, no
      `eval`, no `new Function`, no deserialized function source. Compilation produces data.
- [ ] Rule compilation failures (a corrupt stored config) are contained: the rule is skipped,
      `rule_compile_failed` is recorded with the rule id, and the evaluator continues with the
      remaining rules. One broken rule must not stop a workspace's notifications.

**Design** — D1 processes *"queries one at a time"*
([d1/platform/limits](https://developers.cloudflare.com/d1/platform/limits/), read 2026-10-13),
and a D1 database is backed by a single Durable Object, so scaling queue consumers does not
scale writes — it produces `D1 DB is overloaded.` errors, for which Cloudflare's own recommended
action is to *"send fewer requests by spreading the load over time"* rather than to retry
([d1/observability/debug-d1](https://developers.cloudflare.com/d1/observability/debug-d1/), read
2026-10-13). Evaluating rules at ingress would mean an N-rules × M-destinations read fan-out on
the single writer, inside a 10-second ack deadline. That is the wrong shape on every axis.

Evaluating in the consumer inverts the cost: the rule set is read **once per batch**, not once
per event, and the evaluation itself is pure CPU with no I/O. It also puts evaluation at exactly
the point where the delivery row is created, which is what makes `rule_id` provenance a
by-product rather than a second lookup (F137).

Compilation to closures rather than to an interpreted predicate tree is the same reasoning as
F167 applied one level down: a compiled closure over primitives cannot be subverted by a stored
configuration string, because the configuration string is data that was parsed by a schema
before it reached the compiler.

**⚠️ The 60-second staleness bound is a design choice, not a platform fact.** It trades
configuration propagation speed against the cost of a missed invalidation. Revisit if
invalidation message loss proves common in staging.

**Schema**

```ts
// F136 — the evaluator's entire interface. Note the absence of D1, fetch and Date:
// purity is what makes the dry run (F139) trustworthy.
export type CompiledRuleSet = {
  orgid: string;
  config_hash: BLOB;                // SHA-256 over every member's config_json
  rules: readonly CompiledRule[];   // pre-filtered and ordered by (priority, id)
  destinations: ReadonlyMap<string, DestinationRefResolved>;  // capabilities resolved
  compiled_at: number;
};

export type CompiledRule = {
  id: string; version: number; priority: number;
  event_type_ids: ReadonlySet<string>;
  predicate: (envelope: CloudEvent) => Truth;
  destination_ids: readonly string[];
  format: FormatLevel;
  mode: MatchMode;
};

// Module-scope cache in the delivery consumer, keyed by config_hash, TTL 60 s
// (F137 requires the delivery to carry rule_id; this bound is what stops a
// missed invalidation from routing to deleted destinations indefinitely).
export const RULE_CACHE_TTL_MS = 60_000;
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Rule config fails to compile | Rule skipped, `rule_compile_failed` recorded with the rule id, other rules evaluate |
| D1 overloaded during the rule fetch | Retry with backoff + jitter **and** emit the metric (F09); if the fetch ultimately fails, `msg.retry()` — the consumer does not evaluate against a stale-empty rule set |
| Candidate set exceeds 32 | All are evaluated; `rule_budget_exceeded` metric and a persistent UI warning |
| Invalidation message lost | Cache entry expires after 60 s |
| Destination no longer exists | Delivery fails closed with `destination_revoked`; never re-targeted |

**Security** — The compiled predicate is the only thing that touches envelope data, and it only
ever reads registry-declared paths. Tenant scope is resolved before the evaluator is called, so
the evaluator cannot widen it. A corrupted `config_json` cannot become executable code because
the compiler's input is a validated data structure, not source text — the assertion
`no_eval_or_new_function_in_the_rule_path` is a lint rule, not a convention.

**Tests**
- `evaluation_is_pure_and_performs_no_io`
- `evaluation_is_deterministic_for_a_given_rule_set_and_envelope`
- `rules_are_fetched_once_per_consumer_invocation_not_once_per_event`
- `compiled_predicates_are_cached_by_config_hash`
- `stale_cache_entry_expires_within_sixty_seconds`
- `a_corrupt_rule_config_is_skipped_without_stopping_the_workspace`
- `candidate_set_over_budget_is_measured_and_reported_not_truncated`
- `no_eval_or_new_function_in_the_rule_path` (lint)

**Deps** — F07, F09, F64, F125, F192.

---

## F137 — Delivery provenance: `rule_id` and the evaluation trace

**Priority** P0 · **Status** not started · **The data half of F149**

**Story** As a user who got a notification I did not expect, I want the delivery record to name
the rule that produced it, so that I can fix the cause instead of muting the symptom.

**Acceptance** — F149 specifies the surface; this specifies the **record**. They are one feature
split across two specs so neither has to be half-built.

- [ ] `deliveries.rule_id` and `deliveries.rule_version` are written in the **same**
      `db.batch()` that creates the delivery row (F09, F169). A delivery without a rule id is
      only possible for `state='replayed'`, which records `replayed_from` instead.
- [ ] `deliveries.evaluation_trace` stores the `EvaluationTrace` as JSON, **capped at 4 KB**.
      When the cap is exceeded the `evaluated` array is elided oldest-first and
      `trace_truncated: true` is set. Truncation is visible, never silent.
- [ ] ⭐ Suppressed events are recorded too, with the rule that would otherwise have applied and
      the reason it did not: `suppressed`, `would_match_rule_id`, `reason` (`no_rule_matched` |
      `field_unknown` | `catalog_drift` | `critical_lock`). This is the data behind F149's
      *"suppressed because X"* and behind F164's reason breakdown.
- [ ] `rule_id` is resolved to a name **at read time**, not cached in the row. A renamed rule
      shows its new name in history; a deleted rule shows the tombstoned name with a
      *"rule deleted"* badge.
- [ ] The trace survives retention: `deliveries` outlives `routing_rules` rows in every purge
      path (F51), so a 90-day-old delivery can still name the rule version that produced it.
- [ ] The trace is included in the **dead-letter detail view** (F181) and the **support evidence
      bundle** (F202), redacted per F12/F195.
- [ ] Nothing in the trace is user-controlled free text except rule and destination **names**,
      which are length-capped and escaped (F94).

**Schema**

```sql
-- F137 (additive migration; F184 owns the rest of the ledger)
ALTER TABLE deliveries ADD COLUMN rule_id TEXT REFERENCES routing_rules(id);
ALTER TABLE deliveries ADD COLUMN rule_version INTEGER;
ALTER TABLE deliveries ADD COLUMN evaluation_trace TEXT;      -- JSON, ≤4 KB
ALTER TABLE deliveries ADD COLUMN suppression_reason TEXT;    -- stable slug

CREATE INDEX ix_deliveries_rule ON deliveries(orgid, rule_id, created_at);
CREATE INDEX ix_events_suppression ON events(orgid, suppression_reason, received_at);
```

**Design** — Recording provenance in the creating batch rather than resolving it later is not
an optimisation. The delivery row is committed inside a real transaction with the event row
(F169); adding the rule id there makes "which rule sent this" a structural property of the
record rather than a reconstruction that can disagree with what actually happened.

Storing the trace rather than just the rule id is what makes the difference between *"your
filter matched"* and *"your filter matched on `outcome = failure`, and `actor.isBot` was
unknown, which is why the bot rule did not exclude it"*. The 4 KB cap is deliberate: the trace
must fit in the queue-safe size envelope and must not become a place where event content
accumulates. Eliding oldest-first keeps the deciding condition, which is recorded first because
of short-circuit ordering (F132).

**Errors**

| Condition | Behaviour |
| --- | --- |
| Trace exceeds 4 KB | Elided with `trace_truncated: true`, count preserved |
| Rule deleted after delivery | Delivery still resolves the rule by id; UI shows a deleted badge |
| Delivery has no rule (replay) | `replayed_from` populated, `rule_id` null, UI says *"replayed notification"* |
| Stored rule config no longer compiles | Trace is still readable; it is data, not code |

**Security** — The trace contains **field names and verdict booleans, not values**. It does
not record the compared literals or the event's payload, so it cannot leak repository content
into a support export. Rule names are user text and pass F94 escaping.

**Tests**
- `every_delivery_records_the_rule_that_produced_it`
- `rule_id_is_written_in_the_same_batch_as_the_delivery_row`
- `suppressed_events_record_the_reason_and_the_candidate_rule`
- `evaluation_trace_is_capped_and_truncation_is_visible`
- `a_deleted_rule_still_resolves_in_delivery_history`
- `trace_contains_no_field_values_or_event_payload`

**Deps** — F09, F94, F149, F164, F181, F184, F195, F202, F214.

---

## F138 — Actor, bot and ghost filter capability

**Priority** P1 · **Status** not started · **Implements F43's promise**

**Story** As a user, I want "not from bots" and "not from deleted accounts" as separate, honest
choices, so that machine noise goes to one channel and human activity goes to another.

**Acceptance**
- [ ] `data.actor.isBot` and `data.actor.isGhost` are **two separate fields** with separate
      controls. The UI never merges them into "automated".
- [ ] `eq` / `neq` only. No `in` — a three-valued boolean does not benefit from a list, and the
      UI offers three labelled options instead: *Anyone* (no condition), *Humans only*
      (`neq true` on both), *Bots only* (`eq true` on `isBot`).
- [ ] ⭐ **Both fields are nullable and the null case is a first-class option.**
      *Don't know* is offered as its own choice — *"From a bot: Don't know"*, meaning
      `isBot eq null` — precisely so a user on a provider that does not report bot status can
      still express "only tell me when nobody said".
- [ ] `isGhost: true` is **never** treated as `isBot`. A ghost is GitHub's placeholder for an
      unresolved actor, not an automation; F151 forbids suppressing ghosts and this filter
      cannot be used to do so indirectly.
- [ ] `ghost` must not be suppressible: a rule whose only condition is `isGhost eq true` is
      rejected at write time with the F151 explanation. Ghost events are visible, not routable to
      a mute channel.
- [ ] `actor.login` is a separate string field (F125) with `contains` available for
      "anything by octocat"; the login and the bot flag are never conflated.
- [ ] A rule combining `actor.isBot eq false` with `actor.login eq 'dependabot'` is legal and
      the UI states that the second condition is redundant rather than hiding it.

**Design** — The nullable boolean is the whole difficulty. A two-valued `is_bot` field would
make `neq true` mean "definitely a human", which is exactly the lie F43 forbids when a provider
does not populate it. Carrying `null` through the filter engine as a third state (F124) is what
makes *Don't know* expressible, and *Don't know* is a real condition that customers on Slack and
Teams-derived sources will need.

Splitting `isBot` from `isGhost` is a safety property, not a UX nicety. GitHub documents the
`ghost` placeholder user and warns: *"Don't assume sender always identifies the person who
caused an event."* A single "automated" toggle would let a user build a rule that silently
drops every event whose author deleted their account — which, in a CI context, is how you miss
the one notification that mattered.

**Schema**

```ts
// F138 — three UI choices, three conditions. 'dont_know' is a first-class option
// because F43 requires providers without bot data to report null, never false.
export type BotChoice = 'anyone' | 'humans_only' | 'bots_only' | 'dont_know';

export type BotSpec = {
  path: 'data.actor.isBot';
  type: 'boolean';                  // nullable
  nullable: true;
  cardinality: 'single';
  operators: ['eq', 'neq'] as const;   // `in` is deliberately not offered
  label: 'From a bot';
};

export type GhostSpec = {
  path: 'data.actor.isGhost';
  type: 'boolean';
  nullable: true;
  cardinality: 'single';
  operators: ['eq', 'neq'] as const;
  label: 'From a deleted user';
};

export function botChoiceToConditions(c: BotChoice): Condition[];
//   anyone       -> []
//   humans_only  -> [{field:'data.actor.isBot',    op:'neq', value:true},
//                    {field:'data.actor.isGhost',  op:'neq', value:true}]
//   bots_only    -> [{field:'data.actor.isBot',    op:'eq',  value:true}]
//   dont_know    -> [{field:'data.actor.isBot',    op:'eq',  value:null}]
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Provider does not report bot status | `isBot: null` (F43); `neq true` yields `unknown`, not a match |
| `isBot eq null` selected | Matches only events where the provider explicitly reported nothing |
| Rule's only condition suppresses ghosts | `400` at write time, naming F151 |
| Actor missing entirely | `unknown`; trace records `unknown_fields: ['data.actor.isBot']` |

**Security** — `actor.login` is untrusted user content: length-capped, escaped per destination
(F94), and never used as a storage key, a path, or a metric dimension without hashing (F196).
Actor identity is **never** used for authorization — the installation is (F57).

**Tests**
- `bot_and_ghost_are_separate_fields_with_separate_controls`
- `is_bot_neq_true_is_unknown_when_the_provider_reports_null`
- `is_bot_eq_null_is_expressible_as_its_own_choice`
- `ghost_is_never_treated_as_a_bot`
- `a_rule_that_only_suppresses_ghosts_is_rejected`
- `actor_login_is_never_used_as_an_authorization_input`

**Deps** — F43, F60, F124, F151.

---

## F139 — Safe rule change: impact preview, simulate, versioning, rollback, test-before-enable

**Priority** P1 · **Status** not started · **Deliberately one feature, four facets**

**Story** As a user about to change a working rule, I want to see what the change would have
done to my recent notifications before it does it, so that tightening a filter never silently
stops an alert I depend on.

**Acceptance**

**Impact preview (dry run)**
- [ ] A preview evaluates the **candidate** rule set against **real stored envelopes** from the
      last N days, writes nothing, sends nothing, and returns a diff: *"over the last 7 days:
      this change would have added 41 notifications to `#alerts` and removed 12 from
      `#ci-failures`."*
- [ ] Default N = 7 days, selectable 1 / 7 / 30. Capped at **1,000 envelopes per preview** so the
      job fits the **30 s cron CPU budget** (F192). Larger previews are an asynchronous job with
      a progress marker, not a request that times out.
- [ ] The preview covers all three outcomes: newly matched, newly unmatched, and
      matched-but-changed-destination. Reporting only the first two would understate the blast
      radius.
- [ ] ⭐ The preview is marked **"based on the last N events"** everywhere it appears. It is an
      estimate over stored history, not a promise about the future, and the copy says so.

**Simulate mode**
- [ ] Simulate is preview plus **one** explicitly requested test delivery: *"Send me this example
      now."* It uses the real renderer and the real destination, is recorded in the ledger with
      `test = 1`, is **always** accepted regardless of rule state, and is **never** subject to
      filtering — including the critical-event lock, because it is not an event.
- [ ] A test delivery is visually marked in the destination (F93) and is excluded from every
      volume count and billing meter — F253 makes the billable unit *one delivered message*, and a
      test delivery is explicitly not one. (⚠️ `11-grouping-and-noise.md` cites this feature as
      **F233**; `15-security-and-compliance.md` uses F233 for *tenant isolation*, so **F253** is
      the current billing-meter feature. That numbering collision is unresolved and should be
      fixed at the next reindex.)

**Versioning and rollback**
- [ ] Every change is a new version (F122). **Rollback restores a previous version as a new
      version** — it never deletes history, so the rollback itself is auditable and reversible.
- [ ] The UI shows the version list with actor and timestamp, and offers "restore this version".
- [ ] Rolling back a rule that has since been deleted by someone else requires the capability in
      F204.

**Test-before-enable**
- [ ] A new or materially changed rule can be created `disabled`. Enabling requires the
      impact preview to have been run against that exact `config_hash`; otherwise the enable
      action offers the preview first.
- [ ] ⭐ **Critical-event rules are exempt from the preview gate** — they are how failures reach
      a human in the first place, and blocking their activation on a historical estimate would
      make the product worse exactly when it matters.
- [ ] The preview-to-enable binding is by `config_hash`, so editing a rule invalidates the
      previous preview. This is the property that stops "I previewed the old version".

**Schema**

```ts
// F139
export type ImpactPreview = {
  correlation_preview: true;          // never persisted as a delivery
  config_hash: BLOB;                  // what the preview was run against
  window_days: 1 | 7 | 30;
  sampled: number;                    // <= 1000; larger becomes an async job
  newly_matched: number;
  newly_unmatched: number;
  rerouted: number;                   // matched before, different destination now
  per_destination: readonly { destination_id: string; added: number; removed: number }[];
  estimate_notice: string;            // rendered verbatim in the UI
};

export type SimulationDelivery = {
  test: 1;                            // recorded in the ledger, excluded from volume + billing
  bypasses_filters: true;             // including the critical-event lock — it is not an event
  marked_in_message: true;            // F93
};

export type Rollback = {
  from_version: number; to_version: number;
  creates_version: number;            // rollback itself is a new, auditable version
  never_deletes_history: true;
};
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Preview exceeds 1,000 envelopes | Runs as an async job with a progress marker and a resumable cursor |
| No stored envelopes in the window | *"No events in the last 7 days — nothing to preview against"*, enable proceeds |
| Preview not run for this `config_hash` | Enable offers the preview; the two are linked by hash |
| Critical rule | Preview gate does not apply; the exemption is recorded on the audit event |
| Rollback target deleted concurrently | `409` with a re-read prompt; never a silent overwrite |

**Design** — These four facets are one feature because they answer one question: *what happens
to my notifications if I make this change?* Preview answers it before the change, versioning and
rollback make it reversible after, and test-before-enable makes it knowable before the rule ever
runs. A product with only one of the four leaves a non-technical user changing a working rule on
faith.

The preview is honest about being a **historical estimate** and says so in the copy, because a
user who reads "this will add 41 notifications" as a promise about the future will be misled the
first time the future differs. It covers three outcomes rather than two because the third —
matched before, different destination now — is the one that silently doubles volume during a
migration.

Binding the preview to `config_hash` is the property that makes it useful. A preview of version 3
is worthless after an edit to version 4, and the usual failure is exactly that: the user previews,
navigates away, edits something else, comes back and enables. Keying on the hash makes that
impossible rather than merely discouraged.

Rollback creates a new version instead of rewinding, for the same reason audit does: an operator
who rolls back the wrong version should be able to undo the rollback. A destructive rewind cannot
offer that.

The critical-event exemption from the preview gate is the one place the rule is loosened, and it
is loosened on purpose. Critical rules are the path by which a failure reaches a human; gating
their activation on an estimate computed from history would make the product worse precisely when
it matters most.

**Security** — The dry run is a **pure function over stored data** (F136): it opens no
destination, performs no fetch, and writes no delivery row. Making that structural rather than
conventional is what allows "preview" to be offered without a scary-sounding confirmation
dialog. Replay and rollback both require an explicit capability (F204) and are audited.

**Tests**
- `preview_writes_nothing_and_sends_nothing`
- `preview_reports_added_removed_and_redirected_destinations`
- `preview_is_bounded_and_escalates_to_an_async_job_above_the_cap`
- `preview_is_bound_to_the_config_hash_it_was_run_against`
- `rollback_restores_a_previous_version_as_a_new_version`
- `critical_rules_are_exempt_from_the_preview_gate`
- `simulate_delivery_is_marked_and_excluded_from_volume_counters`

**Deps** — F93, F122, F136, F148, F182, F192, F204, F215, F253.

---

## F140 — Event picker and the rule authoring contract

**Priority** P0 · **Status** not started · **Blocks** by F42

**Story** As a non-technical user, I want the rule builder to read as a sentence I can check,
so that I can tell what I am about to build without reading documentation.

**Acceptance** — the builder is **"Tell me about → only when → send to → otherwise"**, the
structure the competitive set ranks as the actual wedge against Zapier/n8n for a non-technical
audience (`COMPETITIVE-FEATURE-SET.md` §6, idea 14, value 5 / cost 3).

| Step | Renders from | Never exposes |
| --- | --- | --- |
| **Tell me about** | `event_types[]` via the catalog picker (F131) | type strings, provider payload paths |
| **Only when** | `condition_groups[]` via the registry (F125) | field paths, operator names, JSON |
| **Send to** | `destinations[]` + `format` (F133) | webhook URLs, credential fields |
| **Otherwise** | the precedence statement + first-match/fan-out (F132) | priority numbers, `rule.id` |

- [ ] The whole rule renders as **one sentence** at all times, and the sentence is the primary
      control: editing any clause edits the underlying structure. There is no JSON editor in V1.
- [ ] Every clause is individually understandable in isolation, so the *Otherwise* step can say
      *"Otherwise, send to `#team-alerts`"* rather than *"No rule matched"*.
- [ ] Event types come from the **closed catalog** and are grouped by category, each with its
      default outcome shown (F131). A non-technical user never sees
      `io.lumi.noti.github.pull_request.opened`.
- [ ] Conditions render as labelled dropdowns populated from the registry, with each field's
      allowed operators, its nullability, and a one-line help text. Invalid combinations are
      impossible to construct because the widget only offers valid ones.
- [ ] ⭐ **Advanced configuration is collapsed by default** and clearly labelled as such. A user
      who has never needed it never sees it; a user who needs it can reach it without leaving the
      sentence (it reveals raw field labels, not JSON).
- [ ] The picker shows, for each event type, the **last-seen** timestamp from observed events,
      so a user can tell "you selected an event your integration has never received" from "this
      is a new event type GitHub just added".
- [ ] Every step is keyboard-navigable with visible focus, and the whole builder reflows to
      **320 px** without horizontal scrolling, per `DESIGN.md` §16 and the `AGENTS.md` design
      contract.
- [ ] Visual language follows `DESIGN.md` exactly: Paper White canvas, Civic Navy headings,
      Geist, Tabler Outline icons, the canonical spacing scale, and **no invented metrics or
      fake acceptance evidence** — a type with no observed events says so.
- [ ] The builder never displays a destination webhook URL. It shows a masked target name and,
      for Lark custom bots where pasting a URL is unavoidable (F101), a screenshot-annotated
      paste flow that never echoes the stored value.
- [ ] Strings follow `DESIGN.md` §14: short sentences, specific nouns, visible ownership. The
      word "unlock", "supercharge" and "seamlessly" do not appear in this surface.

**Design** — The sentence is the product decision, not a rendering convenience. Every serious
competitor makes the user assemble this structure from parts: Sentry's When/If/Then builder,
incident.io's attribute normalisation and expression editing, Alertmanager's YAML tree with an
optional visual editor. Those are tools for people who already know what they want to express.
For the audience in `docs/PRODUCT.md`, the sentence is what makes the whole configuration
system reachable without documentation, and it is also what makes F167's constraint invisible:
the user is never offered a language, so they never need one.

**Relationship to the sibling UI features** — this is the **authoring** surface, not the
onboarding one. F210 is the setup-wizard step and is deliberately preset-led: it leads with
radio buttons (*"Only things that failed — recommended to start"*) and keeps raw event-type
selection collapsed and read-only. This feature is what the user arrives at afterwards, once a
workspace exists and they want something the presets do not cover. Both collapse advanced
controls by default; neither shows a field path. F215 renders the simulation delivery (F139);
F221 owns accessibility conformance for the whole surface.

Showing `last-seen` on each event type is the honesty mechanism for the picker. GitHub states
that it *"continues to add new event types and new actions to existing event types"* (F42), so
the catalog will always be behind reality. A user who selects an event type their installation
has never produced should be able to see that before enabling the rule, not three weeks later.

**Schema**

```ts
// F140 — the sentence is a projection of the rule, never a second source of truth.
// render() is total over RoutingRule; every branch is covered by a test.
export type RuleSentence = {
  about:   string[];                  // "when a pull request is opened or closed"
  when:    string[];                  // ["all of these are true", …]   — group order is display order
  sendTo:  string[];                  // "send to #alerts as a card"
  otherwise: string;                  // "otherwise nothing is sent" — never "no rule matched"
  plain:   string;                    // the single-line rendering used in F149's "via <rule>" label
};

export function render(rule: RoutingRule, catalog: Catalog, dest: DestinationNames): RuleSentence;

// The builder sends the structured rule; the server re-renders the sentence.
// The client never sends a sentence, and a sentence is never parsed back.
export type RuleSaveRequest = { rule: RoutingRule };

// Availability is derived from the catalog, not from client state.
export type EventTypeOption = {
  id: EventTypeId;
  label: string;
  category: string;
  default_outcome: 'success' | 'failure' | 'neutral';
  last_seen_at: number | null;        // null → "not seen on this connection yet"
  mapped: boolean;                    // false → "we haven't classified this yet" (F42)
};
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Event type has no observed events | Labeled *"not seen on this connection yet"*; not hidden, not blocked |
| Field not available for the selected event type | Control disabled with *"not available for this event type"*, not removed — its absence would look like an oversight |
| Destination unreachable | Rule saves; destination shows its own health state (F98). Blocking rule creation on a destination outage would couple two unrelated failures. |
| Sentence cannot be rendered for a valid rule | Server error; a test asserts every valid rule renders to a sentence |

**Security** — The builder is a **server-validated** surface: the client renders a sentence for
affordance, but every save goes through the same schema as the API (F121) and the same
authorization (F24). Client-side rendering is never the control. Destination URLs and
credentials are never sent to the browser, in any mode.

**Tests**
- `every_valid_rule_renders_to_a_sentence`
- `sentence_matches_the_stored_structure` (round-trip)
- `event_picker_shows_the_closed_catalog_grouped_by_category`
- `event_type_without_observed_events_is_labelled_not_hidden`
- `unavailable_field_is_disabled_with_a_reason_not_removed`
- `builder_is_keyboard_navigable_and_reflows_to_320px`
- `no_webhook_url_is_ever_sent_to_the_browser`
- `builder_does_not_render_json_or_field_paths_by_default`

**Deps** — F24, F42, F92, F98, F121, F125, F131, F132, F133, F210, F215, F221. **Fixes** part of D12, D16.