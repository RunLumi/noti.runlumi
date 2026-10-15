# ADR 0051: Closed log catalogue, per-line byte budget and the single redaction site

Status: Accepted · Date: 2026-10-15 · Implements the catalogue and line-budget parts of F194 and the console
exit point of F195 (spec 13); records the "no regex in filters" non-goal of F167 (spec 11)

## Context

`log(level, msg, fields)` already redacted every line (spec 01 F11/F12, ADR 0011), but `msg` was a free
string and `fields` any object. Nothing said which events exist, a typo in a name produced a new event
nobody searched for, and a call site could add any key. Four call sites in `src/` (`src/audit/audit.ts`,
two in `src/api/github.ts`, `src/connectors/sources/github/route.ts`) wrote `console.error(JSON.stringify(...))`
directly: no redaction, no correlation id and a different key (`event` instead of `msg`). A line had no
size bound, although Cloudflare records at most 256 KB of logs, exceptions and metadata per invocation and
then nothing more for it ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)).

## Decision

1. **One catalogue module.** `src/platform/log-events.ts` exports `LOG_EVENTS`: every event name, a
   one-line description and the fields its call sites pass. `log()` and `logLine()` are generic over the
   event: an unknown name is a type error, and so is a field the event does not declare, whether written
   literally or arriving through a spread (`Declared<E, F>` maps every extra key of the inferred object to
   `never`). `correlation_id` may be passed for any event, as before. The catalogue holds the 87 literal names
   in use plus the three `alert_<kind>` names the alert log sink builds from a template.
2. **Names unchanged.** No event was renamed; none was a clear typo. Spec 13's dotted names
   (`delivery.attempt`) stay a target shape: a rename breaks saved searches and the runbook, and buys
   nothing the closed union does not already give. The four direct `console.error` sites now call `log()`
   with their existing names (`audit_write_failed`, `github_setup_failed`, `github_callback_failed`,
   `github_lifecycle_failed`); their key changes from `event` to `msg`, like every other line.
3. **Generated documentation.** `docs/LOGS.md` carries a table rendered from the catalogue between
   `GENERATED` markers, the same pattern as `docs/AUTHORIZATION.md`. `tests/docs/logs-doc.test.ts` fails on
   drift; `npm run docs:logs` rewrites it. `tests/platform/log-events.test.ts` requires sorted snake_case
   names, a one-line description, unique fields, no field the redactor denies, and that every entry is
   emitted somewhere in `src/` (no dead entries).
4. **Per-line byte budget, not mid-JSON truncation.** `LOG_LINE_BUDGET_BYTES = 4096` UTF-8 bytes. The
   delivery consumer takes 5 messages a batch (`wrangler.jsonc`) with a few lines each, so a batch stays
   far below 256 KB. An oversized line keeps valid JSON: string values are shortened at 256, then 64, then
   16 characters (`log_truncated: "values"`), then every field except `ts`, `level`, `msg` and the
   correlation keys is dropped (`log_truncated: "fields_dropped"`, `dropped_fields: n`). F194 asks for a
   per-invocation budget with a dropped-line counter; this slice bounds the line, which is the part that
   needs no invocation state. The budget runs after redaction, so it can only shorten scrubbed text.
5. **No cut inside a marker.** The redactor's own truncation could cut `token=[redacted]` to
   `token=[reda`. That exposed nothing (scrubbing runs first) but read like a partial secret. `truncate()` in
   `src/platform/redact.ts` now backs off to before any `[...]` or `…[truncated n chars]` marker and never
   splits a surrogate pair; the log budget uses the same function (`truncateSafely`).
6. **One redaction site, enforced twice.** `logLine()` calls `redact()` exactly once, over the merged line;
   `log()` hands `console` only that result. ESLint `no-console` is an error for `src/**/*.ts` with the one
   exception `src/platform/log.ts`. `tests/security/log-redaction-site.test.ts` checks from the TypeScript
   AST that no other file under `src/` references `console` (aliases and `globalThis.console` included),
   that `log.ts` has one `redact()` call and passes `console` only `line`, that the ESLint config says the
   same, and, with `redact` wrapped by a counter, that each of the catalogued events (every declared field
   set to a planted secret) produces exactly one `redact()` call, emits exactly that output and leaks no
   planted value. If `redact()` cannot produce an object, the line keeps `ts`, `level`, `msg` and says
   `redaction_failed: true` (F195: drop fields, keep the line).
7. **Reserved keys.** A field named `ts`, `level` or `msg` is ignored at run time (and does not type-check),
   so a call site cannot forge the event of a line.
8. **No regex in filters.** `docs/ROADMAP.md` gains a Non-goals section with "No regex in filters", and
   `tests/routing/no-regex.test.ts` pins it: regex-dialect patterns are refused in every branch list, a
   stored document carrying one fails closed, `RegExp` values and `$regex`/`regex` keys are refused,
   regex-looking literals (`^main$`, `main|dev`) do not match as a regex would, and nothing under
   `src/routing/` constructs a `RegExp`.

## Consequences

- A new event costs one catalogue entry and `npm run docs:logs`; review sees the entry.
- One real signal was being lost: `expired_auth_records_purged` spread a report whose `authStates` and
  `authRateLimits` keys contain the denylisted word `auth`, so both counts always logged as `[redacted]`.
  The line now names them `installStates` and `rateLimitRows`. No secret leak was found; the four direct
  `console.error` sites wrote constants plus the `x-github-event` header value (after signature verification), which is now
  redacted and capped at 512 characters like every other field.
- Some `scrubString` outputs (audit metadata, stored diagnostics) are a few characters shorter where a cut
  used to fall inside a marker. No stored row is rewritten.
- Fields are checked by name, not by type: spec 13's typed key set (`attempt: int`) is not built.

## Not done

Per-invocation byte budget and `logs_dropped_budget` counter, `debug` level and sampling, dotted names,
typed field values, `invocation_logs = false` for the consumer (F194); the property test over provider
bodies, the other F195 exit points (D1 detail columns, support bundle, Analytics Engine) and a site-to-test
inventory for them. `^` in a branch pattern is still accepted as a literal; refusing it at write time only
(stored documents would otherwise turn invalid and fail closed) is a possible follow-up.

## Revisit when

- A queue batch grows past about 50 messages or logs more than a few lines per message: add the
  per-invocation budget.
- Another exit point than `console` appears (Analytics Engine, support bundle, an AI provider): add it to
  the F195 inventory with its own one-site test.
