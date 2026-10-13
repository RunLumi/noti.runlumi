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

4. **Three-valued facts that fail closed (F124).** A fact GitHub did not send is `null`, never
   `false`/`""`/`[]`. **Any configured filter that applies to the event and cannot judge it
   holds the event back** as `unknown_fact`, whether it is an `allow` list, a `deny` list,
   `bots: exclude`, `draft` or a `labels` list. Treating "unknown" as "so send it" would turn a
   privacy rule into a rule that fails exactly when the data is odd. The one exception is a
   deleted account (decision 5). The decision carries `unknown_fact`, so an unknown is never
   silent, and the dashboard says that a missing detail holds an update back. A filter that does
   not apply to an event type (a branch filter on an issue) is skipped, not treated as unknown;
   decision 10 stops that from being a silent hole.

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

7. **Provenance in `routing_decisions` (F137).** One row per integration *with filters*
   considered (enabled, same tenant and repository, subscribed to the event type): `delivered`
   or `filtered`, the `filter_id`, a reason from a closed vocabulary, and `unknown_fact`.
   Integrations without filters write **no** row: the delivery row is their record, and a row
   per unfiltered event would be pure growth. A row holds ids and codes only: **no field values,
   no compared literals, no payload**. Its id is the deterministic delivery id for
   `(dedup key, integration)`, so a provider redelivery cannot duplicate a row. If a filtered
   event is redelivered after the filter was edited and is now sent, the row becomes
   `delivered`; the reverse never happens, and a "filtered" row is not written for an event that
   already has a delivery.

   **Provenance is best effort and outside the delivery transaction.** The delivery and outbox
   rows commit together exactly as before; the decision statements run afterwards in their own
   batch inside a `try/catch` that logs a redacted `routing_provenance_failed` warning (a count,
   nothing else). A failed record therefore never blocks or loses a notification and never turns
   a 202 into a 500. The price: a held-back event whose record failed leaves no trace, and the
   event itself is not stored anywhere, so it cannot be reconstructed. That is a deliberate
   privacy trade, and the warning is the signal.

   Retention is 30 days, drained in up to five bounded rounds of 500 rows per cron tick so the
   backlog cannot outgrow the purge. Deleting an integration deletes its rows in the same batch.
   The table is in `TENANT_TABLES`, so the workspace purge removes it; it carries no foreign key,
   like `deliveries`. A separate table was chosen over a column on `deliveries` because a
   filtered event has no delivery row, and "why did I not get this" is exactly the case that
   needs a record.

   Events delivered before migration 0015 have no decision row, and a redelivery of one after a
   filter now excludes it writes none either (the delivery already exists), so history before
   0015 never shows a false "held back".

   Known edge: if an event was first delivered, then a redelivery arrives after *all* filters
   were removed, a stale `filtered` row from an earlier attempt can remain until retention
   removes it (no row is written for an unfiltered integration to correct it). The delivery
   log is authoritative for what was sent.

8. **Fail closed for an unusable stored document, open only for a newer one.** The stored
   document is re-validated on every read with the API's own parser.
   - **Corrupt or no longer valid** (bad JSON, wrong shape, or a document that violates the
     limits of the running Worker): ingress holds the event back as `filtered` /
     `config` / `config_invalid`. A deny, exclude or bots rule is often a privacy control, and
     an unreadable one must not quietly mean "send everything". The API reports
     `filtersInvalid: true`, the dashboard shows a blocking notice, and the editor requires an
     explicit **Replace invalid filters** action before anything can be saved, so the unreadable
     rules are never overwritten by accident. A `routing_filters_invalid` error line (integration
     id and state only) is logged for alerting.
   - **Written by a newer release** (`v` greater than this Worker's): this is what a rollback
     looks like, and the document is probably fine. Holding back every event of every filtered
     integration until the next deploy would be the larger harm, so it fails open as
     `config_newer`, with the same error log and an API/dashboard note (`filtersNewer`).
   - A canary test asserts that every document `serializeFilters` can produce re-validates
     unchanged, and a simulation tightens the limits to show that a document that no longer fits
     becomes `invalid`. **Any release that tightens a limit or changes a filter's meaning must
     bump `STORED_VERSION` and migrate existing documents**, or those integrations will hold
     back events until their filters are replaced.
   - The trade-off to be aware of: events held back are not stored, so after fixing the filters
     they cannot be replayed from Noti. GitHub's own delivery log can redeliver them within its
     retention window.

9. **API.** `filters` on create and update (replace-all; `null` or `{}` clears), strict
   validation with dotted field paths and messages that never echo values, limits of 32 entries
   per list and 128 in total. Audit metadata lists changed filter **ids** only. `GET
   /api/integrations/:id/routing-log` (keyset cursor) and `POST
   /api/integrations/:id/filters/preview` (a pure dry run over a sample facts object; CSRF
   rules as other mutations; 60 per user per minute). There is no `deliveries` API on this
   branch's base, so the routing log is its own small endpoint.

10. **A filter must be able to read what it checks (H2).** Applicability by event type used to be
    a silent hole: a branch "only" list on `release.published` or an issue simply did not apply.
    Now (a) the extractor reads the ref a release (`target_commitish`) or deployment
    (`deployment.ref`) carries when it looks like a branch name (not a SHA, not `refs/tags/`),
    and the branch filter applies to those events, holding them back as unknown when GitHub
    names no branch; (b) saving an **"only" list** (branch, target branch, labels) together with
    subscribed event types that cannot supply that fact is refused with `422` on
    `filters.coverage` (checked on create and on every update of either side); (c) a **"never"
    rule** on such event types is allowed and the response carries
    `warnings: [{filter, eventTypes}]`; the editor shows per-filter "applies to" copy and the
    same notes before saving.

11. **Dashboard.** A "Filters" section on the integration settings page and an optional
    "Filters" step in the create wizard. The web code imports the server's own parser and
    evaluator (pure TypeScript), so the form accepts exactly what the API accepts and the
    "Try it" check answers exactly as ingress would. People type one entry per line; errors are
    attached to the control and the line, in our own translatable copy. "Try it" never sends
    anything and says so. The settings page also lists recent decisions.

## Consequences

- Existing integrations are unchanged: `filters_json` is `NULL`, nothing is evaluated or
  recorded, and the delivery path is as before.
- Each event now does one extra best-effort batched write covering its filtered integrations. At the current volume that is negligible; at scale it is the first thing
  to measure (spec 11 grouping and F53 coalescing would reduce it).
- A user who sets an `allow` list on a field some events lack (a tag push has no branch) will
  see those events held back with `unknown_fact`. That is the documented, visible behaviour.
- Rolling the Worker back re-enables delivery of events the filters were suppressing; the old
  Worker ignores the column and the table.

## Semantics worth knowing

- **Case:** branch, login and label comparison is case-insensitive and NFC-normalised. That is
  fail-safe for `deny` (a differently-cased name is still denied) and means an `allow` list also
  admits a differently-cased name. Git itself is case-sensitive; a repository with `Main` and
  `main` as different branches cannot be told apart by these filters.
- **`bots: exclude` checks the sender**, the account that caused the event, not a pull
  request's author. A Dependabot pull request that a human merges or comments on is not
  excluded for that event; use a `people` deny entry for the author where it matters.
- Evaluation cost: filters are parsed and compiled once per distinct document per request and
  the facts are folded once per request, however many integrations are evaluated.

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
