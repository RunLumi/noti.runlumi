# ADR 0043: Noise control follow-ups: maximum wait, summary rendering tests, and what is declined

Status: Accepted · Date: 2026-10-15 · Implements part of F142 (spec 11) and closes the Slack and Discord rendering gap recorded against F143. Declines F141's configurable `group_by`. Builds on ADR 0016; no migration.

## Context

ADR 0016 shipped a fixed group window: a group is sent a set time after its first held update. Spec 11 F142 also asks for "send at least every", a maximum wait "even if more are coming". That only means something when more updates can restart the wait, which the fixed window never does, so a cap on it would do nothing. The renderer tests for Slack's top-level `text` and Discord's single embed were also missing for noise summaries (the spec's F143 gap).

The slice brief for this work named the follow-ups by its own labels. The spec's F-ids are used below: its F143 is the collapse rendering, F144 is digest scheduling, F145 is digest content, F146 is quiet hours.

## Decisions

1. **The maximum wait is opt-in and stored in the existing document.** `noise_json` gains an optional `maxWaitSec` in `{0, 900, 3600, 14400}` (15 min, 1 h, 4 h). `0` is off, which is the default and keeps the fixed window exactly as before. The document stays `v: 1`: the field is optional, and no migration is needed. It requires a combine window; `maxWaitSec` without `groupWindowSec` is `422` at `noise.maxWaitSec`.

2. **It is a sliding window with a cap, not a second fixed timer.** With a maximum set, each update restarts the group's wait (`now + groupWindowSec`), but the release never passes `firstHeldAt + maxWaitSec`, where `firstHeldAt` is the earliest waiting update in the group. The earlier of the two applies, so a maximum shorter than the window sends sooner. Quiet hours still win: a release that lands inside them moves to the end of them, as before. Two properties are tested. The release only moves later while a group is open, and a steady stream of updates every 37 seconds for two hours is sent at exactly the cap, group after group. An overdue cap (the release job has not run) means "as soon as possible", kept one millisecond ahead so every hold stays strictly in the future.

3. **One extra statement, in the same batch.** `decideNoise` gets an optional `openGroupFirstHeldAt`. When a restarted window moves an open group, the hold batch gains one `UPDATE` after the new row's insert, which sets every still-`held` row of that group to the new release, and only to a later one. The insert stays first, because the routes read its result by position. The three source routes now spread `plan.statements` instead of one statement. A claimed group is not touched, so the release job is never raced.

4. **The dashboard preserves the field and does not offer it yet.** The form carries `maxWaitSec` through a load and save, so saving the form cannot silently clear a value set through the API. It sends the value only while grouping is on, so turning grouping off is always savable. There is no control, no preview sentence and no copy in `messages.noise.*`. Adding those is a UI change that needs its own design verification and FRONTEND.md entry, and is left for a later slice. The spec's F142 stays 🟡 for that reason.

5. **F141: a configurable `group_by` is declined.** The spec's closed list is `repository, branch, pull_request, issue, workflow_run, actor, label, thread`. Every value except narrowing merges updates about different things: a branch, a run, a label or a thread spans pull requests, runs or branches, which F165 forbids (`never merge across different repositories, PRs/issues, branches, or workflow runs`). Narrowing (for example `actor`) only splits a key that is already the narrowest safe one for a subject, so it adds no noise control. The fixed key (`organization, integration, event type, repository, subject`) stays. Revisit only if a safe shape for a configurable key is specified.

6. **Slack and Discord summary rendering is tested through the real adapters** (the spec's F143 gap; the slice brief called it F144). `tests/noise/adapters.test.ts` asserts that Slack's top-level `text` carries the group heading, the newest-first list, the failure marker `✗` and the count, and that a digest collapses a key into a `(×N)` line and says "N updates since the last summary". A split digest names its part and the last part states what it left out. Discord's group embed carries the count, one URL (the newest update's) and the summary, and a digest embed has no URL, so Discord cannot dedupe it. No renderer code changed: the tests pass against the existing renderers, so they pin current behaviour rather than fixing a defect.

## Dashboard control

Added after decision 4, which left the form without a control. It supersedes the "does not offer it yet" part of that decision; the rest (the value is only sent while grouping is on) stands.

- **Where and when.** A select labelled "Send at least every" sits inside the "Combine bursts" fieldset, right after "Combine updates for". It is shown only while a combine window is chosen, like the quiet-hours times and the daily summary time, because the server refuses it without one. The draft keeps the choice while grouping is off, so turning grouping off and on again does not lose it; a save with grouping off sends `0`.
- **Choices are the server's closed list.** The options are built from `MAX_WAIT_SECONDS` (Off, 15 minutes, 1 hour, 4 hours), so the form cannot offer a value the API rejects. "Off" says what happens instead: "send when the combine time is up".
- **Plain language, not mechanism.** One hint sentence states the two effects: each new update restarts the wait, and the message is sent anyway this long after the first one. The spec's wording ("Send anyway after this long, even if more are coming") is kept in substance; no `group_interval`-style terms.
- **Preview.** When a maximum is set, the preview adds one sentence after the combine sentence: the message is sent about that long after the first update at the latest, and quiet hours can still hold it longer. "About" covers the release job's minute; the quiet-hours clause keeps the sentence true when decision 2's quiet-hours rule applies.
- **Errors.** A `422` at `noise.maxWaitSec` is placed on this control in our own copy and focused, like the other noise fields.

Verified by `web/src/integrations/noise/noise.test.tsx` (saved value, options, linked hint, shown only with combining, a save sends the chosen value, turning combining off sends `0`, server refusal on the control, Vietnamese), `web/src/integrations/noise/model.test.ts` (choices equal the server list, round-trip, preview sentence, error mapping), and the axe page scenario for `int_6` in both languages (`web/src/a11y/pages.a11y.test.tsx`; the fixture now stores `maxWaitSec: 3600`). The server's refusal of off-list values and of a maximum without a window was already covered by `tests/noise/api.test.ts` and `tests/noise/decision.test.ts`. Not verified: a real-browser pass (320 px reflow, native select on phones, Vietnamese diacritics) and a screen reader.

## Declined or not done in this slice

- **F149 "why did I get this?" per notification: not extended.** The routing log already gives a translated reason for every event that has a decision row (filter outcomes, held updates, critical bypass, backlog cap). A per-delivery rule attribution for delivered notifications needs either a provenance row for every delivery, which ADR 0010 decided against for cost, or a rule id on `deliveries`, which is a schema change this slice may not make. An in-destination "via" line changes every outgoing format and budget, which is a product decision across all adapters.
- **Not done, from this slice's list, because they do not fit without a migration or are out of reach here:** the weekly digest (spec F144), per-workspace quiet hours (spec F146), category grouping and the in-app link in digests (spec F145), and the severity model (spec F159, which needs the canonical outcome enum, roadmap item 1.12).

## Consequences

- Integrations without `maxWaitSec` behave exactly as before: no extra statement, no extra read beyond the first-held time that the existing group read now returns.
- A group with a maximum wait is sent within `maxWaitSec` of its first update, plus up to a minute for the cron. Quiet hours can still hold it later, as they always could.
- **Rolling back the Worker.** An older Worker does not know `maxWaitSec`, so its stored document fails its own parser and is read as unusable. ADR 0016's rule for unusable settings applies: new updates for that integration are delivered normally, and `noise_settings_unusable` is logged. Held rows already written stay in `held_events`. The ADR 0016 Worker knows those rows and releases them at their stored times; rolling back further, to a Worker that predates them, strands them as ADR 0016 describes. Nothing is lost either way.

## Verification

Automated, through the real Worker entry point and migrations for the integration tests:

- `tests/noise/decision.test.ts`: the cap and monotone properties, quiet-hours interaction, the overdue case, the stream simulation, parsing (defaults, off-menu values, a maximum without a window) and round-trip of old and new documents.
- `tests/noise/ingress.test.ts`: the sliding window end to end (every waiting row of the group moves together and stops at the cap) and a second group, on another issue, is not moved.
- `tests/noise/api.test.ts`: `maxWaitSec` is validated with dotted paths and stored.
- `tests/noise/adapters.test.ts`: Slack and Discord summary rendering (see decision 6).
- `web/src/integrations/noise/model.test.ts`: the form keeps a maximum wait on save, and turning grouping off clears it.

Not verified: a browser pass of the form (see "Dashboard control" for the control added later), real Slack or Discord delivery of a long digest, and `Intl` behaviour on the Workers runtime.

## Revisit when

- People pick a maximum wait and still find the stream too chatty or too slow: then the closed list (15 min, 1 h, 4 h) is the thing to revisit, in the server and the form together.
- A safe configurable grouping key is specified (F141). Until then the fixed key stays.
- Per-notification attribution to a rule (F149) is wanted enough to justify a rule id on deliveries. That is a migration and needs its own ADR.
