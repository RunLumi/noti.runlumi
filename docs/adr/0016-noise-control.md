# ADR 0016: Noise control (quiet hours, burst grouping, digests, resolved notices)

Status: Accepted · Date: 2026-10-14 · Implements slice 8 in part: F141, F142, F143, F144, F145,
F146, F152 (simple version), F165 (structural), F166 (partly); touches F148 and F159 (a derived
"critical" rule). Spec 11 is authoritative; "Not done" lists everything this slice leaves out.

## Context

A busy repository sends dozens of updates an hour. Spec 11 argues the largest differentiator in
this category is a non-technical user being able to quiet a chat without reading documentation, and
that every suppression path must end in a digest or a visible held state, never in silence. This
slice builds the P0/P1 core of that, honestly: per-integration settings, a held-event store, a
release job that goes through the existing outbox, and the dashboard to set it up. It does not
build the preset library, personal preferences, silences or any AI.

## Decisions

1. **One JSON document per integration, `integrations.noise_json`** (migration `0021`, `ADD COLUMN`,
   `NULL` = none, `CHECK(json_valid AND length <= 2048)`), versioned like `filters_json`:

   ```
   { v: 1, timezone: <IANA>, quietHours: {start,end}|null, groupWindowSec: 0|60|300|900|3600,
     digest: off|hourly|daily, digestAt: "HH:MM", resolution: boolean }
   ```

   `groupWindowSec` is the four labelled choices of F142 (no `group_wait`/`group_interval`
   vocabulary). Weekly digests, per-repository overrides and presets are not built. The API
   validates strictly and a stored document is **re-validated on every read**.

2. **Unusable stored settings fail OPEN, the opposite of filters.** Routing filters fail closed
   because a deny rule may be a privacy control (ADR 0010). Noise settings only *delay* updates, so
   an unreadable or newer-version document means "deliver normally", logged as
   `noise_settings_unusable` and flagged to the dashboard as `noiseInvalid` / `noiseNewer`.
   Delivering is the direction that cannot lose an alert.

3. **Ingress decides `deliver` or `hold`, never `drop`** (`src/routing/noise.ts`,
   `noise-ingress.ts`). After subscription and routing filters have decided an integration should
   receive an update, a pure function of the settings, the instant and two numbers read from D1
   (how many updates are waiting, and the open group's release time) answers. Precedence:

   | # | Condition | Result |
   | --- | --- | --- |
   | 1 | no holding feature on | deliver |
   | 2 | **critical** | deliver, always, reason `critical_bypass` |
   | 3 | 500 updates already waiting for this integration | deliver, reason `hold_capacity` |
   | 4 | inside quiet hours | hold until quiet hours end (or the next digest boundary after that) |
   | 5 | a digest is on | hold until the next boundary (a boundary inside quiet hours moves to its end) |
   | 6 | a group window is on | join the open group, or open one; the window is extended to the end of quiet hours if it would end inside them |

   **Critical** is derived from the canonical status the source mapped, never from a free-form
   payload field: `status === 'failure'` (a failed or timed-out GitHub workflow run, a generic event
   of severity `error` or `critical`, a failed GitLab pipeline or Stripe payment) or an event type
   beginning `security.` (none is subscribable yet; the rule exists so the first one cannot be held
   by accident). The cap (3) bounds storage and fails toward delivering.

4. **Time-zone arithmetic without a library** (`noise-time.ts`). Everything is derived from
   `Intl.DateTimeFormat`, which Workers ship with full zone data. A wall time that does not exist
   (spring forward) moves forward by the gap (the "compatible" rule of the Temporal proposal). One
   that happens twice (fall back) has two instants and **both count** for "the next 01:30", so a
   quiet window ending at 01:30 ends minutes away from 01:10 in the second pass rather than a day
   later (a review finding, now tested), and a daily time can come round twice on that one day, which
   is harmless because an empty digest is never sent. A scheduled release is never skipped. Half-hour and quarter-hour offsets are handled (the hourly digest
   is on the *local* hour). A zone name must match `UTC` or a `Region/City` shape **and** be
   accepted by the runtime: offsets such as `+05:00` and a lower-case `utc` are refused. The runtime
   itself treats region names case-insensitively, so `asia/ho_chi_minh` is accepted and stored as
   sent (it works; it is just not canonical). The dashboard offers `Intl.supportedValuesOf('timeZone')` where it exists.

5. **`held_events`: bounded, tenant-scoped, display fields only.** One row per held update with the
   same columns the outbox message carries (`title` 300, `url` 1000, `repo`, `actor`, `status`,
   `event_type`, `summary` 280) and `CHECK`s that enforce those bounds; there is no payload column
   (a test asserts the absence and that a payload string never reaches the table). `id` is the
   deterministic delivery id for `(dedup key, integration)`, so:

   - a provider redelivery of a held event is `INSERT OR IGNORE`d;
   - an event that already has a delivery is not held (guard in the insert);
   - an event that is already held is not delivered a second time if the settings are cleared and
     the provider redelivers it (guard added to the three routes' delivery inserts after the
     conservation property test found this double delivery);
   - a lone held update is released under its **own** id, so a redelivery after release cannot send
     it again while the released row (kept 7 days) exists.

   The table carries `organization_id` with no foreign key (like `deliveries`), is in
   `TENANT_TABLES`, is deleted with its integration and with a source cascade, and is purged by a
   bounded 7-day retention job (open failures: 30 days).

6. **Release is a leased, budgeted, atomic cron job** (`src/pipeline/noise-release.ts`, job
   `noise_release`, run **after** `outbox_reconcile`: a released notification is dispatched by the
   next tick, at most a minute later, and a large backlog can never starve the reconcile or the jobs
   after it).

   - *Bounded by D1 calls, not only rows (a review finding):* at most **100 notifications per tick
     across all integrations** (a digest counts as up to 3), decided **before** anything is claimed
     (only that many scopes are claimed), 20 integrations per tick, claims of at most 40 group keys
     per statement (D1 allows 100 bound parameters) and **15 notifications per `DB.batch`**. A tick
     makes about 13 D1 calls however large the backlog; 500 distinct group keys drain over five
     ticks (a test counts the calls and asserts every row is released exactly once across ticks).
   - *Leased:* due rows are claimed (`state='claimed'`, token, 2-minute expiry) with
     `UPDATE ... RETURNING`; an expired claim is returned to `held` at the start of the next run and
     counts as an attempt.
   - *Atomic:* each notification's delivery row, outbox row and the "released" marks of the rows it
     covers are statements of one D1 batch (a batch holds up to 15 notifications over disjoint rows),
     and each delivery insert is guarded on the claim still being ours, so a run that lost its lease
     creates nothing and a held row is never marked released without a delivery. If a batch fails
     none of its notifications was created.
   - *Poison-proof:* every failed batch or abandoned claim counts on the row (`attempts`,
     `last_error_class`) and delays it (`retry_after`: 1 min, 2, 4 ... capped at 1 h). After **5**
     attempts the row becomes `failed`: kept (30 days), counted in the noise status, listed by the
     runbook query, **never released and never silently dropped**. Rows still backing off are not
     due, so 25 poison integrations cannot starve a healthy one (tested).
   - *Paused integrations wait:* rows of a disabled integration, or one with quarantined
     credentials, are not due. Nothing is dead-lettered; they release after it is enabled again (they
     still count towards the 500 cap, so a paused integration falls back to delivering, not holding).
   - *Data minimised:* when a row is released its title, summary, link, actor and repository are
     blanked; only the id (for redelivery dedupe), `hold_reason`, `released_in` (the delivery-log
     join) and the timestamps remain until the 7-day retention removes it.
   - *Idempotent:* a second or concurrent run finds nothing due (tests run overlapping runs).
   - It produces ordinary delivery + outbox rows, so retries, dead-lettering, replay, audit and the
     delivery log all apply unchanged. A digest that would be empty is not rendered at all (F144).

7. **Rendering goes through the existing adapters** (`noise-render.ts`). A released group or digest
   is an ordinary canonical notification: title, repo, status, and a `summary` that lists items. To
   allow a long summary without loosening the 280-character bound for everything else, a message
   may carry `count` (1..500); only then does `parseDeliveryMessage` raise the summary bound to
   **1400** characters (a test proves an ordinary message cannot smuggle a long summary). The budget
   keeps a reserve for the closing line, so "and N more not shown" is computed from what was
   actually listed and can never be cut (a review finding; tested through Slack, Lark, Teams,
   Discord and the custom webhook at the largest sizes). Discord keeps one embed with no repeated
   URL, `content` within 2000 characters and inert mentions; the custom webhook stays inside its
   64 KB cap. The digest collapses entries with the same group key into one line with `(×N)`,
   orders failures first and then newest first, and marks outcome with a text marker (`✗ ! • ✓`),
   never colour alone.

   **Continuation digests.** When a digest does not fit one message it is **split** into up to 3
   messages ("part 1 of 3", "Continued in the next message."), each listing up to 10 entries.
   Only what does not fit even then is left out, and the last message says so: "and N more items not
   shown. Their details are not kept." Items listed plus "not shown" always equal the rows (a
   property test parses the digest text to check it). Those N rows are marked released with the last
   part: the product keeps only the display fields it already bounded, and says it does not keep the
   rest.

8. **Group key (F141, F165).** `SHA-256` over length-prefixed `organization, integration (hence
   destination), event type, repository, subject`, truncated to 32 hex characters. The subject is
   what the update is about (`#<number>` for a pull request or issue, `run:<id>`, `branch:<ref>`,
   `deployment:<id>`, `release:<tag>`, or empty). The organization is the first component, and
   `held_events` rows are scanned per organization, so a cross-tenant merge is structurally
   impossible. Different repositories, pull requests, issues, branches, runs and event types are
   different keys by construction (tests).

9. **Resolved notices, simple version (F152).** For GitHub only: when an integration has
   `resolution: true`, a delivered `workflow_run.failure`/`timed_out` records an open failure keyed
   by `(organization, integration, repository, workflow name, head branch)` (a 32-hex hash in
   `noise_open_failures`, at most 200 per integration, 30-day retention). A later
   `workflow_run.success` for the same key is sent as **"Resolved: ..."** with a text summary, and
   closes the failure. An integration that follows failures only receives the success **solely** when
   it closes a failure that integration saw. The open/close statement is in the same D1 batch as
   the delivery (or hold) it accompanies, so a crash and redelivery behave identically. Opening runs
   first and is skipped when that very event already has a delivery or held row, so a provider
   **redelivery** of an old failure cannot re-open one a later success closed (a review finding,
   now tested). A late, out-of-order failure of a *different* run cannot be told apart and can still
   re-open one: webhooks are not ordered. A held "resolved" update is stored raw and given its
   wording once, at release. Not done:
   run attempts are not part of the key (a re-run that fails again just refreshes the open failure),
   no "original no longer retained" wording, and no grouping of resolution notices with siblings.
   Resolution defaults to **off**, not on as F152 asks, because `NULL` settings must never change
   what an existing integration sends; the form offers it as an explicit choice.

10. **Provenance reuses `routing_decisions`** (no rebuild). `held_events` is the record of what is
    waiting and why (`hold_reason`, a closed vocabulary). An event whose outcome the settings
    changed also writes a `routing_decisions` row with `outcome='delivered'` and the reason code
    `quiet_hours | digest | grouped | critical_bypass | hold_capacity` (the table's `reason` column
    has no `CHECK`; only the TypeScript type was widened). The recent-decisions list shows such a
    row as "Saved for later" with a sentence, or as an urgent bypass. The delivery log API gained
    `heldReason` and `groupedCount` (a scalar subquery on `held_events.released_in`, indexed), so a
    released digest says why it was held and how many updates it stands for.

11. **Dashboard** (`web/src/integrations/noise/`). A "Quiet hours and summaries" section on the
    integration settings page, not a wizard step. Native controls with visible labels and linked,
    announced errors; times are `<input type="time">`; the preview sentences come from the server's
    own `decideNoise` (so "During quiet hours Noti will hold updates and send one summary at 08:00"
    is computed, not templated, and shows the later time when a daily summary follows quiet hours).
    A status block says how many updates are waiting and when the next send is due
    (`GET /api/integrations/:id/noise-status`): held updates are never a black hole (F146).
    Copy is in `messages.noise.en.ts` / `.vi.ts`; Vietnamese is not reviewed by a native editor.
    Resolved notices are hidden for source integrations and disabled, with the reason, when no
    failing run is selected; the API refuses the same combination (422 `noise.resolution`).

## Consequences

- Integrations without noise settings behave exactly as before: no extra read, no extra write,
  no provenance row. Integrations with settings do one extra read per event
  (`COUNT` + `MIN` over a per-integration index) and one write.
- A held update is delayed by design. The longest delay is the quiet-hours length, a day for a
  daily summary, or an hour for a group window, plus up to a minute for the cron.
- **Settings changes reschedule what is held.** Turning every setting off (`noise: null` or `{}`)
  makes all the integration's held rows due at the next tick. Any other change recomputes `release_at`
  of rows held for quiet hours or a digest to when an update arriving now would be released under the
  NEW settings (the next boundary or the end of quiet hours), or at once when no digest-style hold
  applies any more. Grouped rows keep their window.
- **Held updates are exported** with the integration's `noise_json` (the settings), not the held
  display rows.
- Rolling the Worker back **strands** held rows (state `held`/`claimed`) until a Worker that
  knows about them runs again. They are not lost; the migration header says so. Turn noise
  settings off and let the table drain before a rollback if updates must not be delayed.
- At-least-once, not exactly-once: a notification can in principle be created twice if a D1 batch
  commits and its response is lost. The claim lease makes that rare, the second claim would find no
  rows, and the delivery guard is on the claim; the destination may still receive a delivery twice
  on a queue retry, as for any delivery (ADR 0005).
- The `deliveries.dedup_key` of a released notification is `noise:<id>`; it is not a provider
  identity and is never matched against one.

## Not done (named, not hidden)

Spec 11 items this slice does **not** implement, or implements only in part:

- **F154/F155 preset library and definitions**, the headline differentiator: no presets, no
  previewed diffs, no declarative preset data.
- **F147 three-level preferences, F148 critical lock as an admin setting** (critical is a fixed
  rule here), **F150 one-click unsubscribe**, **F151 bot suppression presets**, **F153
  per-destination noise budget**, **F162 mute/silence**, **F163 per-repository overrides**.
- **F156/F157/F158** in-place updates, entity correlation tables, threads; **F160** escalation;
  **F161** inhibition; **F164** noise report (counts by reason); **F166** group metrics (only
  logs); **F167** roadmap non-goal entry; **F168** (not read in this slice).
- F142: "Send at least every" (a maximum wait) is not offered; F143: Slack `text`/Discord URL
  rules are untested beyond the shared adapters; F144: weekly digests; the in-app link from a digest
  to a full view (digest links go to each item's source).
- F152: re-run attempts, "original no longer retained" wording, grouping of notices, default on.
- Provider and generic sources have no "resolved" notice (workflow runs are GitHub-only), and they
  derive `critical` from the mapped status only.
- Noise settings are not in the create wizard (they are in the workspace export).
- No AI summarisation of any kind.

## Verification

Automated, over the real migrations and the real Worker entry point (node:sqlite D1 fake):
table-driven time arithmetic (DST gaps and overlaps in New York and London, half- and
quarter-hour offsets, +14, day/year/leap-day rollovers) and an hourly walk across a year of New
York; decision tests (window edges, wrap past midnight, critical bypass, capacity, digest
boundaries moved out of quiet hours, group joining and extension); parsing and stored-document
tests including a canary; ingress end to end (hold, bypass, redelivery before and after a settings
change, per-tenant keys, fail-open, resolution, interaction with routing filters); release
(grouping, single, digest, empty, idempotent, concurrent, bounded by units and by rows, failed
batch, lost lease, tenant isolation, the scheduled job end to end through the queue); a **seeded
property test** (30 seeds, 120 events each, random settings, clocks, redeliveries and mid-stream
settings changes) asserting every ingested event is accounted for exactly once and that counts
conserve (it found the double-delivery in decision 5, now fixed); migration, purge coverage and
retention; API validation, authorization, CSRF and audit; web model, section, language and routing
log tests, and axe scenarios in English and Vietnamese.

Not verified: a real browser pass (320 px reflow, keyboard order, contrast of the new section,
Vietnamese diacritics), a screen-reader pass, behaviour against real Slack/Lark/Teams of a long
digest (the adapters are exercised only to the payload), real D1 semantics for `UPDATE ...
RETURNING` with a subselect and for `meta.changes` on the purge `DELETE`s (the fake is
`node:sqlite`), `Intl` time-zone data on the Workers runtime beyond what Node ships, load, and any
real-provider end-to-end run.
