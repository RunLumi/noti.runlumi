# Competitive feature set — notification routing / notification infrastructure

Research date: **2026-10-13**. Sources are official documentation wherever possible. Anything I could
**not** verify from a first-party source is explicitly marked ⚠️ **UNVERIFIED**.

---

## 0. Source reliability notes (read this first)

| Tier | Meaning |
| --- | --- |
| **[1st]** | Official product documentation / official pricing page, fetched directly. |
| **[1st-vendor-blog]** | Vendor-authored but marketing/competitive content. Used only for pricing/claims, cross-checked. |
| **[3rd]** | Third-party mirror, community post, or news article. Flagged inline. |

**Things I could NOT verify and am therefore NOT claiming:**

*All 114 unique citation URLs were HTTP-checked on 2026-10-13; all resolve 200 except the WSJ link, which
is paywalled (401 to automated fetch). Where a URL could not be resolved I replaced it with a working
equivalent or removed it.*

- ⚠️ **IFTTT** — I did not find/verify current IFTTT docs for trigger/action/failure semantics in this pass.
  Nothing about IFTTT below should be relied on.
- ⚠️ **Jira automation** — I did not fetch Atlassian's automation docs this pass. No claims made.
- ⚠️ **Sentry "legacy" Issue Alert vs Metric Alert trigger table** (e.g. "issue is seen more than N times in
  M minutes") came from third-party doc mirrors (`getsentry-sentry.mintlify.app`, `sentrydocs.dev`), **not**
  from `docs.sentry.io`. Current official Sentry docs describe a unified "Alert Builder" with
  When/If/Then and "Throttling". Treat the old trigger-name list as historical.
- ⚠️ **Zapier flood protection threshold** ("100+ steps in one poll") came from a third-party help-centre
  mirror (`lawnprosoftware.com`), not `help.zapier.com`. I could not load the official Zapier page
  (404). The *existence* of flood protection is confirmed officially; the numeric threshold is not.
- ⚠️ **Knock Starter tier volume conflict**: `knock.app/pricing` says Starter $250/mo includes **50k**
  notifications; a Knock blog post says "Starter ($250/mo): 250K". The pricing page is treated as
  authoritative here; the blog figure is likely stale or a different metric.
- ⚠️ **Knock `SendWindow` object** appears in the Knock docs index (Object definitions → SendWindow) but
  I could not load its page (404). Do not claim a specific Knock quiet-hours API shape.
- ⚠️ **Novu "Digest Defaults" / "Throttle step" / "Severity and critical" pages** are published under
  `docs.novu.co/.mintlify/skills/...` — these are AI-agent-oriented skill references hosted on Novu's own
  docs domain, not hand-written product docs. Numbers are plausible and internally consistent, but treat
  as Novu-authored-but-not-editorially-reviewed.

---

## 1. Grouped feature inventory

### 1.1 Notification Infrastructure as a Service

#### Workflows / steps model

- **[Novu]** A workflow = trigger + sequence of **channel steps** (email, in-app, SMS, push, chat/Slack/MS
  Teams) + **action steps** (`delay`, `digest`, `custom`). Steps execute **independently** — "each step
  operates independently, meaning that if one step fails, others can still succeed." Built on a durable
  workflow engine. Supports a node-based Workflow Editor in the dashboard.
  <https://github.com/novuhq/docs/blob/main/content/docs/platform/concepts/workflows.mdx>
  <https://docs.novu.co/platform/concepts/workflows>
- **[Novu]** "Just-in-time data fetching": step bodies are JS closures that can call your DB/API at
  execution time, so subscriber data never has to be pre-stored.
  <https://docs.novu.co/framework/introduction>
- **[Novu]** Workflows can be triggered for an individual subscriber **or for an entire topic**
  (fan-out resolved at execution time from subscriber metadata).
  <https://github.com/novuhq/docs/blob/main/content/docs/platform/how-novu-works.mdx>
- **[Knock]** Workflows execute **for a single recipient at a time** and "evaluate recipient preferences
  automatically". Steps are `function` steps (delay, wait-for-event, batch, branch, experiment,
  trigger-workflow, throttle, fetch, agent, update-user/tenant/object/audience) or `channel` steps.
  Trigger sources: API call, **event**, audience entry, recipient **schedule**.
  <https://docs.knock.app/concepts/workflows> <https://docs.knock.app/concepts/overview>
- **[Knock]** Any workflow with an active delay/batch step can be **cancelled**, but only via the
  cancellation API and only when a `cancellation_key` was supplied on the trigger.
  <https://docs.knock.app/concepts/workflows>
- **[Courier]** Uses "journeys" + templates; templates referenced by opaque ID (`nt_...`); visual
  "Design Studio" drag-and-drop builder with reusable routing configurations and version history.
  <https://www.courier.com/docs/getting-started/quickstart> <https://www.courier.com/docs/reference/api-overview>
- **[SuprSend]** Workflow graph with nodes: Digest, Time Window, Delay, Wait Until, Fetch, Branch,
  Condition, Data Transform (JSONNET). <https://docs.suprsend.com/docs/digest>

#### Grouping / batching / digesting

- **[Novu]** `step.digest` supports **cron-based digests** (`{ cron: '0 0 * * *' }`) or a **look-back
  window + digest time** (`{ unit, amount, digestKey }`). Default digest key is `subscriberId`; a custom
  `digestKey` composes into `subscriberId + digestKey`.
  <https://docs.novu.co/framework/digest>
- **[Novu]** Digest key composition guidance (from Novu's own skills reference): `subscriberId` (default),
  `subscriberId + threadId` (conversational flows), `subscriberId + projectId`, `subscriberId +
  organizationId`. ⚠️ source is the skills reference — see §0.
  <https://docs.novu.co/.mintlify/skills/design-workflow/references/digest-defaults.md>
- **[Novu]** "Changing the step content after triggering the workflow with digest step will not affect the
  existing digested events." — i.e. **digest batches are frozen against the published workflow version**.
  <https://docs.novu.co/framework/digest>
- **[Novu]** "Currently, Novu does not support two digest steps in a workflow" — workaround is a second
  workflow triggered from a `custom` step. <https://docs.novu.co/framework/digest>
- **[Knock]** Batch step: groups per **recipient**; optional **batch key** partitions further (e.g.
  `page_id` → one batched notification per page, not one per user). Window rule configurable (fixed
  duration, absolute ISO-8601 datetime, or a **recurrence rule** e.g. "until Monday at 9am").
  Subsequent triggers are added as *activities* to the open batch and "their underlying workflow runs are
  terminated". A batch function always captures events per recipient.
  <https://docs.knock.app/designing-workflows/batch-function>
- **[Knock]** **Workflow version mode**: an open batch "stays open across workflow versions" by default;
  `latest` mode makes the continuation use the newest published version — explicitly recommended for
  digest-style batches "so a new workflow version does not open a second batch or send a duplicate
  notification". <https://docs.knock.app/designing-workflows/batch-function>
- **[Knock]** Recurring digests as a first-class feature: <https://docs.knock.app/concepts/workflows#recurring-digests>
  (index entry "Recurring digests: Learn how to build recurring, cross-channel digest notifications with Knock.")
- **[SuprSend]** Digest node is **schedule-driven, not first-event-driven**: "the Digest node operates on a
  fixed schedule rather than being relative to when the first event is received." One unique batch per
  recipient per workflow slug. Advanced knobs:
  - **Retain Items** (default first 10 triggers, configurable 2–100, first-N or last-N)
  - **Min Trigger Count** — "workflow will exit and the next steps will not be executed if the number of
    triggers is below this count… useful where you are sending individual alerts and also a digest at end
    of day; if only two alerts fire, sending a digest might be unnecessary."
  - Template vars `$batched_events[]` and `$batched_events_count` (docs also refer to
    `$batched_events_count`/`$batched_event_count` inconsistently ⚠️ — note the naming inconsistency).
  <https://docs.suprsend.com/docs/digest>
- **[SuprSend]** Digest schedule can be **dynamic per recipient**, derived from a user property or trigger
  data (`frequency`, `interval`, `weekdays`, `monthdays[{pos,day}]`, `time`, `dtstart`, `tz_selection:
  "recipient"`). Timezone falls back recipient → account → UTC. If the dynamic schedule is missing or
  invalid, "an error will be logged in workflow executions tab and further workflow execution will be
  skipped."
  <https://docs.suprsend.com/docs/digest>
- **[SuprSend]** Digest + Time Window interaction: triggers arriving *before* the window opens and
  *during* the batch window are accumulated together. Documented recipe: batch outside-office-hours events
  and send at next office start. <https://docs.suprsend.com/docs/time-window>
- **[Courier]** Digests are **preference-driven**: a recipient's digest schedule decides whether a send is
  delivered instantly or held. Held sends show a **`DIGESTED`** status in logs; at the scheduled time
  Courier renders `activity-digest` once with `{count, items}` per **category**. Events are filed under
  categories by matching top-level `data` keys.
  Sharp edge, documented: "An event whose `data` has no key matching a category is **not collected**. Courier
  delivers it immediately as an individual message, even though the recipient is on a digest schedule… There
  is no error and no warning." <https://www.courier.com/docs/platform/preferences/digests-setup>
- **[Courier]** Digest can be **released early** (`POST /digests/schedules/{id}/trigger`, 204 = ran).
  <https://www.courier.com/docs/platform/preferences/digests-setup>

#### Throttling / rate limiting / dedup windows

- **[Novu]** `throttle` step: "max 3 per hour per user", "max 1 per day for marketing", throttle by key
  (e.g. `payload.alertType`). Key distinction stated explicitly: **digest batches events into one message;
  throttle drops excess messages.** ⚠️ (skills reference) <https://docs.novu.co/.mintlify/skills/dashboard-workflows/references/throttle-step.md>
- **[Knock]** Throttle step: a **gate**. "if the threshold over the window has been exceeded, then the
  workflow stops execution." Always per recipient; optional throttle key resolves from `data` payload.
  Window can be fixed, relative, or a **window rule** on the recipient (`throttleWindow` JSON,
  e.g. `{frequency:"weekly", days:["mon"], hours:9}`).
  Limitations called out by Knock themselves: each step throttles independently; **you cannot throttle
  across Knock workflows**. <https://docs.knock.app/designing-workflows/throttle-function>
- **[Courier]** Message statuses include a first-class **`THROTTLED`** terminal state.
  <https://www.courier.com/docs/reference/api-overview>
- **[Prometheus Alertmanager]** Grouping + timing is the whole mechanism: `group_by` labels,
  `group_wait` (default 30s), `group_interval` (default 5m), `repeat_interval` (default 4h). Children
  inherit from parents.
  <https://prometheus.io/docs/alerting/latest/configuration/>
- **[Prometheus Alertmanager]** "If an alert is resolved before `group_wait` has elapsed, no notification
  will be sent for that alert. This reduces noise of flapping alerts." — **anti-flap is a first-class
  documented guarantee.** <https://prometheus.io/docs/alerting/latest/configuration/>
- **[Prometheus Alertmanager]** `repeat_interval` is "not repeated if any new alerts have fired or any
  firing alerts have resolved since the last `group_interval`"; if `repeat_interval > --data.retention`,
  the notification is repeated at the end of the data-retention period instead.
  <https://prometheus.io/docs/alerting/latest/configuration/>
- **[Sentry]** **Throttling** (previously "action interval"): "controls how often the Alert can run its
  actions for a given issue. If events in an issue match triggers repeatedly within the throttle window,
  the actions won't run again until the throttle period has elapsed." Options: every trigger (default), 5
  min, 10 min, 30 min, 60 min, 3 h, 12 h, 24 h, 1 week, 30 days.
  <https://docs.sentry.io/product/monitors-and-alerts/alerts/create-alerts/>
- **[PagerDuty]** `dedup_key` (≤255 chars) on Events API v2. "Submitting subsequent events with the same
  `dedup_key` will result in those events being applied to an open alert matching that `dedup_key`. Once
  the alert is resolved, any further events with the same `dedup_key` will create a new alert (for
  trigger events) **or be dropped (for acknowledge and resolve events)**." Also: subsequent events only
  apply if sent via the **same `routing_key`** as the original.
  <https://developer.pagerduty.com/docs/events-api-v2/trigger-events/index.html>
- **[PagerDuty]** Deduplication vs **suppression**: "Deduplication: Alerts with the same incident key are
  grouped into the same incident and do not generate multiple notifications. Suppression: Alerts matching
  the conditions defined in your Event Orchestrations are suppressed and stored in PagerDuty for
  forensics… suppressed alerts do not create incidents. You can view suppressed alerts in the Alerts
  table." <https://support.pagerduty.com/main/docs/event-management>
- **[PagerDuty]** Email integration uses the **email subject as the default deduplication key**.
  <https://support.pagerduty.com/main/docs/event-orchestration>
- **[FireHydrant]** `idempotency_key` (≤255 chars) on every signal; configurable dedup window per signal
  rule: 5 min / 15 / 30 min / 1 h / 2 / 3 / 6 / 12 / **24 h (default)**. Duplicates increment an **alert
  count** instead of creating new alerts. A background job runs **every 5 minutes** to expire windows.
  <https://docs.firehydrant.com/docs/alert-deduplication>
- **[incident.io]** Dedup: "if alert A is received with a deduplication key 'x' and alert B with the same
  deduplication key is received while alert A is still active (in a firing state and not resolved), no new
  alert will be created". Resolving with the same key resolves the active alert.
  <https://docs.incident.io/alerts/deduplication>
- **[Grafana OnCall]** "Threshold-based escalation: Escalate only if a certain number of alerts occur
  within a specific time frame." — in-band volume throttle as an escalation step.
  <https://grafana.com/docs/oncall/latest/configure/escalation-chains-and-routes/>
- **[Zapier]** "Holding" run status is a **flood-protection** mechanism, not an error: "too many (100+)
  steps were triggered in the Zap run in a single poll… helps keep your task usage down and prevents
  tedious work correcting unintended tasks." Held runs require manual replay (⚠️ the 100+ number is from a
  third-party mirror; the mechanism is official). <https://help.zapier.com/hc/en-us/articles/8496037690637-How-to-troubleshoot-errors-in-Zap-workflows>
- **[Firebase FCM]** Topic messaging is explicitly **throughput-optimised, not latency-optimised**. Hard
  limits: one app instance ≤ **2000 topics**; batch subscribe ≤ 1000 app instances; topic
  subscribe/unsubscribe limited to **3000 QPS per project**; "If you send too many subscription requests
  in a short period, FCM servers will respond with a 429 `RESOURCE_EXHAUSTED` ('QUOTA_EXCEEDED'). Retry
  with exponential backoff." <https://firebase.google.com/docs/cloud-messaging/topic-messaging>

#### Quiet hours / delivery windows / preference models

- **[Prometheus Alertmanager]** `time_intervals` with `times`, `weekdays`, `days_of_month`, `months`,
  `years`, `location` (IANA TZ). Ranges inclusive-of-start/exclusive-of-end. Negative day indices
  (`-3:-1`) supported. Applied to routes via `mute_time_intervals` **and** `active_time_intervals` — the
  same interval definition can *mute* one route and *activate* another (the canonical "business hours vs
  on-call" pattern). Root node cannot have mute/active times.
  <https://prometheus.io/docs/alerting/latest/configuration/>
- **[SuprSend]** Time Window node: days (every day / weekdays / selected weekdays / selected days of
  month) + time range + timezone (`recipient` or fixed). "Introduces a wait until the time window starts
  and all subsequent steps in the workflow will be delayed by the same time." Multiple windows OR'd.
  Timezone changes mid-wait are **recalculated**. Cites TCPA-style compliance rules (promotional SMS/
  WhatsApp within 9am–8pm local). <https://docs.suprsend.com/docs/time-window>
- **[Novu]** Subscriber **Schedule** feature in the Inbox: per-day on/off + per-day time range, in the
  subscriber's auto-detected local timezone. "If a day is toggled off, then the subscriber will not receive
  any **non-critical** notifications for that entire day." Applies to email, SMS, push. Can be hidden from
  the Inbox UI. <https://docs.novu.co/platform/inbox/features/schedule>
- **[Novu]** **Snooze** (Inbox, cloud-only, SDK ≥ 3.3.0): presets ("an hour from now", "tomorrow") or a
  custom datetime; min 3 minutes ahead; max duration by plan (Free 24 h, Pro/Team 90 d, Enterprise
  default 90 d). Snoozed notifications can't be read/unread/archived during the snooze.
  Manual unsnooze restores prior read state; timer-expiry unsnooze re-delivers as a **new unread item**.
  <https://docs.novu.co/platform/inbox/features/snooze>
- **[Novu]** Three-level preference precedence, explicitly documented:
  1. Workflow channel preferences (workflow-level defaults)
  2. Subscriber channel preferences per workflow
  3. Subscriber global preferences
  And a **critical** escape hatch: "the notification sent from that workflow must always be delivered to the
  subscribers regardless of their personal preferences and they cannot change their preferences for this
  workflow." Severity levels: High = "Critical notifications that require immediate attention" /
  Medium / Low / None. <https://github.com/novuhq/docs/blob/main/content/docs/platform/concepts/preferences.mdx>
  <https://docs.novu.co/platform/workflow/configure-workflow>
- **[Novu]** Digest step is **auto-skipped** when `severity: HIGH` or `critical: true`; also auto-skipped
  when `subscriber_id` preference for the channel is false. ⚠️ (skills reference)
  <https://docs.novu.co/.mintlify/skills/design-workflow/references/digest-defaults.md>
- **[Knock]** PreferenceSet = JSON opt-out object over **channels, categories, workflows**. Merge hierarchy:
  recipient > tenant > environment > default. Rules: unset ⇒ `true` (opt-in by default); a workflow can
  belong to **multiple categories** and **one false category is enough to block**; a false `category`
  blocks even if `channel_type` is true; a per-recipient preference can be overridden inline on trigger.
  <https://docs.knock.app/preferences/overview>
- **[Knock]** **"Override recipient preferences"** toggle per workflow — required for password-reset-style
  transactional mail. Changing it is a committed change. <https://docs.knock.app/preferences/overview>
- **[Courier]** Preferences are topic-based; "An opted-out topic blocks the send, and a user who picked
  their own channels for a topic gets those channels instead" — recipient prefs apply **on top of**
  routing. <https://www.courier.com/docs/send/routing>
- **[Sentry]** Per-user notification settings: Alerts, Issue Workflow, Deploys, Nudges, Spend, Weekly
  Reports, Email Routing, Spike Protection, My Own Activity, Resolve-and-Auto-Assign. Per-type toggle +
  channel choice (email / Slack / both). Subscription is implicit from behaviour (bell icon, commit
  authorship, comment, bookmark, archive-until-escalates, mention, assignment) — overlapping with alerts.
  <https://docs.sentry.io/product/notifications/notification-settings/>
- **[GitHub]** Subscription is **auto-granted** on: assignment, opening, commenting, manual Watch/Subscribe,
  being @mentioned, changing thread state, team @mention, joining a team. Watch settings per repo:
  Custom (issues / PRs / releases / security alerts / discussions) or **Ignore** entirely.
  <https://docs.github.com/en/subscriptions-and-notifications/concepts/about-notifications>
  <https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications>
- **[GitHub]** GitHub Mobile supports **custom working hours** for push notifications (iOS and Android).
  <https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications>
- **[GitHub]** Inbox shows the **`reasons` label** for why you were notified (`mention`, `subscribed`,
  `review requested`, `assign`, `author`, `comment`, …), filterable via `reason:` queries.
  <https://docs.github.com/en/subscriptions-and-notifications/concepts/about-notifications>
- **[GitHub]** GitHub-in-Slack `/github subscribe|unsubscribe OWNER/REPO [EVENT]` including **label
  filters** (`+label:"bug"`), and `/github workflows` for Actions run notifications with **in-thread
  approval replies**. Max **one required label filter per repository.**
  <https://docs.github.com/en/integrations/how-tos/slack/customize-notifications>
- **[Linear]** Notifications grouped by **category** ("the status-changes category includes issue
  completions and cancelations, urgent-priority changes, and changes to blocking relationships. You cannot
  select only status changes."). Real-time for desktop/mobile/Slack; **email digests delayed by urgency**
  and "only sent if you haven't already read the Linear inbox notification". Immediate email override for
  urgent/SLA-breaching issues, and "delay low priority emails outside for work hours until the next day.
  Work hours are defined as 8 am – 6 pm in your timezone." Inbox retains **2,000** open notifications,
  auto-archiving beyond. <https://linear.app/docs/notifications>
- **[Linear]** **Pulse**: workspace-level summary cadence (weekly Mondays / every weekday / never) as a
  **default**; user customisations override. Delivered ~06:00 local. Available on all plans but not for
  Guests. <https://linear.app/docs/pulse>
- **[OneSignal]** `delayed_option=timezone` with `delivery_time_of_day` (e.g. `"9:00AM"`, `"21:45"`) delivers
  at that local time-of-day per user, **rolling to the next day** if it has already passed.
  `delayed_option=last-active` ("Intelligent Delivery") delivers at the user's habitual time of day based
  on a 3-month view pattern. ⚠️ (API model docs, onesignal-php-api — vendor-authored) plus a
  [product-demo transcript](https://onesignal.com/webinars/product-demo).
- **[OneSignal]** Subscription status is **per channel per device**; a Mobile Subscription unsubscribed
  from push can still get in-app messages. Unsubscribe detection is **gradual and lossy**: notification 1
  delivered, 2 delivered-but-not-received, 3 shows "Unsubscribed" on Android/web, iOS lags further,
  notification 4 not sent. "If you go long periods without sending to all users, unsubscribes accumulate
  silently and appear as a large spike when you resume sending." → *use event streams to detect
  unsubscribes*. <https://documentation.onesignal.com/docs/en/subscriptions>

#### Escalation policies / routing trees

- **[Prometheus Alertmanager]** The canonical routing tree. `matchers` (`=`, `!=`, `=~`, `!~`), `continue`
  (false by default) for fan-out to sibling routes, per-route `group_by` / `group_wait` /
  `group_interval` / `repeat_interval` / `mute_time_intervals` / `active_time_intervals`, child inheritance.
  A **visual editor** is linked from the config page for building routing trees.
  <https://prometheus.io/docs/alerting/latest/configuration>
- **[Prometheus Alertmanager]** `route.labels`: a set of template-able labels attached to a route and
  inherited/overridden parent→child, exposed to templates via `routeLabels "name"`. **Explicitly distinct
  from `group_by`** ("route labels do not affect how alerts are grouped"). Rendered per alert group, and
  `.NotificationReason` is always `"unknown"` in route-label templates.
  <https://prometheus.io/docs/alerting/latest/configuration>
- **[Prometheus Alertmanager]** `inhibit_rules`: source matchers + target matchers + `equal: [labels]`.
  Self-inhibition is guarded: "an alert that matches both the target and the source side of a rule cannot
  be inhibited by alerts for which the same is true (including itself)". Docs warn the `equal` semantics
  are a footgun: "if all the label names listed in `equal` are missing from both the source and target
  alerts, the inhibition rule will apply."
  <https://prometheus.io/docs/alerting/latest/configuration> <https://pkg.go.dev/github.com/prometheus/alertmanager@v0.34.1>
- **[Prometheus Alertmanager]** `resolve_timeout` (default 5m): if an alert has no `EndsAt`, declare it
  resolved after this. <https://prometheus.io/docs/alerting/latest/configuration>
- **[Prometheus Alertmanager]** Receivers today include `incidentio_configs` and `msteamsv2_configs`
  alongside Slack/Discord/email/Jira/Opsgenie/PagerDuty/Rocketchat/Telegram/VictorOps/Webex/
  Mattermost/WeChat/Pushover/SNS/webhook.
  <https://prometheus.io/docs/alerting/latest/configuration>
- **[Prometheus Alertmanager]** Team deprecation policy for new receivers: "new notification integrations
  will be required to have a committed maintainer with push access."
  <https://prometheus.io/docs/alerting/latest/configuration>
- **[Grafana OnCall]** Routes use **Jinja2 routing templates** that must evaluate truthy; **the first
  matching route wins**, ordered by explicit up/down arrows. Cloud-only label-based routing via a
  `labels` variable alongside `payload`.
  <https://grafana.com/docs/oncall/latest/configure/escalation-chains-and-routes/>
- **[Grafana OnCall]** Escalation step types: `wait`, `notify_persons`, `notify_person_next_each_time`
  (round-robin), `notify_on_call_from_schedule`, `notify_user_group`, `notify_team_members`,
  `notify_whole_channel`, `trigger_webhook`, `resolve`, `notify_if_time_from_to`, `declare_incident`.
  `important: true` promotes to the user's "Important" personal notification rules.
  Wait duration valid range **60–86400 seconds**. Repeat escalation capped at **5**.
  <https://grafana.com/docs/oncall/latest/configure/escalation-chains-and-routes/>
  <https://grafana.com/docs/oncall/latest/oncall-api-reference/escalation_policies>
- **[Grafana Cloud]** Canonical chain shape published as best practice:
  `notify on-call → wait 5m → notify on-call (important) → wait 10m → notify backup schedule`, and every
  chain should end in a terminal step (`Resolve`, `Notify all`, `Repeat`).
  <https://grafana.com/docs/grafana-cloud/observe-and-act/respond-to-incidents/irm/guides/best-practices/escalation-chains>
- **[Grafana OnCall]** Slack-channel-member / user-group steps "notify OnCall-registered users via their
  configured notification rules… To avoid spamming a Slack channel with alert group notifications,
  notifications are not sent in the alert group Slack thread." — deliberate threading-vs-noise decision.
  <https://grafana.com/docs/oncall/latest/configure/escalation-chains-and-routes/>
- **[Grafana OnCall]** Team ownership: "Alert groups inherit the team from the **integration**, not the
  escalation chain." <https://grafana.com/docs/oncall/latest/configure/escalation-chains-and-routes/>
- **[incident.io]** Escalation paths are deliberately kept simple — "escalation paths aren't just used for
  alerts — they're also used if you ever want to manually escalate to that team" — so they branch only on
  **priority and working hours**; everything else (service, environment, team, severity) is normalised into
  **alert attributes** at the alert-source layer. Priorities are org-wide shared objects (add/rename/
  reorder/remove) and are editable via an **expression evaluated against live payloads**, with an alert
  preview pane showing real payloads. <https://docs.incident.io/alerts/priority-routing>
- **[incident.io]** Escalations can target a specific path, a user, or a **query-based expression** to pick
  the path dynamically; multiple escalation rules can be stacked. Auto-cancel escalation on resolve
  ("useful for flappy alert sources"). Priority-increase on an already-escalated alert **triggers a new
  escalation**.
  <https://docs.incident.io/alerts/escalations-from-alerts>
- **[Sentry]** Alert Builder is **When / If / Then** with **multiple independent If/Then blocks** against
  the same triggers: "route different event shapes to different places from a single Alert — for example,
  create a Jira ticket or Slack notification for every new issue, but only page on-call when the issue is
  high priority." Triggers use **ANY** logic; each trigger addable once.
  <https://docs.sentry.io/product/monitors-and-alerts/alerts/create-alerts/>
- **[Sentry]** `If` filters use a single qualifier per block — **all / any / none**. Frequency and event
  attribute filters only work with the *new issue* and *event captured* triggers (the builder shows a
  warning icon otherwise — a nice **capability-aware UI** pattern).
  <https://docs.sentry.io/product/monitors-and-alerts/alerts/create-alerts/>
- **[Sentry]** Frequency filters have two modes: absolute (**more than N in 5 min/15 min/1 h/1 d/1 w/30 d**)
  and relative (**relatively higher than… X% vs N minutes ago / 1 hour ago / …**). Sub-filters
  (`[Attribute] is/is not [value]`, AND-combined) scope the count.
  <https://docs.sentry.io/product/monitors-and-alerts/alerts/create-alerts/>
- **[Sentry]** Org-level ceilings on the number of alerts, with a **lower per-project ceiling for
  expensive windowed rules** ("Alerts that count events over a time window… get a lower per-project ceiling
  than other Alerts because they're more expensive to evaluate"), and the documented remedy: "consolidate
  several narrow Alerts into one Alert with broader filters and multiple If/Then blocks."
  <https://docs.sentry.io/product/monitors-and-alerts/alerts/create-alerts/>

#### Templates and per-channel rendering

- **[Prometheus Alertmanager]** Go `text/template` + `html/template` (with `safeHtml`/`safeUrl`).
  `Data` exposes `Receiver`, `Status` ("firing if at least one alert is firing, otherwise resolved"),
  `Alerts`, `GroupLabels`, `CommonLabels`, `CommonAnnotations`, `RouteLabels`, `ExternalURL`;
  `Alerts.Firing` / `Alerts.Resolved` filter helpers; `Alert` exposes `Status`, `Labels`, `Annotations`,
  `StartsAt`, `EndsAt`, `GeneratorURL`, `Fingerprint`. Built-in funcs: `match`, `reReplaceAll`, `humanizeDuration`,
  `title`, `toJson`, `tz`, `routeLabels`, … <https://prometheus.io/docs/alerting/latest/notifications/>
- **[Prometheus Alertmanager]** Per-receiver template defaults (`title`, `message`, `content` for Discord;
  `html`/`text` for email), `send_resolved` flag **per integration** (default `true` for chat, **`false`
  for email**), and Slack-specific controls (`channel`, `username`, `icon_emoji`, `title_link`,
  `shorten`, `callback_id` for Slack actions). `<https://prometheus.io/docs/alerting/latest/configuration>`
- **[Prometheus Alertmanager]** Email threading: `threading.enabled` + `thread_by_date: daily|none`, so
  all alerts in a group land in one email thread. Same page.
- **[Prometheus Alertmanager]** Mattermost only: `props.card` (RHS panel) and `priority` + `requested_ack`
  + `persistent_notifications` (re-notify every 5 min until acknowledged) — **Enterprise-only** in
  Mattermost. Same page.
- **[Prometheus Alertmanager]** `msteams_configs` carries an explicit deprecation notice pointing at
  Workflows / `msteamsv2_configs`. Same page. Corroborated by Microsoft: "Microsoft 365 Connectors
  (previously called Office 365 Connectors) are nearing deprecation, and the creation of new Microsoft 365
  Connectors will soon be blocked" <https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/connectors-using>,
  and the Microsoft Dev Blog "Retirement of Office 365 connectors within Microsoft Teams" (updated
  2026-04-14) <https://devblogs.microsoft.com/microsoft365dev/retirement-of-office-365-connectors-within-microsoft-teams>.
- **[Grafana OnCall]** Jinja2 templates are **two kinds**: *rendering* templates (per channel: Web, Slack,
  MS Teams, Telegram, SMS, Phone Call, Email, Push) and *behavioural* templates — **Grouping Id**, **Auto
  resolution**, **Auto acknowledge** — plus per-integration overrides. For Alertmanager/Grafana sources the
  default grouping template is `{{ payload.groupKey }}` and Grafana explicitly warns: "Don't change the
  Grouping Id template… Changing the Grouping Id template causes IRM to apply status updates to the wrong
  alert group, which breaks auto-resolution." (Grouping must be configured **at the source**.)
  <https://grafana.com/docs/oncall/latest/configure/jinja2-templating>
  <https://grafana.com/docs/grafana-cloud/observe-and-act/respond-to-incidents/escalation-and-routing/alert-grouping>
- **[Grafana OnCall]** Jinja2 helper functions shipped by Grafana: `time`, `tojson`, `tojson_pretty`,
  `iso8601_to_time`, `datetimeformat`, `datetimeformat_as_timezone`, `datetimeparse`, `timedeltaparse`,
  `timestamp_to_datetime`. <https://grafana.com/docs/oncall/latest/configure/jinja2-templating/advanced-templates>
- **[Grafana Alerting]** Default grouping is by `alertname` + `grafana_folder` (because rule names aren't
  unique across folders). Group wait default 30 s; max repeat interval 5 days, bounded by
  `notification_log_retention`.
  <https://grafana.com/docs/grafana/latest/alerting/fundamentals/notifications/group-alert-notifications>
- **[Courier]** Routing is **two decisions**: (a) channels from the routing object's `channels` list, (b)
  providers within each channel in priority order. `method: "single"` means everything after the first
  option is a backup; default workspace routing is `{method:"single", channels:["email"]}`. Failover
  happens at **both** levels (channel and provider). Routing lives in a reusable **routing strategy**
  attached to templates by ID, or inline per send.
  <https://www.courier.com/docs/send/routing>
- **[Courier]** Failure classification is per-channel *and* per-class: "If the entire channel fails, such as
  when the user has no email address, Courier moves to the next channel in priority order."
  <https://www.courier.com/docs/platform/sending/sending-overview>
- **[Novu]** Each channel step carries its **own** template with a channel-specific editor and LiquidJS
  variables. <https://docs.novu.co/platform/workflow/template-editor>
- **[SuprSend]** Handlebars templates; a **Mock data / "Enable batching"** toggle in the template editor
  pre-populates `$batched_events` with mock items and an `Event Count` so authors can see digest output
  without waiting. <https://docs.suprsend.com/docs/digest>
- **[Knock]** Liquid templates + per-channel templates, plus an i18n `t` filter with tenant-scoped
  translations. <https://docs.knock.app/concepts/overview>

#### Run history / error classification / retry / dead-letter / replay

- **[Courier]** Message statuses (from `GET /messages/{id}`): `ENQUEUED, ROUTED, SENT, DELIVERED, OPENED,
  CLICKED, DELAYED, DIGESTED, THROTTLED, FILTERED, CANCELED, SIMULATED` + 3 failure states. Critically:
  "A 202 from [send] means Courier accepted the request, not that the message was delivered."
  <https://www.courier.com/docs/reference/api-overview>
- **[Courier]** Provider-429 backoff ladder: 5s, 10s, 20s, 40s, 60s, 2m, 4m, 8m, 12m, then 15m per attempt
  thereafter; "Retries continue for up to 24 hours (**approximately 104 total attempts**)"; a provider
  `Retry-After` header overrides the ladder; "After retries are exhausted, Courier attempts failover to
  another configured provider or channel. With no alternative, the message is marked `UNDELIVERABLE`."
  <https://www.courier.com/integrations/overview>
- **[Courier]** Outbound webhooks for every status change. <https://www.courier.com/docs/overview>
- **[Knock]** **Workflow recipient runs** API with rich filtering: `status`, `tenant`, `has_errors`,
  `recipient`, `starting_at`, `ending_at`, `workflow`. Run object carries `error_count`,
  `trigger_source.cancellation_key`, `inserted_at`/`updated_at`. Responses are tagged
  **"Retention policy applied"**. <https://docs.knock.app/api-reference/workflow_recipient_runs>
- **[Knock]** **List delivery logs / list activities / get message content** as first-class endpoints.
  <https://docs.knock.app/>
- **[Knock]** Error envelope is `{code, message, status, type}` with guidance to "branch on `code`… use
  `type` to group codes into a category. The `message` may change… so don't match on it."
  <https://docs.knock.app/api-reference/overview>
- **[Novu]** Activity Feed per workflow execution step, "real-time visibility into each step"; retention
  is a **priced tier**: Free = 24 h, Pro = 7 days, Team = 90 days, Enterprise = custom.
  <https://docs.novu.co/platform/concepts/workflows> <https://novu.co/pricing>
- **[Make]** **Incomplete executions** = a manual dead-letter queue. Statuses: `Unresolved`, `Pending`
  (retry scheduled), `In progress`, `Resolved` (auto-deleted after **30 days**), plus a `Scheduled in`
  countdown column. Retry reruns "with the same configuration as when the error happened" (good for
  transient `ConnectionError`/`RateLimitError`); config errors need manual resolution. Make also exposes
  an **API** (`POST /dlqs` retry) for it. <https://help.make.com/manage-incomplete-executions>
  <https://developers.make.com/api-documentation/api-reference/incomplete-executions>
- **[Make]** Five error handlers with different terminal states: **Ignore** (run continues, scenario
  status Success), **Break**, **Resume** (substitute output, continues), **Retry** (removes bundle, stores
  incomplete execution, rest of scenario continues), **Commit** (stop, commit DB changes, status
  Warning), **Rollback** (default when nothing is set — stop, revert transactional modules, status
  Error, scenario deactivated after repeated errors). <https://help.make.com/Overview-of-error-handling>
- **[Make]** Honest limitation surfaced in docs: Rollback/Commit "cannot undo actions made by modules that
  don't support transactions, like gmail > send an email or dropbox > delete a file."
  <https://help.make.com/rollback-error-handler>
- **[n8n]** Per-node **Retry On Fail**, and `On Error: Stop Workflow` vs `Continue` ("Proceeds to the next
  node despite the error, using the last valid data"). **Error Workflow** (must start with Error Trigger)
  fired on failure; `Stop And Error` node to force failures.
  <https://docs.n8n.io/build/understand-workflows/workflow-components/work-with-nodes>
  <https://docs.n8n.io/build/flow-logic/handle-errors-gracefully>
- **[n8n]** Error payload to the error workflow includes `execution.id`, `execution.url`,
  `execution.retryOf`, `execution.error.{message,stack}`, `lastNodeExecuted`, `mode` — and a different,
  thinner shape when the **trigger node itself** fails (more in `trigger{}`, less in `execution{}`).
  <https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.errortrigger>
- **[n8n]** Retry semantics: "**Retry with currently saved workflow**" (replay old execution data through
  the *new* workflow) vs "**Retry with original workflow**" (replay through the *old* version).
  <https://docs.n8n.io/build/understand-workflows/understand-executions>
- **[n8n]** Execution data retention is configurable — `EXECUTIONS_DATA_SAVE_ON_ERROR=all` etc.; per-workflow
  `Save execution data` toggle (Save/None/"Save successful") with the explicit trade-off: "If set to Save,
  the workflow resumes from where it stopped in case of an error. **This may increase latency.**"
  <https://github.com/n8n-io/n8n-docs/blob/main/docs/deploy/host-n8n/configure-n8n/scaling/manage-execution-data.md>
  <https://docs.n8n.io/build/manage-workflows/configure-workflow-settings>
- **[n8n]** **`redactionPolicy`**: `none | non-manual | manual-only | all` — control over which execution
  data is persisted. <https://docs.n8n.io/connect/n8n-api/workflow>
- **[Zapier]** **Eleven run statuses**: Success, Filtered, Errored, Safely halted, On hold, Handled error,
  Scheduled, Waiting, Playing, Stopped, Holding (⚠️ exact list is from the official troubleshooting article
  plus a third-party mirror — the official article confirms Errored / Safely halted / On hold / Handled
  error / Scheduled). Semantics worth copying: **"Safely halted" (filter matched nothing) does NOT turn the
  Zap off**, only **Errored** does. <https://help.zapier.com/hc/en-us/articles/8496037690637-How-to-troubleshoot-errors-in-Zap-workflows>
- **[Zapier]** Auto-circuit-breaker: "Your Zap will automatically turn off if **95% of its runs result in
  errors in the last 7 days**." Team/Enterprise accounts get an email to the account owner plus a grace
  period before auto-off. Same URL.
- **[Zapier]** **Replay is step-scoped, not run-scoped**: "if the Zap triggers and successfully sends the
  email, but fails to add the spreadsheet row, when you replay the Zap, Zapier will: **Not** replay the
  trigger. **Not** replay the email step. Attempt to add a spreadsheet row again." Autoreplay attempts up
  to **5 times**; no error emails until the final attempt fails. <https://help.zapier.com/hc/en-us/articles/19220226086797-What-is-replay>
- **[Zapier]** Replay constraints: Filter and Paths steps are **never** replayed; must replay within **60
  days**; needs remaining task quota; blocked if you add/delete/reorder steps or change app/trigger/action
  (upgrading the same app to a comparable version is fine). Autoreplay does not replay "on hold" runs.
  Same URL.
- **[Zapier]** **Full Zap version pinning** in run history: "you can find the specific version number and
  version name used for that run… search for runs that used a specific Zap version (e.g. 'v3')". Replayed
  runs get an explicit replay icon and links to related replays.
  <https://help.zapier.com/hc/en-us/articles/8496291148685-View-and-manage-your-Zap-history>
- **[Zapier]** **AI-generated troubleshooting**: "Click the errored step, then the Troubleshoot tab. Zapier
  will use AI to create troubleshooting instructions for you." Same URL.
- **[PagerDuty]** Event Analytics dashboard includes a long explicit list of what is analysed, including
  **"Events sent to deleted routing keys — these do receive a 2XX response for security reasons"** and
  **"Events sent to a service in maintenance mode"** / "to a disabled service". Filterable by Team,
  Routing key, Integration, Service; "Events Breakdown" table sorted by Total Events descending.
  <https://docs.pagerduty.com/incident-management/analytics/event-analytics>

#### Idempotency and duplicate-suppression UX

- **[Knock]** `Idempotency-Key` header, ≤255 chars, **24-hour** window. Semantic key suggestion:
  `order-placed:user-123:order-456`; "If your user then cancels the order, use
  `order-cancelled:user-123:order-456`. This will ensure each type of notification is only sent once."
  Job IDs are a good choice. Only caches `2xx` (so a failed call with the same key will re-execute);
  mismatched params on replay return an error; replay responses carry `original-x-request-id` and
  `idempotent-replayed: true`. **Only `POST /workflows/:key/trigger` supports it today.**
  <https://docs.knock.app/api-reference/overview>
- **[Courier]** `Idempotency-Key` on any POST. Replays the original response **even if it was an error**.
  Keys expire after **24 hours**, extendable via `x-idempotency-expiration` up to **one year**.
  <https://www.courier.com/docs/reference/api-overview>
- **[incident.io]** Rate limit **120 events/minute per alert source**, HTTP 429 on exceed, plus
  org-level limits. <https://docs.incident.io/incidents/auto-create> <https://docs.incident.io/alerts/alert-sources>
- **[Courier]** Payload cap **6 MB** for all endpoints (413 beyond); base64 inflates ~33%. Endpoint rate
  limits (e.g. POST subscriptions 20/min, PUT brands 200/min). <https://www.courier.com/docs/reference>
- **[Zapier]** Webhook limits: **10 MB triggers, 5 MB actions**, 413 beyond.
  <https://help.zapier.com/hc/en-us/articles/8496291737485-Troubleshoot-webhooks-in-Zapier>
- **[Firebase FCM]** TTL default 259,200 s (3 days), max 2,419,200 s (28 days); priority `normal` vs
  `high`; "Messages sent with high priority are rejected by the FCM backend with the error
  `INVALID_ARGUMENT`" for Apple data messages unless `apns-priority: 5`.
  <https://firebase.google.com/docs/cloud-messaging/customize-messages/setting-message-priority>

#### Onboarding / setup wizard / validation

- **[Sentry]** **"Send Test Notification"** button on **each If/Then block** individually — "This verifies
  that your integrations are wired up correctly before you save" — with the honest caveat "event based
  triggers may behave differently."
  <https://docs.sentry.io/product/monitors-and-alerts/alerts/create-alerts/>
- **[Sentry]** Auto-generated alert name from the configuration ("Frontend high priority to
  #frontend-oncall" style), editable in the header.
  <https://docs.sentry.io/product/monitors-and-alerts/alerts/create-alerts/>
- **[Sentry]** Alert details page shows "a high level chart of how often the Alert has run, a list of the
  most recent runs, the configuration, and connected monitors."
  <https://docs.sentry.io/product/monitors-and-alerts/>
- **[Grafana OnCall]** **"Send demo alert"** button on the Integrations tab lets you review and modify
  the payload before sending; the get-started flow then walks Send demo alert → see it firing → Acknowledge
  → Resolve. <https://grafana.com/docs/oncall/latest/set-up/get-started>
- **[incident.io]** **Alert preview** pane in the source config shows real payloads and marks which
  recent alerts your filter expressions would have dropped ("Check the alert preview, which marks the
  recent alerts your conditions would have dropped, then click Save").
  <https://docs.incident.io/alerts/alert-sources> <https://docs.incident.io/alerts/priority-routing>
- **[incident.io]** Filter incoming alerts at the **source**, before alerts exist: "Any alert source can be
  set to only ingest alerts that match conditions you define, so noisy or irrelevant events are dropped
  before they create alerts, trigger escalations, or page anyone." Same URL as alert-sources.
- **[SuprSend]** Template editor "Mock data" with batching toggle. <https://docs.suprsend.com/docs/digest>
- **[GitHub]** Secret token + documented test vector: `secret: "It's a Secret to Everybody"`, `payload:
  "Hello, World!"` ⇒ `X-Hub-Signature-256: sha256=757107ea...`. Explicit "Never use a plain `==` operator…
  use `crypto.timingSafeEqual`". Also: "If you use a proxy or load balancer, make sure that the proxy or
  load balancer does not modify the payload or headers."
  <https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries>

#### Analytics / observability / SLIs

- **[incident.io]** **Alerts Insights**: trends grouped by any attribute; "Top offending alerts, sortable by
  count, number of pages, and number of incidents created"; **Acceptance rates**; **Decline rates** — "a
  core metric in reducing alert fatigue… give a hit list of alerts to kill or tune. If you see an alert
  that's declined 90% of the time, it's not just noise, it's someone actively telling you 'this isn't
  useful.'" Also tracks post-fire behaviour: acknowledged? escalated? declined? time-to-resolve.
  <https://incident.io/blog/how-incident-io-helps-to-reduce-alert-noise> ⚠️ vendor blog.
- **[Courier]** "Analytics track delivery, open, and click rates **per template, journey, and broadcast**";
  "Provider metrics. Delivery rates, latency, and error rates per provider appear in the Analytics
  dashboard." <https://www.courier.com/docs/overview> <https://www.courier.com/integrations/overview>
- **[Grafana Alerting]** Retention coupling: max repeat interval (5 days) is constrained by
  `notification_log_retention`. <https://grafana.com/docs/grafana/latest/alerting/fundamentals/notifications/group-alert-notifications>
- **[FireHydrant]** Backstage plugin surfaces `healthiness`, `total time impacted`, `total incidents`,
  and **MTTD / MTTA / MTTM / MTTR** from the trailing 30 days. <https://backstage.io/docs/features/software-catalog/software-catalog-api/>

#### Multi-tenancy / RBAC / audit / SSO / retention

- **[Novu]** RBAC, audit logs, MFA, Google/GitHub SSO start at **Team ($250)**; custom SAML/OIDC SSO, SCIM
  directory sync, custom retention (feed/audit/logs), custom delay & digest windows, HIPAA BAA and SG/UK/
  AU/JP/KR residency are **Enterprise**; standard SSO is 99.9% uptime SLA from **Pro** onward.
  <https://novu.co/pricing>
- **[Knock]** Built-in multi-tenancy and Google SSO on the **free Developer tier**; audit logs, custom
  SSO (Okta/AD/SAML/OIDC), SCIM, uptime SLA at Enterprise. Tenants carry their own branding/preferences/
  routing. <https://knock.app/pricing> <https://www.courier.com/docs/overview> (tenancy)
- **[Courier]** Tenants "scope branding, routing, and preferences per customer or workspace".
  <https://www.courier.com/docs/overview>
- **[SuprSend]** Digest schedule can be stored as a **tenant property** for enterprise-level notification
  preferences ("If you are sending notification on behalf of your enterprise customers, digest schedule can
  also come from enterprise level notification preferences… store the schedule as custom property in
  tenant settings"). <https://docs.suprsend.com/docs/digest>
- **[Grafana OnCall]** API permissions are scoped per resource:
  `grafana-oncall-app.escalation-chains:read/write` etc. Teams own escalation chains; alert groups inherit
  the integration's team. <https://grafana.com/docs/oncall/latest/oncall-api-reference/escalation_policies>
- **[GitHub]** Email notifications can be restricted to a verified **domain** per org; repo-level email
  routing; 10,000-repo watch cap.
  <https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications>
  <https://docs.github.com/en/subscriptions-and-notifications/concepts/about-notifications>
- **[Linear]** Workspace-level default cadence overridden by user preference; Pulse unavailable to Guest
  roles. <https://linear.app/docs/pulse>

#### Rate limit / pricing / quota models (all from official pricing pages)

| Product | Free | Entry paid | Unit | Source |
| --- | --- | --- | --- | --- |
| Novu | $0 — 10,000 workflow runs/mo, 20 workflows, 2 envs, activity feed 24 h, 3 members, 2 envs, 60 events RPS | Pro from $30 — 30,000 runs, 7-day feed; +$1.20/1k | **workflow runs** | <https://novu.co/pricing> |
| Novu Team | — | $250 — 250,000 runs, 10 envs, 90-day feed, **RBAC**, 600 RPS, audit logs | | |
| Novu Ent | — | custom — 10M+, custom retention, SSO/SCIM, HIPAA, uptime SLA | | |
| Knock | $0 — 10k notifications/mo, unlimited channels/workflows/members, **multi-tenancy**, Google SSO | **Starter $250** — 50k, $5/1k extra ⚠️ blog says 250k | **notifications sent** | <https://knock.app/pricing> |
| Courier | Developer free — 10,000 sends/mo | Business **$0.005 per send** (⚠️ at 100k ≈ $500/mo) | **sends** | <https://www.courier.com/docs/overview> |
| SuprSend | (not fetched) | (not fetched) | — | ⚠️ not verified |
| Zapier | — | Professional $19.99/mo; Team $69/mo (25 users) | **tasks** (per-step, trigger free) | <https://zapier.com/blog/n8n-vs-zapier> ⚠️ vendor comparison page |
| n8n | self-host free | cloud ~$20–50/mo; Business ~$800/mo | **executions** (whole run = 1) | <https://zapier.com/blog/n8n-vs-zapier> ⚠️ vendor comparison page |
| incident.io | — | — | — | Team/Pro/Enterprise for team grouping prefs | <https://docs.incident.io/alerts/grouping-alerts> |

Key economic insight, sourced: **Novu prices on workflow runs (invocations), Courier/Knock price on
notifications actually sent.** Knock states plainly: "If the same trigger resulted in zero notifications
being sent (say because of a given user's notification preferences) you wouldn't be charged. We only charge
for notifications sent, not notification workflows triggered within Knock."
<https://knock.app/pricing>

---

### 1.2 Alert routing engines (extra detail)

- **[incident.io] Alert grouping** — configured **per route** as the "Default grouping config": pick
  attributes to group by (service, region), then choose **Fixed window** (closes N after creation) or
  **Extending window** (resets on each new alert). "An alert group is a bucket of alerts and it takes its
  title and description from the **first alert to join**." You choose whether grouped alerts create an
  incident and/or escalations. **Team-level grouping preferences** can override per route, but only for
  *alert groups* (routes still own escalation and channels). Removing the preference reverts to the route
  default. <https://docs.incident.io/alerts/grouping-alerts>
- **[incident.io]** Dynamic ungrouping: the responder is notified in Slack that an alert was grouped and
  **has the option to ungroup at that point** and route it elsewhere. Marking an alert "unrelated"
  triggers a new incident whose creation time is backdated to the ungroup time.
  <https://incident.io/blog/how-incident-io-helps-to-reduce-alert-noise> ⚠️ vendor blog;
  <https://docs.incident.io/incidents/auto-create>
- **[incident.io]** 40+ tool-specific alert sources (AWS CloudWatch, SNS, Azure Monitor, BigPanda,
  Bugsnag, Checkly, Chronosphere, Cloudflare, Coralogix, Honeycomb, Icinga 2, Jira/ITSM, Logz.io, Monte
  Carlo, Nagios Core, New Relic, Opsgenie, PagerDuty, Panther, Pingdom, Sumo Logic, Uptime.com, Vercel,
  Zendesk, …) **plus generic HTTP / custom HTTP / email**. "Each one parses that tool's payload, derives a
  deduplication key, and maps the payload's fields onto alert attributes, so you get working alerts without
  writing a transform." <https://docs.incident.io/alerts/alert-sources>
- **[FireHydrant]** Two separate mechanisms: **Alert Grouping** (string/regex patterns over Summary,
  Description or Tags — applies only to alerts in `pending/active/expired/completed`, never `resolved`, so
  a grouping window effectively ends when the root alert resolves) and **Alert Deduplication**
  (idempotency key + configurable window + incrementing count).
  <https://docs.firehydrant.com/docs/alert-grouping> <https://docs.firehydrant.com/docs/alert-deduplication>
- **[FireHydrant]** Signals state machine: **Open → Acknowledged → Resolved**, plus **Snoozing**
  (re-notify later), **Dismissed** (ignored / not-an-incident), **Expired** (exhausted the escalation
  chain without action). Filtering supports multi-select e.g. Open+Acknowledged. When an alert is attached
  to an incident, resolving the incident resolves the alert.
  <https://docs.firehydrant.com/docs/signals-introduction>
- **[Grafana OnCall]** Alert Group state machine, fully documented with allowed transitions:
  **Firing** (escalation chain running) · **Acknowledged** (chain interrupted; `Unacknowledge` relaunches
  it) · **Silenced** (like acknowledged but temporary, with timeout, then relaunches) · **Resolved**.
  Transitions: Firing→{Ack,Silenced,Resolved}; Silenced→{Firing,Ack,Resolved}; Acknowledged→{Silenced,
  Firing,Resolved}; Resolved→Firing.
  <https://grafana.com/docs/oncall/latest/set-up/get-started>
- **[Grafana OnCall]** Fields available on every alert: Title, Message, Image URL, **Grouping Id**,
  **Resolved by source**, **Acknowledged by source**, Source link. Behavioural mapping example:
  `{{ 1 if payload.state == 'OK' else 0 }}` → Resolve Signal.
  <https://grafana.com/docs/oncall/latest/configure/jinja2-templating>
- **[PagerDuty]** "By default, PagerDuty sends notifications when an incident is triggered, but **not** when
  it is acknowledged or resolved. You can create notification rules — or use webhooks — to receive
  notifications when an incident is acknowledged or resolved."
  <https://support.pagerduty.com/main/docs/incidents>
- **[Prometheus Alertmanager]** `send_resolved` is a per-integration boolean; the notification `Data.Status`
  is computed as "firing if at least one alert is firing, otherwise resolved" — so partial resolution
  inside a group is possible but the group still reports `firing`.
  <https://prometheus.io/docs/alerting/latest/notifications>

---

### 1.3 Issue / alerts products (extra detail)

- **[Sentry] Monitors vs Alerts split**: "Sentry separates what you detect from what you do about it:
  1. Monitor evaluates data on a schedule or on incoming events and decides whether to open or update an
  issue. 2. Alert rules listen for issue lifecycle and attribute changes (and can be limited to certain
  Monitors or projects). 3. When a rule matches, actions run: notify people, open tickets, call
  integrations." <https://docs.sentry.io/product/monitors-and-alerts/>
- **[Sentry]** Source scoping options: **all issues in selected projects** / **specific monitors** /
  **all issues in all projects** (including projects created *after* the alert — explicitly the "simple
  alerting needs like feed channels in Slack" choice). Step 2 is an environment filter.
  <https://docs.sentry.io/product/monitors-and-alerts/alerts/create-alerts/>
- **[Sentry]** Trigger list (official, current): new issue created · issue escalates · **resolved issue
  regresses** ("cannot be triggered by manually unresolving") · issue resolved · event or issue activity
  captured · Seer stage completions. <https://docs.sentry.io/product/monitors-and-alerts/alerts/create-alerts/>
- **[Sentry]** Filter catalogue is unusually rich: issue age (older/newer than), issue assignment (No One /
  Team / Member), issue frequency, issue **category** (`error, feedback, outage, metric, db_query,
  http_client, frontend, mobile`), issue **type**, issue **priority** (≥ high/medium/low), **de-escalation**,
  plus event attribute, tag, event level, latest release, release age. Match types: contains, equals, starts
  with, ends with, does-not-*, is set, is not set, is one of, is not one of.
  <https://docs.sentry.io/product/monitors-and-alerts/alerts/create-alerts/>
- **[Sentry]** Actions: "Notify on preferred channel" (Suggested Assignees / Team / Member, where Suggested
  Assignees = current assignees ∪ ownership-rule owners ∪ authors of suspect commits, with fallback:
  Recently Active Members / All Project Members / No One) · Slack (workspace+channel, optional channel/user
  IDs **to avoid rate limiting**, optional tag and note rendering) · Discord (server + **channel ID, a
  channel name won't work**) · MS Teams · PagerDuty (service + severity) · Opsgenie (team + priority) ·
  third-party integration / custom webhook · Jira / GitHub / Azure DevOps work items.
  <https://docs.sentry.io/product/monitors-and-alerts/alerts/create-alerts/>
- **[Sentry]** Permissions: alerts are an **organization-level** feature; Org Owners/Managers/Admins + Team
  Admins always can; Members/Team Contributors can if "Let Members Create and Edit Monitors and Alerts" is
  enabled (**default on**); "Alerts scoped to all projects can only be managed by Owners and Managers."
  <https://docs.sentry.io/product/monitors-and-alerts/alerts/create-alerts>
- **[Sentry]** Explicit anti-pattern guidance from the vendor: "Select only the triggers that matter for
  Alerting actions. For example, you may want to create a Jira ticket any time an issue is created, but
  only be notified in Slack when the issue is a certain severity." And on channel choice: "Consider how
  your team works in terms of triaging… do you want individual alerts routing to specific project, or
  service channels, or one alert to catch them all in a team channel?"
  <https://docs.sentry.io/product/monitors-and-alerts/alerts>
- **[Sentry]** Known complaint surfaced in their own Zendesk: *"What does the Action Interval option do in
  the alert rules?"* — resolution explains it plainly: "once you get the alert for 1 issue, it will wait the
  set amount of time to trigger the alert again for the same issue… This will help prevent you being
  spammed with an endless amount of the same alert." Also a known bug class: alerts with the trigger "An
  issue is resolved" not firing actions (get sent ery/sentry#116677) — ⚠️ GitHub issue, i.e. real, open bug.
  <https://sentry.zendesk.com/hc/en-us/articles/21252824620571-What-does-the-Action-Interval-option-do-in-the-alert-rules>
- **[GitHub]** Notification **retention policy**: unsaved notifications kept **3 months**; **Saved**
  notifications kept indefinitely; unsaving an older-than-3-months saved notification deletes it within a
  day. <https://docs.github.com/en/subscriptions-and-notifications/concepts/about-notifications>
- **[GitHub]** Inbox triage UX worth copying wholesale: **Done** (`is:done`) vs **Saved** (`is:saved`)
  vs mark read/unread vs **unsubscribe** (which also removes the notification); batch triage of multiple
  notifications; group inbox **by repository or date**; preview the originating issue/PR from inside the
  inbox; read-state **sync between email and web inbox** (requires the email client to load images from
  `notifications@github.com` — a clever delivery-receipt trick).
  <https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications>
- **[GitHub]** Email reply-to routing: "The `reply-to` address on each email notification identifies the
  thread and the account that the comment will be posted from… will attempt to strip some personally
  identifiable information"; max comment length via email reply **65,530 characters**; signed unsubscribe
  links only work while signed in. <https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications>
- **[GitHub]** Email notification **headers** are documented as a first-class filtering surface.
  <https://docs.github.com/en/subscriptions-and-notifications/reference/email-notification-headers>
- **[Linear]** Auto-subscribe on: create, assign, mention in description or comment; inbox is always the
  source of truth ("You'll always see notifications in your Linear inbox").
  <https://linear.app/docs/notifications> <https://linear.app/docs/inbox>

---

### 1.4 General automation routing

- **[Zapier]** Zap History: filter by date, Zap name, **apps used**, folder, owner, status; global search
  across "all the data that was sent to and received by each step". Separate **Task usage** tab:
  "Zaps that ran" and "**Billable Zap tasks**… This includes task multipliers. For example, a Code by Zapier
  step using extended runtime or an AI by Zapier step with tools may count as more than 1 task per run."
  <https://help.zapier.com/hc/en-us/articles/8496291148685-View-and-manage-your-Zap-history>
- **[Zapier]** Webhook trigger limitations worth designing around: cannot follow 301/302 redirects;
  accepts XML/JSON/URL-Encoded **only**; "If the Zap receives an invalid payload, it may be ignored and the
  Zap may fail to trigger… **The Zap will still respond with a Success status**"; webhook triggers display
  only the **three most recent** webhooks from the past hour when testing; "if the webhook response data is
  an array of objects, that will run the subsequent steps in your Zap multiple times."
  <https://help.zapier.com/hc/en-us/articles/8496291737485-Troubleshoot-webhooks-in-Zapier>
- **[Zapier]** Trap: in Team/Enterprise, "if the owner of the Zap changes, the webhook URL of the Catch
  Hook trigger will change." Same URL.
- **[Zapier]** Held runs: "High task use: too many steps were triggered in the Zap run in a single poll…
  Reconnect {app}: the connection to one of the app accounts used in the Zap is no longer active. Reconnect
  the app account, then replay the held Zap run." ⚠️ third-party mirror for the numeric threshold.
- **[Zapier]** Known gap acknowledged by users: you cannot replay **filtered** tasks (community thread
  "How do I replay filtered Task… it only can replay failed task").
  <https://community.zapier.com/how-do-i-3/how-to-replay-filtered-task-20020>
- **[Make]** Incomplete executions are also an **API surface** (retry/delete/get, `PATCH /dlqs/{dlqId}` to
  update the blueprint before retrying). "The incomplete execution runs with the blueprint from when the
  error happened." <https://developers.make.com/api-documentation/api-reference/incomplete-executions>
- **[Make]** Make exposes typed errors (`RateLimitError`, `ConnectionError`, `BundleValidationError`) and
  lets you override type/message per HTTP status. <https://developers.make.com/custom-apps-documentation/best-practices/base/error-handling>
- **[n8n]** Execution lists are split per-workflow and global; you can load previous execution data into
  the current workflow; log streaming to external sinks. Error-workflow research entry point:
  <https://docs.n8n.io/build/understand-workflows/workflow-components/work-with-nodes>
- **[n8n]** Community-reported anti-pattern (sequential processing + break handler + incomplete
  executions = the scenario halts if a single run is queued).
  <https://community.make.com/t/error-handling-bad-combo-sequential-processing-incomplete-executions/94734>
  ⚠️ that's a Make community thread — treat carefully.

---

## 2. "Table stakes" — features every credible competitor has

1. **Event ingest with a stable dedup/idempotency key.** PagerDuty `dedup_key`, FireHydrant
   `idempotency_key`, incident.io `deduplication_key`, Courier/Knock `Idempotency-Key`, Prometheus
   `Fingerprint`.
2. **A grouping/batching layer.** Alertmanager `group_by`+`group_wait`, Knock batch key, Novu digest key,
   SuprSend digest, incident.io alert groups, FireHydrant grouping, Grafana group wait, Zapier "Filtered".
3. **A time-based first-notification delay** so a burst collapses into one message: Alertmanager
   `group_wait`, Grafana group wait, Novu digest look-back, SuprSend digest window, incident.io fixed vs
   extending window.
4. **A repeat/heartbeat interval** distinct from the group interval: Alertmanager `repeat_interval`,
   Grafana repeat interval, SuprSend digest schedule, Linear email digest cadence, Linear Pulse.
5. **Rate limiting / quota enforcement** with an explicit surfaced throttle status (Knock throttle step,
   Novu throttle step, Courier `THROTTLED`, FCM 429 `RESOURCE_EXHAUSTED`, Zapier task limits + flood
   protection, incident.io 120/min per source).
6. **Per-recipient preference opt-out** layered over workspace defaults (Novu's 3 levels, Knock's
   merge hierarchy, Courier topics, Sentry personal settings, GitHub watching/subscribing, Linear
   categories).
7. **A "critical / must-not-be-unsubscribed" escape hatch** (Novu critical workflows, Knock "override
   recipient preferences", Novu non-critical carve-out inside Schedule).
8. **Channel-aware templates**, one per destination, with per-channel fallbacks.
9. **Delivery status beyond "sent"**: at minimum accepted → sent → delivered → failed, and ideally
   opened/clicked (Courier, Novu activity tracking, OneSignal, FCM delivery receipts).
10. **Some form of run/delivery history** with filtering by status and time (Novu Activity Feed, Knock
    workflow recipient runs, Zapier Zap History, Make execution history, n8n executions, PagerDuty Event
    Analytics, Courier logs).
11. **Manual replay of failed work** (Zapier replay, Make incomplete executions, n8n retry, Novu/Knock
    dashboards).
12. **Auto circuit-breaker on sustained failure** (Zapier's 95%-in-7-days auto-off; Make deactivating the
    scenario after repeated errors; n8n error workflow).
13. **A "send a test" affordance** during setup (Sentry "Send Test Notification", Grafana "Send demo
    alert", incident.io alert preview, Zapier "Test trigger").
14. **Explicit size limits** (Zapier 10 MB/5 MB, Courier 6 MB, FCM 2000 topics/instance).
15. **Explicit honesty about which provider features are gated by plan** (Novu pricing matrix, Knock tier
    matrix).

---

## 3. "Differentiators" — features only some have

| Differentiator | Who does it | How |
| --- | --- | --- |
| **Inhibition** (suppress child alerts when a parent alert fires) | Prometheus Alertmanager (essentially alone as a first-class routing concept) | `inhibit_rules` with source/target matchers + `equal`, with self-inhibition guards |
| **Route labels** (template-able metadata on a route, inherited, distinct from grouping) | Prometheus Alertmanager | `route.labels` + `routeLabels "name"` template function |
| **Extending vs fixed group windows** | incident.io, Courier (batching by inactivity period / max event count / max wait) | Explicit UI choice per route |
| **Resume-from-where-it-left-off on error** | n8n ("Save execution data: Save → the workflow resumes from where it stopped… may increase latency"), Zapier (step-scoped replay) | Persist per-node state |
| **Replay with version pinning** | Zapier (run history shows version number/name; "Retry with original workflow" vs "Retry with currently saved workflow") | Immutable run snapshots |
| **Digest minimum trigger count** ("don't send a digest for 2 alerts") | SuprSend | `min trigger count` advanced setting; workflow exits |
| **Digest retained-item bounds (first-N vs last-N, 2–100)** | SuprSend | `retain items` setting |
| **Terminal-state coverage: `DIGESTED`, `THROTTLED`, `FILTERED`, `CANCELED` as first-class statuses** | Courier | Message status enum |
| **Cross-channel + cross-provider two-level failover with a published retry ladder** | Courier | 5s→15m ladder, ~104 attempts / 24 h, then failover to next channel/provider, then `UNDELIVERABLE` |
| **"Notify on preferred channel" with Suggested Assignees (assignees ∪ ownership rules ∪ suspect-commit authors) and a fallback policy** | Sentry | Assignment-aware delivery |
| **Slack-specific rate-limit avoidance** (add channel/user IDs to avoid Slack rate limiting) | Sentry | Per-integration settings |
| **Decline rate as a first-class metric with a "kill this alert" hit list** | incident.io | Alerts Insights |
| **Anti-flap guarantee** ("if resolved before group_wait elapses, no notification") | Prometheus Alertmanager, Grafana Alerting | Documented semantics |
| **Source-side filtering before an alert object exists** (drop noise at ingest) | incident.io | "Filter incoming alerts" per source + preview of what would be dropped |
| **Expression-based dynamic routing against live payload preview** | incident.io | Priority derivation with alert preview |
| **Early digest release** | Courier | `POST /digests/schedules/{id}/trigger` |
| **Per-recipient recurring digest schedules as user data** | SuprSend (`tz_selection: "recipient"`), Knock (recipient `throttleWindow` / schedule window rules) | Dynamic window rules |
| **Acknowledged / Silenced / Declined / Expired as an explicit lifecycle with published transitions** | Grafana OnCall (Firing/Ack/Silenced/Resolved + full transition table), FireHydrant (+ Snoozing/Dismissed/Expired) | Documented state machines |
| **Ack/resolve notifications are opt-in, not automatic** | PagerDuty | "By default… not when it is acknowledged or resolved. You can create notification rules" |
| **Auto-cancel escalations on resolve** | incident.io | Toggle per route |
| **Per-repository label filters inside a Slack channel subscription** | GitHub (`/github subscribe +label:"bug"`, one per repo) | Slash commands |
| **Actions workflow approvals inside the notification thread** | GitHub (`/github subscribe … workflows` → approve as a thread reply) | Requires extra app permissions |
| **"Why did I get this?" label on every notification** | GitHub (`reasons`: mention, subscribed, review requested, …) | `reason:` inbox queries |
| **Email↔inbox read-state sync** | GitHub | Inbox email tracking-pixel technique |
| **Capability-aware UI** (degraded options rather than silent no-ops) | Sentry (warning icon on filters incompatible with the chosen trigger), SuprSend (mock batching preview), incident.io (preview) | |
| **Price on notifications *sent*, not triggers** | Knock (explicit), Courier ($0.005/send) | Preferences that suppress sends cost nothing |
| **Cheap tier includes multi-tenancy + SSO** | Knock (free tier: built-in multi-tenancy + Google SSO) | |
| **Aggregate → AI categorisation → summary digest** as a documented reference architecture | Novu | Two-workflow digest chain with an LLM categorisation step |

---

## 4. "Anti-features" — things competitors deliberately do *not* do

1. **Arbitrary code execution in routing rules.** Zapier: "If you're familiar with Python or Javascript, a
   potential workaround is to do this with a Code step. **Keep in mind that the Code app is an advanced
   feature, and the Zapier support team can't help to troubleshoot the code if there are errors.**"
   <https://help.zapier.com/hc/en-us/articles/8496291737485-Troubleshoot-webhooks-in-Zapier> — support explicitly
   disclaims the code path. n8n's Code node does allow npm packages and filesystem access when
   self-hosted <https://blog.n8n.io/make-vs-zapier> ⚠️ vendor blog. Make's transactional handlers cannot
   undo non-transactional actions <https://help.make.com/rollback-error-handler>.
2. **Partially-resolved group semantics.** Alertmanager collapses a group's `Status` to a single value
   ("firing if at least one alert is firing, otherwise resolved") <https://prometheus.io/docs/alerting/latest/notifications>.
3. **Non-deterministic grouping keys.** Courier's digest silently falls through: an event whose `data` has
   no matching category key "is **not collected**… delivered immediately… **There is no error and no
   warning**." <https://www.courier.com/docs/platform/preferences/digests-setup> — documented as a
   support trap, not designed behaviour.
4. **Mutating an in-flight digest.** Novu: "Changing the step content after triggering the workflow with
   digest step will not affect the existing digested events."
   <https://docs.novu.co/framework/digest>. Knock resolves this deliberately with an explicit
   `latest` version mode. <https://docs.knock.app/designing-workflows/batch-function>
5. **Cross-workflow throttling.** Knock: "Currently, you **cannot throttle across Knock workflows**."
   <https://docs.knock.app/designing-workflows/throttle-function>
6. **Two digest steps in one workflow.** Novu: "Currently, Novu does not support two digest steps in a
   workflow." <https://docs.novu.co/framework/digest>
7. **Grouping owned by the downstream consumer.** Grafana: for Alertmanager/Grafana sources, grouping is
   configured **at the source** and IRM must not override it — changing the Grouping Id template
   "breaks auto-resolution." <https://grafana.com/docs/grafana-cloud/observe-and-act/respond-to-incidents/escalation-and-routing/alert-grouping>
8. **Auto-unsub channel noise.** Slack's own help still tells users to hand-mute channels and threads
   ("If you have a channel that’s bugging you, make sure that's not checked") — i.e. the product does not
   solve alert fatigue structurally. <https://slack.com/help/articles/201355156-Configure-your-Slack-notifications>
9. **Chat notifications inside the alert-group thread for Slack broadcast steps** — Grafana deliberately
   suppresses these to avoid spamming. <https://grafana.com/docs/oncall/latest/configure/escalation-chains-and-routes>
10. **Legacy connectors.** Prometheus ships `msteams_configs` with a DEPRECATION NOTICE steering to
    Workflows/`msteamsv2_configs` <https://prometheus.io/docs/alerting/latest/configuration>; Microsoft is
    progressively disabling Office 365 Connectors
    <https://devblogs.microsoft.com/microsoft365dev/retirement-of-office-365-connectors-within-microsoft-teams>.
11. **Unbounded silent retries.** Zapier autoreplay caps at 5 attempts and sends no error notification until
    the final failure. <https://help.zapier.com/hc/en-us/articles/19220226086797-What-is-replay>
12. **"Important" notifications without discipline.** Grafana warns: "Overusing important notifications
    reduces their effectiveness. Reserve them for genuine escalation within a chain."
    <https://grafana.com/docs/grafana-cloud/observe-and-act/respond-to-incidents/irm/guides/best-practices/escalation-chains>
13. **Unbounded escalation loops.** Grafana caps `Repeat escalation` at 5.
    <https://grafana.com/docs/oncall/latest/configure/escalation-chains-and-routes>
14. **Courier does not market a built-in user Inbox as its core** — it is customer-facing messaging first;
    Novu and Knock lead with Inbox/preference components.
15. **Knock has no free tier beyond Developer** ⚠️ (Knock's own competitor post lists "No hobby-tier beyond
    free plan" as a Knock con — vendor-authored self-critique) <https://knock.app/blog/the-top-notification-infrastructure-platforms-for-developers>.

---

## 5. Anti-patterns / common complaints

**Alert routing / on-call**

- **Alertmanager config is intimidating and mostly YAML + regex.** Repeated community advice is to use
  `amtool check-config` and the visual editor; docs themselves say "The visual editor can assist in
  building routing trees" because the YAML does not. <https://prometheus.io/docs/alerting/latest/configuration>
  ⚠️ I found **no first-party Reddit/HN thread** quoting verbatim user complaints about Alertmanager
  complexity in this pass — treat the "too complex" framing as my inference from the config surface, not
  a sourced quote.
- **The `equal` footgun is acknowledged in Alertmanager's own Go docs**: "CAUTION: If all label names
  listed in `equal` are missing from both the source and target alerts, the inhibition rule will apply!"
  <https://pkg.go.dev/github.com/prometheus/alertmanager@v0.32.1>
- **Matcher parser migration breakage.** Alertmanager documents three modes (fallback / UTF-8 strict /
  classic) and that unquoted matchers like `foo=` **fail to parse** under strict mode, with explicit
  warnings and tooling to validate offline. <https://prometheus.io/docs/alerting/latest/configuration>
  → real-world lesson: **string-quoting rules in routing DSLs become a migration hazard.**
- **Signal fatigue is the industry's own stated core problem.** incident.io's Alerts Insights exists
  specifically to surface acceptance/decline rates and give "a hit list of alerts to kill or tune."
  <https://incident.io/blog/how-incident-io-helps-to-reduce-alert-noise> ⚠️ vendor blog.
- **Slack notification overload is a mainstream complaint**, and the standard advice is per-channel/per-thread
  muting rather than better routing. <https://www.wsj.com/articles/slack-notifications-can-be-easy-to-miss-or-overwhelmingwhat-to-do-about-it-11667215478>
  ⚠️ news source (paywalled; 401 to automated fetches), and https://slack.com/help/articles/204411433-Mute-channels-and-direct-messages.
- **GitHub notification overwhelm is real enough that users write personal guides to disable commit/push
  emails** — a well-known community gist literally exists for this.
  <https://gist.github.com/dwhswenson/c2a67328adfe1790990590605c0e8c11> ⚠️ community source but widely referenced.

**Notification infrastructure**

- **Capacitive-vs-flexible tradeoff.** Knock's own competitor post lists Courier cons as "Workflow logic
  isn't as flexible / API isn't developer-first", and Novu cons as "Not as mature for enterprise use
  cases / Self-hosting adds maintenance overhead." ⚠️ vendor-authored, treat as directional.
  <https://knock.app/blog/the-top-notification-infrastructure-platforms-for-developers>
- **Sentry's own help centre has a ticket literally titled "What does the Action Interval option do in the
  alert rules?"** with the body "It is unclear exactly what the Action Internal option does or why I want
  to set it" — direct evidence that **opaque throttling knobs confuse users**.
  <https://sentry.zendesk.com/hc/en-us/articles/21252824620571-What-does-the-Action-Interval-option-do-in-the-alert-rules>
- **Alert ceilings bite users.** Sentry caps alerts per org, with a lower ceiling for windowed-count rules,
  and the only remedy is consolidation. <https://docs.sentry.io/product/monitors-and-alerts/alerts/create-alerts>
- **Triggers that don't fire are a recurring, real bug class**, not just user error:
  <https://github.com/getsentry/sentry/issues/116677> ("Actions from alerts with rule 'An issue is
  resolved' are not triggered"), <https://github.com/getsentry/sentry/issues/103575> ("Issue Alert Not
  Adhering to Set Action Interval"). ⚠️ GitHub issues = real, but verify status before citing.
- **Plan-gating core features is a recurring complaint theme.** Novu puts RBAC at $250, custom SSO/SCIM/
  retention at Enterprise; Courier's multi-tenancy, user preferences and EU data residency at Enterprise
  per Novu's comparison page <https://novu.co/comparison/courier> ⚠️ competitor-authored comparison.

**Automation platforms**

- **Zapier auto-disabling your automation** is the single most-recurring complaint pattern: 95% error rate
  over 7 days ⇒ Zap turns itself off <https://help.zapier.com/hc/en-us/articles/8496037690637-How-to-troubleshoot-errors-in-Zap-workflows>.
- **You cannot replay a *filtered* Zap.** <https://community.zapier.com/how-do-i-3/how-to-replay-filtered-task-20020> ⚠️ community.
- **Per-step billing is the top pricing complaint.** "The service charges for almost every step in a Zap
  (except the first trigger step and some internal steps such as Filter, Formatter, and Branching)"
  <https://blog.n8n.io/free-zapier-alternatives> ⚠️ vendor blog (n8n).
- **Task-based billing punishes exactly the anti-pattern we care about**: Zapier's own Task usage page
  calls out "a Code by Zapier step using extended runtime or an AI by Zapier step with tools may count as
  more than 1 task per run." <https://help.zapier.com/hc/en-us/articles/8496291148685-View-and-manage-your-Zap-history>
- **Webhook URLs are a SPOF and can change.** Zapier: "if the owner of the Zap changes, the webhook URL of
  the Catch Hook trigger will change." <https://help.zapier.com/hc/en-us/articles/8496291737485-Troubleshoot-webhooks-in-Zapier>
- **Self-hosting is billed as "your problem forever."** n8n users report needing to debug "workflows that
  stop firing, version updates that break things, performance issues because your database fills up,
  backups failing, and accidental credential exposure"
  <https://zapier.com/blog/n8n-vs-zapier> ⚠️ vendor blog. A community user: "Zero maintenance. I spend
  maybe 1-2hrs/month on server stuff… **The onboarding for non-technical users is genuinely better**"
  <https://community.n8n.io/t/n8n-vs-zapier-my-honest-cost-breakdown-after-1-year-of-self-hosting/286907>
  ⚠️ community.
- **The non-technical-user gap is explicit and repeatable.** "Zapier… no-code and AI-assisted for every
  team… n8n… AI-assisted builder is only on n8n's roadmap"; "Steeper learning curve; less intuitive for
  non-technical users" (on Tray). <https://zapier.com/blog/n8n-vs-zapier> ⚠️ vendor blog.
- **Ecosystem breadth ≠ relevance.** HN, on Zapier: "I think the 'API integration' is one of the easiest
  things to code up… and I don't think it does have a moat." ⚠️ HN comment (opinion).

---

## 6. Ranked ideas for an independent, Cloudflare-native router aimed at a **non-technical** user

Scoring: **user value** (1–5) / **implementation cost** on Cloudflare Workers+D1+Queues+DO (1–5, 5 = expensive).
`V/C` is the ratio. Assumes GitHub-first sources → Lark/Slack/Teams destinations per `AGENTS.md`.

| # | Idea | V | C | V/C | Why (sourced rationale) |
| --- | --- | --- | --- | --- | --- |
| 1 | **"Why did I get this?" on every notification + a one-click unsubscribe that sticks** | 5 | 1 | 5.0 | GitHub's `reasons` label is the single most-loved, most-cloned idea in this space (<https://docs.github.com/en/subscriptions-and-notifications/concepts/about-notifications>). Cost is one extra field + one UI affordance. Directly attacks the #1 complaint. |
| 2 | **Three-level preference precedence with a "critical" lock** | 5 | 1 | 5.0 | Novu documents the exact 3 levels and the critical escape hatch; it's a data model, not a feature (<https://github.com/novuhq/docs/blob/main/content/docs/platform/concepts/preferences.mdx>). Implement in D1 on day one; retrofitting it is a migration. |
| 3 | **Sensible defaults shipped as presets**: "Comment digest (5 min)", "Failures only", "Daily 9am summary", "Everything urgent" | 5 | 1 | 5.0 | Every competitor's docs tell users to hand-build these patterns; Sentry's own best-practice section and Grafana's published chain shapes are essentially *presets in prose* (<https://grafana.com/docs/grafana-cloud/observe-and-act/respond-to-incidents/irm/guides/best-practices/escalation-chains>). Non-technical users cannot execute prose. This is the single biggest differentiator available. |
| 4 | **"Test this connection" that actually proves the round trip** | 5 | 1 | 5.0 | Sentry's Send Test Notification, Grafana's Send demo alert, incident.io's alert preview all exist because setup failure is the #1 support cost. Ours: send a real signed fixture, wait for the delivery webhook, show the rendered card *in the browser* before saving. <https://docs.sentry.io/product/monitors-and-alerts/alerts/create-alerts/> |
| 5 | **Honest per-event "what happened to this" ledger with one-click replay of a single step** | 5 | 2 | 2.5 | Zapier's step-scoped replay is the best-in-class UX and the honest model (don't re-send the email, do retry the spreadsheet row) <https://help.zapier.com/hc/en-us/articles/19220226086797-What-is-replay>. Store the rendered payload + version per attempt so replay is exact. |
| 6 | **Digest with a minimum-count floor and retained-item cap** | 4 | 2 | 2.0 | SuprSend's `min trigger count` + `retain items` are the two knobs that make digests feel human ("no digest for 2 alerts", "don't dump 200 items"). <https://docs.suprsend.com/docs/digest> |
| 7 | **Quiet hours per person (IANA timezone, with a per-channel override) + a "critical still comes through" carve-out** | 4 | 2 | 2.0 | Alertmanager time_intervals + Novu Schedule are the reference semantics, including the non-critical carve-out. <https://docs.novu.co/platform/inbox/features/schedule> |
| 8 | **Provider-aware delivery ladder with a published retry schedule and honest exhaustion** | 5 | 2 | 2.5 | Courier's ladder (5s→15m, ~104 attempts/24h, honour `Retry-After`, then failover, then a terminal `UNDELIVERABLE`) is the best-documented published behaviour in the category. <https://www.courier.com/integrations/overview> |
| 9 | **Capability-aware render fallback + a visible "shown as plain text because X" note** | 4 | 2 | 2.0 | Per `AGENTS.md` we must not fake a universal rich-card schema. Sentry's warning-icon pattern (marking incompatible options rather than silently ignoring them) is the UX precedent. |
| 10 | **One-click "mute this thread / this repo / this whole source until Monday"** | 5 | 1 | 5.0 | Slack's advice is hand-muting channels <https://slack.com/help/articles/204411433-Mute-channels-and-direct-messages>; Alertmanager silences are matcher-based and CLI-first. A UI mute that writes the same matcher behind the scenes is high value and low cost. |
| 11 | **Per-channel inbox in-product ("what did I miss?") with read/unread/done/saved** | 4 | 3 | 1.3 | GitHub's Done/Saved split is a genuinely good idea (<https://docs.github.com/en/subscriptions-and-notifications/concepts/about-notifications>) and also solves the retention story (saved = keep forever, else 90 days). But it needs a read model — D1 + Queues can do it, DO for the realtime feed. |
| 12 | **A "this is noisy" / decline-rate dashboard** — "your rule `CI failed` fired 90× and nobody clicked Resolve" | 4 | 3 | 1.3 | incident.io's Alerts Insights decline rate is the most productively *actionable* metric in the category. For a non-technical user this is the auto-tuning feature nobody else offers. |
| 13 | **Auto circuit-breaker with a grace period and a loud re-enable prompt** | 4 | 2 | 2.0 | Zapier's 95%/7-days auto-off is both a complaint and a safety feature (<https://help.zapier.com/hc/en-us/articles/8496037690637-How-to-troubleshoot-errors-in-Zap-workflows>). Implement it, but email/notify the owner *before* auto-off, and show a one-click "turn back on, replay the missed window". |
| 14 | **Plain-language rule builder: "Tell me about → only when → group by → send to → otherwise"** | 5 | 3 | 1.7 | Sentry's When/If/Then and incident.io's route model are the two best sanity-checking structures; render them as a sentence. Big value, moderate cost, and it is the actual wedge against Zapier/n8n for a non-technical user. |
| 15 | **Idempotency with a semantic key suggestion shown in the UI** | 4 | 1 | 4.0 | Knock's `order-placed:user-123:order-456` pattern (<https://docs.knock.app/api-reference/overview>) is a 20-line change and prevents the "did I send that twice?" class of support tickets. |
| 16 | **Presigned, scoped, install-once GitHub App + auto "connection looks healthy" check** | 5 | 2 | 2.5 | GitHub's documented test vector and timing-safe comparison requirement (<https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries>) plus the "webhook URL changes when the owner changes" failure mode (<https://help.zapier.com/hc/en-us/articles/8496291737485-Troubleshoot-webhooks-in-Zapier>) argue for App installs with stable per-installation URLs. |
| 17 | **Delivery SLIs on a status page: accepted→delivered rate and p95 latency per destination** | 4 | 2 | 2.0 | Courier exposes provider-level delivery rate/latency/error rate (<https://www.courier.com/integrations/overview>); a public status page is cheap trust. |
| 18 | **Resolution notices that actually say "resolved"** | 4 | 1 | 4.0 | PagerDuty does *not* send them by default (<https://support.pagerduty.com/main/docs/incidents>); Alertmanager's `send_resolved` defaults differ per integration (true for chat, **false** for email) (<https://prometheus.io/docs/alerting/latest/configuration>). For GitHub PR/CI events, "run #482 is green again" is high-value and trivially cheap because GitHub tells us the state. |
| 19 | **Explicit retention policy surfaced to the user ("we keep 90 days, you can save anything forever")** | 3 | 1 | 3.0 | GitHub's 3-month / Saved-forever model (<https://docs.github.com/en/subscriptions-and-notifications/concepts/about-notifications>) and Novu's tiered activity-feed retention (<https://novu.co/pricing>) both prove users need to be told, not surprised. |
| 20 | **Deduplicate against re-delivered webhooks (GitHub retries) with a visible "duplicate suppressed" counter** | 4 | 1 | 4.0 | At-least-once means duplicates are real; PagerDuty's same-`routing_key` requirement (<https://developer.pagerduty.com/docs/events-api-v2/trigger-events/index.html>) is the subtle rule people get wrong. Showing the suppressed count builds trust. |

### Deliberately NOT building (with sources)

| Anti-feature | Source rationale |
| --- | --- |
| **Arbitrary code / JS steps in the UI** | Zapier support explicitly disclaims Code-step troubleshooting (<https://help.zapier.com/hc/en-us/articles/8496291737485-Troubleshoot-webhooks-in-Zapier>); Make's transactional handlers can't undo non-transactional side effects (<https://help.make.com/rollback-error-handler>); n8n self-hosted Code nodes with npm + filesystem are the thing reviewers describe as ops burden (<https://zapier.com/blog/n8n-vs-zapier>). Also a hard no under `AGENTS.md` ("no arbitrary code execution"). |
| **A user-authored routing DSL in the first release** | Alertmanager's matcher-parser transition (three modes, `foo=` fails strict mode) shows how a regex DSL becomes a multi-year migration liability (<https://prometheus.io/docs/alerting/latest/configuration>). Ship presets + a constrained builder; add a validated, versioned export later if demanded. |
| **On-call schedules, escalation chains, paging, phone/SMS** | This is the Grafana/PagerDuty/Opsgenie category with its own on-call UX and 24/7 expectations (<https://grafana.com/docs/oncall/latest/configure/escalation-chains-and-routes/>). Explicitly outside "noti.runlumi = a source-event → destination router". Revisit only with real demand. |
| **Inhibition rules as a user-facing feature** | It is the most confusing part of Alertmanager (self-inhibition guards, `equal` footguns, <https://prometheus.io/docs/alerting/latest/configuration> <https://pkg.go.dev/github.com/prometheus/alertmanager@v0.32.1>). Implement a **hard-coded, narrow, well-explained** subset later (e.g. "don't tell me about this if CI is already failing for the same branch") rather than exposing generic source/target matchers. |
| **Billing on triggers** | Knock's explicit position: "We only charge for notifications sent, not notification workflows triggered" (<https://knock.app/pricing>). Billing on triggers punishes exactly the deduplication/digest behaviour we want users to adopt. |
| **Silent truncation of destination payloads** | Courier's 6 MB cap and Zapier's 10 MB/5 MB caps are real (<https://www.courier.com/docs/reference>, <https://help.zapier.com/hc/en-us/articles/8496291737485-Troubleshoot-webhooks-in-Zapier>) but CourierX's base64-inflation warning (~33% overhead) is the kind of thing that silently mangles a rich card. Fail loudly with the byte count. |
| **Anything that fabricates event facts** | `AGENTS.md`: "Never silently fabricate event facts." If a payload is missing a field, render "—" and say so; do not invent a title or an actor. |