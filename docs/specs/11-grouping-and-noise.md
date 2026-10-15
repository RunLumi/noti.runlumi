# 11 — Grouping, Digests & Noise Control

> Verified against competitor documentation **2026-10-13**.
> Source of record: `docs/specs/COMPETITIVE-FEATURE-SET.md` (114 verified URLs).

## The competitive finding that defines this domain

Every serious alerting product documents its best practices. **None of them ship them as
presets.** Grafana's docs contain a copy-pasteable escalation chain; Sentry's contain "start
with narrow Alerts and consolidate into one with broader filters." They are *prose*.

Meanwhile Sentry's own help centre carries an article titled **"What does the Action
Interval option do?"** whose body is *"It is unclear exactly what the Action Interval option
does."* That is a competitor documenting, in public, that their throttling controls confuse
their users.

**This is our largest available differentiator and it is cheap.** A non-technical user should
not have to read documentation to decide how noisy their notifications are. They should pick
**"Failures only"** or **"Comment digest, every 5 minutes"** and be done.

| Priority | Feature | Why |
| --- | --- | --- |
| 1 | **Shipped presets** (F154–F155) | Biggest gap in the category. Prose competitors, product presets. |
| 2 | **"Why did I get this?"** (F149) | GitHub's `reasons` label — the most-imitated idea in the category, ~1 day of work. |
| 3 | **Sticky one-click unsubscribe** (F150) | Turns "too noisy" from a support ticket into a self-serve fix. |
| 4 | **Resolution notices** (F152) | PagerDuty doesn't send these by default. Ours should. |
| 5 | **3-level preferences with a critical lock** (F147–F148) | Data model; retrofitting is a migration. Decide now. |

## A pricing constraint discovered during research

Knock and Courier bill on **notifications sent** — Knock states suppressed sends cost
nothing. **Novu bills on workflow *runs***, which means a digest that collapses 200 events into
one message bills the customer for 200.

> Billing on triggers directly punishes exactly the deduplication and digest behaviour this
> domain exists to provide.

F253 (and F254) therefore mandate billing on **messages sent**, never on events received or rules
evaluated. Any pricing model that charges for suppression will make this product worse.

---

## F141 — Grouping key

**Priority** P1 · **Status** 🟡 SHA-256 key, organization first, 32 hex (`src/routing/noise.ts`, `tests/noise/decision.test.ts`, ADR 0016); `group_by` is not user-configurable: a configurable key was declined in ADR 0043, because every value on the closed list except narrowing would merge updates about different subjects, which F165 forbids

**Story** As a user, I want related events combined, so that 40 comments on one PR produce one
notification instead of 40.

**Acceptance**
- [ ] A group key is **derived from the canonical envelope**, never from raw provider data, so
      it behaves identically across providers.
- [ ] Default composition, in order of precedence:
      ```
      (organization_id, destination_id, event_type, group_by…)
      ```
- [ ] `group_by` is a closed set: `repository`, `branch`, `pull_request`, `issue`,
      `workflow_run`, `actor`, `label`, `thread`.
- [ ] ⭐ **Never merge across** different organizations, different destinations, different
      repositories, different PRs/issues, different branches, or different workflow runs.
      `docs/LARK_REFERENCE_ARCHITECTURE.md` says this directly and it is the single most
      damaging grouping bug available — it puts one customer's event in another customer's
      message.
- [ ] The key is hashed to a bounded length and stored, not reconstructed on every render.
- [ ] Custom grouping expressions are **not** offered in V1 (F167).

**Errors** — a group key that would exceed the bound is rejected at configuration time with a
named suggestion, not silently truncated.

**Security** — `organization_id` is in the key by construction, so a cross-tenant merge is
structurally impossible rather than merely filtered.

**Tests**
- `group_key_never_spans_organizations`
- `group_key_never_spans_repositories_or_destinations`
- `same_event_grouped_differently_under_different_group_by`
- `group_key_is_bounded`

**Deps** — F41, F24.

---

## F142 — Group window

**Priority** P1 · **Status** 🟡 Off/1/5/15/60 min window, default off, computed preview (`src/routing/noise.ts`, `tests/noise/decision.test.ts`, ADR 0016); "Send at least every" maximum wait (15 min, 1 h, 4 h) in the decision, the stored document (`maxWaitSec`) and the API (ADR 0043, `tests/noise/ingress.test.ts`) and offered in the dashboard form only while combining is on (ADR 0043 "Dashboard control", `web/src/integrations/noise/noise.test.tsx`); no browser pass or real-provider acceptance yet

**Story** As a user, I want a window I can reason about, so that grouping is predictable.

**Acceptance** — two independent knobs, named in plain language rather than as a mechanism:

| Setting | Default | Meaning shown to user |
| --- | --- | --- |
| **Combine events for** | 0 s (off) | "Wait this long before sending" |
| **Send at least every** | — | "Send anyway after this long, even if more are coming" |

- [ ] Defaults to **off**. Grouping must be opted into, never surprising.
- [ ] The UI shows a **live example** of what the setting does, not just a number.
- [ ] ⭐ **Never expose Alertmanager-style raw knobs** (`group_wait`, `group_interval`). That
      vocabulary is Sentry's documented failure mode; ours should not import it.
- [ ] Pre-set, human-readable choices: *Off / 1 min / 5 min / 15 min / 1 hour*.

**Design** — Grouping semantics follow Prometheus Alertmanager's proven model (`group_by`,
`group_wait`, `group_interval`) but the **presentation** deliberately does not. Alertmanager's
knobs are correct and opaque; ours ship as four labelled choices.

**Errors** — a window below the provider's minimum meaningful interval is rejected.

**Security** — n/a.

**Tests** — `window_boundaries_are_respected`; `at_least_every_forces_a_flush`;
`grouping_defaults_to_off`.

**Deps** — F141, F154.

---

## F143 — Collapse into one message

**Priority** P1 · **Status** 🟡 one message with newest item, count and capped list saying what is not shown (`src/routing/noise-render.ts`, `tests/noise/render.test.ts`, ADR 0016); Slack top-level `text` and Discord's single embed are now asserted through the renderers for group and digest summaries (`tests/noise/adapters.test.ts`, ADR 0043)

**Story** As a user, I want one message listing related events, so that I can scan rather than
scroll.

**Acceptance**
- [ ] A collapsed message shows: a summary line, an item count, and a **capped** item list.
- [ ] The cap is explicit in the UI ("showing 10 of 47") and never a silent truncation.
- [ ] Slack top-level `text` carries the summary, because *"screen readers will default to the
      top-level text field"* — accessibility and notification preview in one.
- [ ] The source link is present on both the message and, where supported, each item.
- [ ] ⚠️ Discord dedupes embeds by URL — *"If a message contains multiple embeds with the same
      URL, only the first is shown."* Multiple items from one repo would collapse. Never emit
      multiple same-URL embeds.

**Errors** — n/a.

**Security** — collapsed content still passes F94 rendering rules.

**Tests** — `collapsed_message_states_the_total_count`; `item_list_is_capped_visibly`;
`slack_top_level_text_carries_the_summary`; `discord_emits_no_duplicate_embed_urls`.

**Deps** — F95, F141.

---

## F144 — Digest scheduling

**Priority** P1 · **Status** 🟡 hourly and daily digests at local time, empty digest sends nothing, normal retry (`src/pipeline/noise-release.ts`, `tests/noise/release.test.ts`, ADR 0016); not built: weekly, per-user digests

**Story** As a user, I want low-value chatter batched into a scheduled summary, so that my
chat is quiet but I still know what happened.

**Acceptance**
- [ ] Digest intervals: hourly, daily at a chosen time, weekly. Plus "immediately".
- [ ] A chosen send time respects the user's timezone.
- [ ] ⭐ **A digest that would be empty sends nothing.** No "0 events in the last hour" message.
- [ ] ⚠️ **A digest that is due but has no content must not be retried** — it is a successful
      no-op, not a failure.
- [ ] Digest is opt-in per integration and clearly labelled in the UI.

**Design** — Courier publishes its retry ladder (5 s → 15 m, ~104 attempts / 24 h, honour
`Retry-After`, then failover, then terminal `UNDELIVERABLE`) — the best-documented delivery
semantics in the category. Our own ladder is in `12-delivery-reliability.md`; a digest uses
the same machinery with a different trigger.

**Errors** — a digest send that fails follows the normal retry policy (F177).

**Security** — n/a.

**Tests** — `empty_digest_sends_nothing`; `digest_respects_the_users_timezone`;
`digest_send_failure_follows_the_standard_retry_policy`.

**Deps** — F154, F190.

---

## F145 — Digest content model

**Priority** P1 · **Status** 🟡 failures first then newest, same-key collapsed with count, capped with "N more not shown", split into up to 3 parts (`src/routing/noise-render.ts`, `tests/noise/render.test.ts`); not built: category/repository grouping, in-app view link

**Story** As a user, I want a digest that is actually readable, so that I scan it in ten
seconds.

**Acceptance**
- [ ] Grouped by category, then by repository, then chronologically.
- [ ] Each entry: event, actor, subject, outcome, link.
- [ ] Failures are visually distinct from successes **without** relying on colour alone
      (WCAG 2.2 AA — a text marker such as `✗`/`✓`).
- [ ] Destination body caps are respected (F95) — a large digest degrades by eliding
      lowest-severity items, **and says so**: "12 more items not shown".
- [ ] The digest links to a full in-app view of everything it contains.

**Design** — The last point matters: the digest is a summary, the dashboard is the record.
That division is what lets the digest stay small without losing information.

**Errors** — n/a.

**Security** — n/a.

**Tests** — `digest_groups_readably`; `digest_respects_the_body_cap_and_states_elision`;
`digest_outcome_is_not_conveyed_by_colour_alone`.

**Deps** — F145, F95.

---

## F146 — Quiet hours

**Priority** P1 · **Status** 🟡 per-integration window with time zone, DST-tested, critical bypass, held updates released as digest and shown as waiting (`src/routing/noise-time.ts`, `tests/noise/time.test.ts`, ADR 0016); not built: per-workspace or per-user hours, emergency override

**Story** As a user, I want non-urgent notifications held while I sleep, so that I am not
woken by a routine build.

**Acceptance**
- [ ] Per-workspace schedule with timezone, plus an emergency override.
- [ ] ⚠️ **Critical events bypass quiet hours** (F148). A CI failure on the release branch at
      3 a.m. is the whole point of the feature existing; it is not "urgent" from our side, it
      is from theirs.
- [ ] Held notifications are **delivered** after quiet hours end, not dropped, and not all at
      once — they are grouped.
- [ ] Empty holds send nothing (same rule as F144).
- [ ] The UI states plainly what bypasses quiet hours.

**Design** — Alertmanager's `mute` and `silence` are the proven primitives. The trap they
share is silence-as-black-hole: a muted alert that fires and is never shown is invisible.
Ours must show **"3 notifications were held during quiet hours"**.

**Errors** — n/a.

**Security** — n/a.

**Tests** — `critical_events_bypass_quiet_hours`; `held_notifications_are_delivered_not_dropped`;
`empty_hold_sends_nothing`; `quiet_hours_respect_the_users_timezone`.

**Deps** — F148, F162.

---

## F147 — Three-level preferences

**Priority** P1 · **Status** ❌ no workspace/integration/user preference levels; noise settings are one per-integration JSON column `noise_json` (migration `0021`). Retrofitting is a migration · **Decide before V1 — retrofitting is a migration**

**Story** As a user, I want to control notification volume per channel, so that I can turn
down chat noise without losing email.

**Acceptance**
- [ ] Three levels, resolved most-specific-wins:

| Level | Set by | Scope |
| --- | --- | --- |
| **Workspace default** | admin | all members, all destinations |
| **Integration override** | member | this integration |
| **Personal** | member | this member |

- [ ] The UI always shows the **effective** value and which level set it. A user whose
      preference is overridden must be able to see that.
- [ ] Precedence is documented and tested: personal > integration > workspace.
- [ ] A member may always **escalate to more** for themselves; they may not **escalate past
      the workspace ceiling** (F148).

**Design** — Precedence order is the entire design. Getting it wrong means a user's
"quiet" preference is silently ignored, which is the fastest route to a churn complaint.

**Errors** — an unresolved conflict is impossible by construction; the resolution is total.

**Security** — preferences are per-user and may contain pattern rules; treat them as
user-controlled input.

**Tests**
- `personal_overrides_integration_overrides_workspace`
- `effective_value_is_always_visible_with_its_source`
- `member_may_escalate_but_not_beyond_the_workspace_ceiling`

**Deps** — F148, F156.

---

## F148 — Critical-event lock

**Priority** P1 · **Status** 🟡 fixed critical rule (failed status or `security.` events) bypasses quiet hours, digest and grouping (`src/routing/noise.ts`, `tests/noise/decision.test.ts`, ADR 0016); not built: admin-configurable lock, member-mute explanation

**Story** As a workspace admin, I want to guarantee that failures always reach someone, so
that a member cannot mute an alert into oblivion.

**Acceptance**
- [ ] An admin marks an event type **critical** at the workspace level.
- [ ] Critical events **bypass** personal preferences and quiet hours, and are never
      suppressed by grouping.
- [ ] The UI states, at the point of muting: *"CI failures are critical for this workspace and
      will still be delivered."* Muting must not silently fail.
- [ ] Critical events are always delivered — **at-least-once with no suppression window**
      (F186 does not apply).
- [ ] A member may still route a critical event elsewhere; they may not stop it.

**Design** — This is the administrative override that makes preference systems safe to ship.
Without it, "turn off notifications" is a one-click way to silence a production alerting path,
and the workspace admin has no recourse.

**Errors** — attempting to suppress a critical event is a **no-op with an explanation**, not a
failure.

**Security** — only workspace owners/admins may set the critical flag; changes are audited.

**Tests** — `critical_events_bypass_personal_preferences`;
`critical_events_bypass_quiet_hours`; `muting_a_critical_event_is_explained_not_silent`;
`critical_events_are_never_deduplicated`.

**Deps** — F147, F146, F186.

---

## F149 — "Why did I get this?"

**Priority** P1 · **Status** 🟡 integration page lists recent routing decisions with reason codes and delivery log shows `heldReason`/`groupedCount` (`src/routing/provenance.ts`, `src/api/delivery-view.ts`); not built: per-notification "Why did I get this?" for delivered events, rule attribution · **Highest value / lowest cost**

**Story** As a user receiving a notification I did not expect, I want to know which rule sent
it, so that I can fix the cause instead of muting the symptom.

**Acceptance**
- [ ] Every delivered notification carries the rule that produced it, visible in-app.
- [ ] ⚠️ Rendered **into the destination too** where the format allows — a short "via
      `ci-failures`" line. This is GitHub's `reasons` label, and it is the most-imitated idea
      in the notification category for good reason: it converts "why am I getting this?" from
      a support question into a self-serve fix.
- [ ] The link goes to the exact rule, with a one-click edit.
- [ ] Works for filtered-out events too: "suppressed because X" is shown in the event log.

**Design** — GitHub puts the reason on the notification itself; Slack does not. Matching
GitHub here is cheap and it is the difference between a product people trust and one they
mute reflexively.

**Errors** — a notification with no matching rule (e.g. replayed) shows "replayed
notification" rather than nothing.

**Security** — rule names are user-controlled and pass F94 escaping.

**Tests**
- `every_notification_reports_the_rule_that_sent_it`
- `suppressed_events_report_the_suppressing_rule`
- `rule_name_is_escaped_per_destination`

**Deps** — F136, F213.

---

## F150 — Sticky one-click unsubscribe

**Priority** P1 · **Status** ❌ no unsubscribe link or one-click mute in messages; no per-user subscription model to attach it to. Depends on F147

**Story** As a user whose chat is too noisy, I want to mute it from the message I am looking
at, so that I stop asking anyone to fix it.

**Acceptance**
- [ ] Where the destination supports interactive actions (Slack Block Kit, Lark app, Discord),
      the message carries a **"Stop these"** action.
- [ ] ⚠️ **Not available on Teams Workflows or Lark custom-bot webhooks** — Teams has no
      Actions support at all and Lark custom bots are *"URL-only, no callback"*. The
      degradation is honest: a link to the setting instead of a button (F93).
- [ ] The action is **sticky**: it sets the personal preference and tells the user exactly
      what it changed, with an undo.
- [ ] It adjusts **only** the personal level (F147) — a user cannot use a one-click button to
      override a workspace critical-event lock.
- [ ] The action always states which rule and which event type it affects.

**Design** — "Too noisy" is the single most common support ticket in this category. Making it
a self-serve action on the message itself converts a support cost into a retention feature.

**Errors** — a stale action (rule since deleted) says so and links to settings.

**Security** — ⭐ **Mute buttons are a CSRF vector**: they mutate state from a third-party
chat client. Each action must carry an unguessable, single-use, short-lived token bound to
`(action, delivery, user)` and verified server-side. It must not be a bare URL.

**Tests**
- `mute_action_is_single_use_and_bound_to_the_user`
- `mute_action_cannot_override_a_critical_lock`
- `mute_action_falls_back_to_a_link_on_non_interactive_destinations`
- `mute_action_reports_exactly_what_it_changed`

**Deps** — F147, F92, F27 (CSRF token issuance).

---

## F151 — Bot and self-generated suppression

**Priority** P1 · **Status** 🟡 `actor` filter can exclude bots or allow only bots, ghost exempt (`src/routing/filters.ts`, `tests/routing/filters.test.ts`); not built: suppression of Noti's own or self-generated events, bot presets

**Story** As a user, I want to filter automated noise differently from human activity, so
that I can keep the signal.

**Acceptance**
- [ ] Opt-in presets: *"Ignore events caused by GitHub Actions"*, *"Ignore events caused by
      bots"*, *"Ignore comments from bots"*.
- [ ] ⚠️ **Never suppress `ghost`.** GitHub's `ghost` placeholder is not a bot; it means the
      actor is **unresolved**. Suppressing it would silently drop real events with no
      identifiable actor — the worst possible outcome for an alerting product.
- [ ] Suppression is **visible**: the event log shows "suppressed: bot actor", so a user can
      tell the difference between "nothing happened" and "we filtered it".
- [ ] `data.actor.isBot: null` (provider does not distinguish) is **not** suppressed, because
      absence of evidence is not evidence of a bot.

**Design** — The temptation is `isBot === true → drop`. That is wrong for every provider that
does not populate the field, and catastrophically wrong for `ghost`.

**Errors** — n/a; suppression is recorded, not silent.

**Security** — n/a.

**Tests** — `bot_events_are_suppressed_when_enabled`;
`ghost_actors_are_never_suppressed`; `null_is_bot_is_not_treated_as_bot`;
`suppressed_events_are_visible_in_the_log`.

**Deps** — F43, F60.

---

## F152 — Resolution notices

**Priority** P1 · **Status** 🟡 GitHub workflow failure then success on same repository, workflow and branch sends Resolved, default OFF (`src/pipeline/noise-release.ts`, `tests/noise/ingress.test.ts`, ADR 0016); not built: run attempts in key, retention wording, other providers · **Differentiator**

**Story** As a user, I want to know when a failure resolved, so that I can stop holding it in
my head.

**Acceptance**
- [ ] When an open event is resolved, a **resolution notice** is sent: *"Run #482 is green
      again."*
- [ ] ⚠️ **PagerDuty does not send these by default.** This is a genuine differentiator and it
      is cheap, because F44 already models close events as resolutions.
- [ ] Default **on**, and configurable per integration.
- [ ] If the original event is outside retention, the notice reads *"resolved (original no
      longer retained)"* rather than failing or being suppressed.
- [ ] The notice is grouped with its siblings where grouping is on.

**Design** — This requires F44's state model to already be correct. Without a close/open
correlation there is nothing to resolve, and no amount of UI fixes it.

**Errors** — a resolution with no known antecedent still sends, marked as such.

**Security** — n/a.

**Tests** — `resolving_event_sends_a_resolution_notice`;
`resolution_without_a_retained_antecedent_is_labelled`;
`resolution_notices_are_grouped_with_siblings`.

**Deps** — F44, F157.

---

## F153 — Per-destination noise budget

**Priority** P1 · **Status** ❌ no per-destination messages-per-hour ceiling; only a 500-update per-integration hold cap (`HELD_CAPACITY` in `src/routing/noise.ts`) that fails toward delivering

**Story** As an operator, I want each destination to have its own volume policy, so that a
high-volume destination cannot saturate a channel the team depends on.

**Acceptance**
- [ ] A per-destination ceiling on messages per hour, **default off** (no surprise
      throttling).
- [ ] When the ceiling is hit: escalate to digest rather than drop. **Never silently discard.**
- [ ] The UI shows: "Lark #alerts sent 240 of 300 messages this hour. The remaining 60 are in
      a digest."
- [ ] Critical events (F148) are exempt from the ceiling.
- [ ] ⚠️ The ceiling is a **product** policy and is separate from provider rate limits (F187)
      and from billing counters (F253). Three different things that must not be conflated.

**Design** — Dropping is always wrong. Every suppression path in this domain routes to
digest or to a visible "held" state.

**Errors** — n/a.

**Security** — n/a.

**Tests** — `ceiling_routes_to_digest_never_discards`;
`critical_events_are_exempt_from_the_ceiling`;
`product_ceiling_is_independent_of_provider_rate_limits`.

**Deps** — F144, F187.

---

## F154 — Preset library

**Priority** P1 · **Status** ❌ no preset library; noise and filters are configured field by field. Depends on F121 and F155 · **Biggest available differentiator**

**Story** As a non-technical user, I want sensible defaults I can pick rather than configure,
so that I get good notification behaviour without reading documentation.

**Acceptance** — every preset is a complete, tested configuration:

| Preset | Behaviour |
| --- | --- |
| **Everything** | Every selected event, delivered immediately. Default for new users. |
| **Failures only** | Only `outcome = failure`. Highest-signal starting point. |
| **Needs my attention** | Failures + review requests + direct mentions; ignores self-authored events. |
| **Comment digest** | Comments grouped, delivered every 5 min. |
| **Daily summary** | Everything non-urgent in one daily message. |
| **Release & deploy only** | Releases and deployment statuses. |
| **Workflow results** | CI outcomes, failures prominent. |

- [ ] Presets are **selectable at setup time and switchable later**, without losing custom
      rules.
- [ ] Applying a preset is a **previewed diff**: *"This will stop sending 3 event types and
      group comments for 5 minutes."* Never a silent overwrite.
- [ ] Presets are the **primary UI**; advanced configuration is available but collapsed.
- [ ] Every preset ships with a **recommended event selection**, so one click produces a
      working configuration rather than just a noise policy.

**Design** — This is the thesis of the domain, and it is grounded in evidence rather than
instinct: competitors publish their best practices as documentation prose and their users get
confused by the result. A non-technical user should never have to know what an "action
interval" is. `docs/PRODUCT.md` targets a user who wants setup in minutes — presets are how
that target is met on the noise axis.

**Errors** — n/a.

**Security** — n/a.

**Tests**
- `every_preset_produces_a_valid_configuration`
- `applying_a_preset_previews_the_diff_before_acceptance`
- `switching_presets_preserves_custom_rules`
- `setup_completes_from_a_preset_alone`

**Deps** — F155, F136.

---

## F155 — Preset definitions

**Priority** P1 · **Status** ❌ no declarative preset definitions or previewed diffs. Depends on F154

**Story** As a maintainer, I want presets defined in data, so that adding one is a reviewable
change rather than a code edit.

**Acceptance**
- [ ] Presets are **declarative data**, versioned, with a schema. A malformed preset fails
      validation at startup, not at customer request time.
- [ ] Each preset declares: event selection, grouping, digest, quiet hours, per-destination
      overrides, and a human description.
- [ ] Presets are **additive only**. A shipped preset is never silently changed — behaviour
      changes ship as a new preset version, because a customer who chose "Failures only"
      cannot have it change under them.
- [ ] Preset changes are audited like any other configuration change.

**Design** — The additivity rule is the important one. Presets are load-bearing
configuration; mutating one in place is a breaking change with a very bad failure mode
(someone's alerts quietly stop arriving after our release).

**Errors** — an invalid preset is rejected at load and the Worker refuses to start (F04),
rather than serving a broken preset.

**Security** — presets cannot contain credential material or external URLs.

**Tests** — `all_presets_validate_against_the_preset_schema`;
`preset_definitions_are_versioned_and_additive`;
`invalid_preset_prevents_startup`.

**Deps** — F154.

---

## F156 — Correlated state updates

**Priority** P2 · **Status** ❌ no in-place message update on state change; resolution is a separate Resolved message (F152)

**Story** As a user, I want the CI card for a workflow to update in place rather than adding a
new message, so that the channel tells the story instead of accumulating fragments.

**Acceptance**
- [ ] Where `capabilities().canUpdate` is true, a later event for the same entity **updates**
      the existing message instead of posting a new one.
- [ ] Requires a stable entity key (F157) and a persisted provider message id.
- [ ] ⚠️ **Available on: Slack Web API, Teams Bot, Lark app, Discord, Telegram. Not available
      on: Slack incoming webhooks, Teams Workflows, Lark custom bots.**
- [ ] The degradation is declared (F93): a new message prefixed "Update:", plus an explanation
      of why it could not be updated.
- [ ] On every Slack update, give a **new `block_id`** — Slack: *"If a message is updated, use
      a new `block_id`"* — and send `text` **and** `blocks` together, because providing `text`
      without `blocks` removes the blocks.
- [ ] The original delivery is recorded as superseded; the history is preserved, not erased.

**Design** — This is the single strongest quality signal a notification product can have: a
CI card that turns red then green in one message. It is also the feature most constrained by
destination capability, which makes F92's honesty essential.

**Errors** — a failed update falls back to a new message rather than losing the event.

**Security** — updating a message requires the provider message id we recorded; it is not a
blind write.

**Tests**
- `capable_destinations_update_in_place`
- `incapable_destinations_declare_the_degradation`
- `slack_updates_use_a_new_block_id_and_both_text_and_blocks`
- `update_failure_falls_back_to_a_new_message`

**Deps** — F92, F157, F99.

---

## F157 — Entity correlation

**Priority** P2 · **Status** ❌ no entity correlation table beyond the open-failure key in `noise_open_failures` (migration `0021`)

**Story** As a user, I want a workflow's events to be recognised as the same thing, so that
its status updates in one place.

**Acceptance**
- [ ] Correlation keys are derived from normalized fields only:
      `workflow_run → (repository, run_id)`; `pull_request → (repository, number)`;
      `issue → (repository, number)`; `check_suite → (repository, suite_id)`.
- [ ] ⚠️ **GitHub `run_attempt` is part of the key**, not excluded — a re-run is a new attempt
      and should not overwrite the previous one.
- [ ] ⚠️ Never correlate across repositories or organizations.
- [ ] The correlation table is retained alongside event retention, and a correlation whose
      antecedent expired degrades gracefully.

**Errors** — an unresolvable correlation is a new entity, never a wrong merge.

**Security** — the key is scoped by organization; cross-tenant correlation is structurally
impossible.

**Tests** — `same_workflow_run_correlates`; `rerun_creates_a_new_correlation`;
`correlation_never_crosses_organizations`; `expired_correlation_degrades_gracefully`.

**Deps** — F44, F156.

---

## F158 — Thread strategy

**Priority** P2 · **Status** ❌ no thread strategy; every notification is a new top-level message

**Story** As a user, I want related notifications in a thread rather than scattered, so that
the conversation stays readable.

**Acceptance** — declared per destination via `capabilities().canReply`:
- [ ] Reply under the first event's message where a reply is possible.
- [ ] Slack: *"Avoid using a reply's `ts` value; use its parent instead."*
- [ ] Otherwise: new message with a link to the parent.
- [ ] The parent reference is recorded so the fallback link is always correct.

**Errors** — n/a.

**Security** — n/a.

**Tests** — `replies_use_the_parent_not_the_reply`;
`thread_fallback_links_to_the_recorded_parent`.

**Deps** — F92.

---

## F159 — Severity and priority

**Priority** P1 · **Status** 🟡 derived critical rule and failure-first digest ordering only (`src/routing/noise.ts`, `src/routing/noise-render.ts`); not built: severity field, `neutral`/unknown outcome metric, per-rule priority

**Story** As a user, I want failures to sort above comments, so that triage starts at the top.

**Acceptance**
- [ ] Severity derives from `data.outcome` (F44) and event category, not from user input.
- [ ] Ordering: `failure` > `neutral` > `success`, then recency.
- [ ] Critical (F148) is a separate flag, not a severity level.
- [ ] Severity is used for grouping priority, digest ordering, quiet-hours exemption and
      ceiling exemption — one concept, consistently applied.

**Errors** — unknown outcome maps to `neutral` and raises a metric.

**Security** — severity is server-derived; a payload cannot declare itself critical.

**Tests** — `severity_is_derived_not_client_declared`;
`failures_sort_above_successes`; `unknown_outcome_maps_to_neutral`.

**Deps** — F44, F148.

---

## F160 — Escalation (minimal)

**Priority** P2 · **Status** ❌ no escalation of repeated or unacknowledged failures · **Deliberately narrow**

**Story** As a team lead, I want an undelivered critical alert to escalate to a second
destination, so that one broken channel does not swallow an outage.

**Acceptance**
- [ ] Only **critical** events escalate. Everything else is single-destination.
- [ ] Escalation is to **one** configured fallback destination, once.
- [ ] ⚠️ **No on-call schedules, no rotation, no PagerDuty-style escalation policies.**
      `AGENTS.md` scopes V1 to notification routing, and Grafana's escalation chains live in
      their docs rather than their UI — we ship a narrow version of the idea, not the system.
- [ ] Escalation is visible in the delivery log as a second delivery with
      `escalated_from`.

**Design** — The competitive research is explicit that on-call scheduling is a different
product. Doing it badly is worse than not doing it.

**Errors** — a failed escalation follows the normal retry policy and dead-letters
independently.

**Security** — escalation targets are configured destinations, never arbitrary URLs.

**Tests** — `critical_events_escalate_once_to_the_fallback`;
`non_critical_events_never_escalate`; `escalation_appears_in_the_delivery_log`.

**Deps** — F148.

---

## F161 — Narrow inhibition subset

**Priority** P2 · **Status** ❌ no inhibition subset (for example suppressing a failure while a related one is open) · **Hard-coded, not a rule UI**

**Story** As a user, I want a failure alert not to be buried under its own retries and
follow-up events, so that the important one is visible.

**Acceptance** — a **fixed, documented set**:
- [ ] A repeated `failure` for the same entity within the window does not create a new
      message; it updates the existing one where possible (F156).
- [ ] A `success` after a `failure` suppresses a duplicate success notice (default on).
- [ ] A bot comment does not suppress the human comment it replies to.

- [ ] ⭐ **No generic inhibition-rule UI.** Alertmanager's `inhibition_rules` are powerful and
      the competitive research is explicit that exposing them generically is a trap — a
      misconfigured rule **silently suppresses real alerts**, and the failure is invisible by
      construction.
- [ ] If we ever expose it, it requires a simulation preview: *"this rule would have suppressed
      47 alerts in the last 30 days, including 3 marked critical."*

**Design** — Inhibition is the most dangerous feature in alerting software because its
failure mode is silence. Ship the subset that is provably safe; make the generic engine a
post-V1 project gated on a simulation UI.

**Errors** — inhibition is always recorded and shown: "3 notifications suppressed by
inhibition".

**Security** — a rule that suppresses a critical event is blocked outright (F148).

**Tests**
- `inhibition_is_recorded_and_visible`
- `inhibition_cannot_suppress_a_critical_event`;
- `no_generic_inhibition_rule_configuration_exists`.

**Deps** — F148, F156.

---

## F162 — Mute and silence

**Priority** P2 · **Status** ❌ no mute or silence object; quiet hours (F146) is the only way to hold updates

**Story** As a user, I want to silence a noisy repository for an hour, so that a migration
does not bury everything.

**Acceptance**
- [ ] Scopes: one repository, one event type, one destination. Time-boxed with an expiry.
- [ ] ⚠️ **A silence is never permanent by default** and always shows an expiry.
- [ ] ⚠️ **A silence never hides the existence of events** — the log shows "12 events silenced
      by your rule until 15:42". Alertmanager's silence has the same property; it is the
      difference between "quiet" and "blind".
- [ ] Silence is personal by default; workspace-wide silence requires admin.
- [ ] Critical events are exempt (F148).

**Errors** — n/a.

**Security** — an expiring silence cannot be used to permanently hide alerts.

**Tests** — `silence_always_has_an_expiry`; `silenced_events_are_still_counted_and_shown`;
`critical_events_are_exempt_from_silence`.

**Deps** — F146, F148.

---

## F163 — Per-repository overrides

**Priority** P2 · **Status** ❌ no per-repository noise overrides; settings are per integration only

**Story** As a user, I want different rules for a noisy repo, so that one project does not set
the policy for the rest.

**Acceptance**
- [ ] Most-specific-wins: repository override > integration default > workspace default.
- [ ] The effective configuration is always inspectable — *"for `acme/legacy`: failures only,
      inherited from integration."*
- [ ] Overrides are shown in the repository list so they do not become invisible policy.

**Design** — Same precedence discipline as F147; one shared resolver so the two cannot
disagree.

**Errors** — n/a.

**Security** — n/a.

**Tests** — `repository_override_beats_integration_default`;
`effective_configuration_names_its_source`.

**Deps** — F147.

---

## F164 — Noise reporting

**Priority** P1 · **Status** ❌ no noise report; counts by reason exist only as `routing_decisions` rows and the per-integration noise status (`GET /api/integrations/:id/noise-status`)

**Story** As a user, I want to know what I am being sent and what I am not, so that I can
tune rather than guess.

**Acceptance**
- [ ] Per-integration: events received, delivered, grouped, digested, suppressed, failed —
      each with a reason breakdown.
- [ ] A plain-language summary: *"You received 412 events. 14 were sent. 380 were grouped into
      digests. 18 were suppressed by your rules."*
- [ ] **Time spent tuning is itself a metric.** If a user visits settings more than N times
      without changing a preset, the onboarding has failed.
- [ ] Per-destination volume over time (F153).

**Design** — Competitors expose run history for debugging. Exposing *suppression* history is
what makes noise control feel honest — a user who cannot see what was filtered will assume it
was lost.

**Errors** — n/a.

**Security** — n/a.

**Tests** — `noise_report_accounts_for_every_received_event`;
`suppressed_events_report_a_reason_breakdown`.

**Deps** — F213.

---

## F165 — Grouping safety invariants

**Priority** P0 · **Status** 🟡 organization is first key component and held queries are organization-scoped; two-organization tests (`tests/noise/ingress.test.ts`, `tests/noise/release.test.ts`, ADR 0016); primary key is the delivery id, not `(organization, key)` · **Reliability, not feature**

**Story** As a security reviewer, I want grouping to be structurally incapable of crossing a
tenant boundary, so that a merge bug cannot become a data leak.

**Acceptance**
- [ ] `organization_id` is the **first component** of every grouping key (F141).
- [ ] The grouping store is tenant-scoped in its primary key, so even a key-construction bug
      cannot return another tenant's group.
- [ ] A test asserts that the same event under two organizations produces two independent
      groups with two independent messages.
- [ ] Merging is **never** retroactively applied: an already-sent message is never edited to
      include another organization's event.

**Design** — Grouping is the one place where an optimization can silently cross a security
boundary. It must be designed so the mistake is impossible rather than merely unlikely.

**Errors** — n/a.

**Security** — this is the security control for this domain.

**Tests**
- `grouping_is_structurally_tenant_scoped`
- `same_event_in_two_organizations_produces_two_messages`
- `sent_messages_are_never_edited_across_tenants`

**Deps** — F141, F24.

---

## F166 — Grouping observability

**Priority** P1 · **Status** 🟡 log lines only (`noise_release`, `noise_hold_capacity`, `noise_settings_unusable`) and a per-integration noise status; no metrics store or group metrics (ADR 0016)

**Acceptance**
- [ ] Metrics: group size distribution, time-to-first-delivery, digest size, suppression
      count by reason.
- [ ] A group that repeatedly fails to flush is visible.
- [ ] All metrics are tenant-scoped and sampled before storage (F191).

**Errors** — n/a.

**Security** — group keys are hashed; event content is not in metric dimensions.

**Tests** — `grouping_metrics_are_emitted_and_tenant_scoped`.

**Deps** — F141, F191.

---

## F167 — Anti-feature: no user-authored routing language

**Priority** P1 · **Status** ✅ filter schema is closed and rejects unknown or regex options (`src/routing/filter-input.ts`, `tests/routing/filter-input.test.ts`, ADR 0010); regex-dialect patterns are refused, regex-looking literals never match as a regex, and no `RegExp` is built in `src/routing/` (`tests/routing/no-regex.test.ts`); "No regex in filters" is a non-goal in `docs/ROADMAP.md` (ADR 0051) · **Deliberate non-feature**

**Story** As a maintainer, I want to refuse a feature request for user-authored routing rules,
so that we do not inherit Alertmanager's migration problem.

**Acceptance** — recorded as a non-goal in `docs/ROADMAP.md`:
- [ ] No expression language, no regex-in-routing UI, no "run this code" step.
- [ ] Filters operate on **named, typed fields** from the canonical envelope only.
- [ ] Zapier's own support disclaims arbitrary code steps; Alertmanager's matcher-parser
      migration is the cautionary tale for anyone who does add one.

**Design** — The line: a filter may compare a **field to a literal**. It may not compute.
Anything requiring computation is a product conversation, not a config change.

**Errors** — n/a.

**Security** — a typed filter surface cannot be turned into code execution.

**Tests** — `filter_config_schema_rejects_computed_expressions`.

**Deps** — F120.

---

## F168 — Noise tuning feedback

**Priority** P2 · **Status** ❌ no "too noisy" feedback control or tuning suggestions

**Story** As a product owner, I want to know which presets work, so that I can improve them
rather than guess.

**Acceptance**
- [ ] Per-preset adoption and retention (activation → first delivery → still active at 30 d).
- [ ] Presets that are frequently changed within a week are candidates for being wrong.
- [ ] ⚠️ **No claim is made about optimal defaults without evidence.** Presets are hypotheses
      until measured, per `AGENTS.md`'s ban on fabricated results.

**Errors** — n/a.

**Security** — aggregate only; no per-customer content in analytics.

**Tests** — `preset_metrics_are_aggregated_and_tenant_safe`.

**Deps** — F164, F191.