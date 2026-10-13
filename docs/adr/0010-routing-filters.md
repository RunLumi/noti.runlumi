# ADR 0010: Per-integration routing filters with provenance

Status: Accepted · Date: 2026-10-13 · Implements slice 7 in part: F124, F125 (closed set),
F127, F128, F136 (pure registry), F137 (decision record), F138, F139 (dry run), F140 (per-field
controls). Not the full F121 rule model. See "Not done".

## Context

An integration sends every subscribed event for one repository to one destination. The first
complaint a real team has is noise: draft pull requests, bot commits, pushes to scratch
branches. Spec 10 designs a general rule engine (conditions, priorities, fan-out, templates,
versioning). That is a large product surface and most of it depends on a canonical event
envelope (spec 04) that does not exist yet.

The smallest slice that removes the noise and stays honest is a **closed set of filters stored
on each integration**, evaluated by pure functions over a few normalised facts, with a record of
why each event was or was not sent.

## Decisions

1. **A closed filter model, not a rule language.** Five filters, each a typed, versioned
   definition in a registry (`src/routing/filters.ts`) with `appliesTo(eventType)` and a pure
   `evaluate(config, facts) → {pass, reason, unknown}`:

   | Id | Reads | Applies to | Options |
   | --- | --- | --- | --- |
   | `branch` | head branch | push, `pull_request*`, `workflow_run.*` | allow / deny globs |
   | `baseBranch` | PR target branch | `pull_request*` | allow / deny globs |
   | `actor` | login, `isBot`, `isGhost` | every event | allow / deny logins, `bots: any\|exclude\|only` |
   | `draft` | PR `draft` | `pull_request*` | `exclude` |
   | `labels` | label names | issues, issue comments, `pull_request*` | include / exclude |

   A filter compares a fact to a literal. It never computes, so there is no expression
   language, no regex field, no cross-field comparison (spec 10 F167).

   A **conclusion filter** (failure-only workflow runs) was not added. The closed catalog
   already splits `workflow_run` by conclusion (`workflow_run.failure`, `.timed_out`, ...), so
   "failures only" is event selection, which already exists and is the wizard's default.

2. **Stored as a versioned JSON document in `integrations.filters_json`** (`NULL` = none),
   migration `0015`. It is an `ALTER TABLE ... ADD COLUMN`, not a rebuild like 0007/0009/0012:
   a rebuild would drop and recreate the tenant triggers and every index for nothing. A
   `CHECK` admits only valid JSON up to 8 KiB; the API validates deeply and a stored document
   is **re-validated on every read**.

3. **Evaluated at ingress, against minimal facts. This deliberately departs from spec 10's
   "evaluate in the consumer".** The spec's reason is that ingress must not fan out
   `rules x destinations x D1 reads`. Here the filters live on the integration row ingress
   already selects, evaluation is in-memory over at most a few dozen short strings, and it adds
   **no D1 read**. The one extra write is a single batched insert of provenance. Evaluating at
   ingress also means a held-back event never creates a delivery, outbox row or queue message.
   If a future rule engine needs delivery-time evaluation, the registry functions are unchanged
   and can move.

   Facts are a seven-field object (`branch`, `baseBranch`, `actorLogin`, `actorIsBot`,
   `actorIsGhost`, `draft`, `labels`) extracted from the verified payload by
   `extractGithubFacts`. **No payload is stored or passed on.**

4. **Three-valued facts (F124).** A fact GitHub did not send is `null`, never `false`/`""`/`[]`.
   An `allow`/`include`/`bots: only` condition cannot say yes to an unknown fact, so the event
   is held back with reason `field_unknown`. A `deny`/`exclude`/`bots: exclude` condition never
   skips on an unknown fact. Either way the decision carries `unknown_fact`, so an unknown is
   never silent. A filter that does not apply to an event type (a branch filter on an issue)
   is skipped, not treated as unknown.

5. **A deleted account is never skipped (F138, F151).** `actor` passes any event whose sender
   is GitHub's placeholder `ghost`, whatever the bot setting, and the placeholder cannot be put
   in a deny list. Missing a failed build because its author left is worse than one extra
   message. The decision reason is `ghost_exempt`, so the exemption is visible.

6. **Globs without RegExp (F127).** Exactly `*` (within a path segment) and `**` (across `/`),
   `\*` for a literal star. `? [ ] { } +` and a leading `!` are rejected, because accepting
   them silently would make people believe they work. Patterns compile to a token list and match
   by dynamic programming over (tokens x input), both capped (128-character pattern, 255-character
   input, 8 wildcards), so the worst case is bounded and no user string reaches `RegExp`. An
   over-long value is "cannot compare" (unknown), never a truncated match. Matching is
   case-insensitive and NFC-normalised.

7. **Provenance in `routing_decisions` (F137).** One row per integration *considered* (enabled,
   same tenant and repository, subscribed to the event type): `delivered` or `filtered`, the
   `filter_id`, a reason from a closed vocabulary, and `unknown_fact`. It holds ids and codes
   only: **no field values, no compared literals, no payload**. Its id is the deterministic
   delivery id for `(dedup key, integration)`, so a provider redelivery cannot duplicate a row;
   if a filtered event is redelivered after the filter was edited and is now sent, the row
   becomes `delivered`, and the reverse never happens. For a delivered event the row is inserted
   in the same `db.batch()` as the delivery and outbox rows. Retention is 30 days (bounded
   delete per cron tick). The table is in `TENANT_TABLES`, so the workspace purge removes it;
   it carries no foreign key, like `deliveries`.

   A separate table was chosen over a column on `deliveries` because a filtered event has no
   delivery row, and "why did I not get this" is exactly the case that needs a record.

8. **Fail open.** If a stored document does not validate (corruption, a version this Worker
   does not know), ingress delivers and records `config_invalid`; the API reports
   `filtersInvalid` and the dashboard says so. Filters are noise control, not authorization:
   authorization is the verified installation, and hiding events because a config is unreadable
   would be the worse failure.

9. **API.** `filters` on create and update (replace-all; `null` or `{}` clears), strict
   validation with dotted field paths and messages that never echo values, limits of 32 entries
   per list and 128 in total. Audit metadata lists changed filter **ids** only. `GET
   /api/integrations/:id/routing-log` (keyset cursor) and `POST
   /api/integrations/:id/filters/preview` (a pure dry run over a sample facts object; CSRF
   rules as other mutations; 60 per user per minute). There is no `deliveries` API on this
   branch's base, so the routing log is its own small endpoint.

10. **Dashboard.** A "Filters" section on the integration settings page and an optional
    "Filters" step in the create wizard. The web code imports the server's own parser and
    evaluator (pure TypeScript), so the form accepts exactly what the API accepts and the
    "Try it" check answers exactly as ingress would. People type one entry per line; errors are
    attached to the control and the line, in our own translatable copy. "Try it" never sends
    anything and says so. The settings page also lists recent decisions.

## Consequences

- Existing integrations are unchanged: `filters_json` is `NULL`, the decision is
  `no_filters`, and the delivery path is as before.
- Each event now does one extra batched write per filtered integration and one extra statement
  per delivered one. At the current volume that is negligible; at scale it is the first thing
  to measure (spec 11 grouping and F53 coalescing would reduce it).
- A user who sets an `allow` list on a field some events lack (a tag push has no branch) will
  see those events held back with `field_unknown`. That is the documented, visible behaviour.
- Rolling the Worker back re-enables delivery of events the filters were suppressing; the old
  Worker ignores the column and the table.

## Not done

Spec 10 items this slice does **not** implement: the rule object, priority, fan-out and
conflict resolution (F121, F132), `all`/`any` groups (F123), the full field registry and
operators beyond these five filters (F125), repository filter capability (F126), `not_glob`/`in`
operators, path patterns (F129), PR/issue number filters (F130), outcome conditions (F131),
per-destination format overrides (F133), default rules and templates (F134, F135), impact
preview over history, versioning and rollback (F139: only the pure dry run exists), a label
picker populated from observed events (F128), `rule_id`/`rule_version`/evaluation trace on
`deliveries` and the critical-event lock (F137, F148). Filters exist only for GitHub; the
facts extractor is the part a second source would add.

## Verification

Automated, over the real migrations and the real Worker entry point: table-driven filter tests
(including three-valued cases, ghost, applicability, and adversarial globs and 1 MB inputs
under one second); validation and normalisation; fact extraction; ingress end to end (filtered
vs delivered, per-integration fan-out, provenance rows, redelivery idempotency, fail-open,
cross-tenant isolation, no payload content in the table, retention, workspace purge); API
create/update/clear/audit, dry run (pure, CSRF, authz, rate limit) and routing log (pagination,
tenant scoping); migration 0015 preserves rows, indexes and triggers; web model and server-markup
tests.

Not verified: a browser pass of the new screens (reflow at 320 px, keyboard order, contrast,
Vietnamese diacritics), an axe or screen-reader pass, behaviour against real GitHub payloads
beyond the documented fields the fixtures use, and load.
