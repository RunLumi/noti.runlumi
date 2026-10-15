# 09 — Extended Destinations (P2)

> Provider facts are cited to `docs/DESTINATION_API_REFERENCE.md`, which is the source of
> record for this file; that document's own citations are to the providers' own
> documentation, read **2026-10-13**. Anything marked ⚠️ there is treated here as **unknown**,
> not as "probably fine".
>
> This file does **not** restate the `DestinationAdapter` contract, the capability contract or
> the degradation ladder. Those are **F91, F92 and F93** in
> [`07-destination-capabilities.md`](./07-destination-capabilities.md). Every feature below
> assumes them and is written as a *consequence* of them.

## The three findings that shape this file

**1. Discord's failure mode is not a delivery failure, it is a shared-infrastructure failure.**
Discord documents that *"If a webhook returns a 404 status you should not attempt to use it
again - repeated attempts to do so will result in a temporary restriction."* We run on shared
Cloudflare egress. One customer's deleted Discord webhook, retried under a generic
backoff, degrades every other Discord delivery on the platform. F108 makes `404` terminal
before anything else is considered.

**2. Telegram does not fit a multi-tenant SaaS, and no amount of engineering fixes it.**
`docs/DESTINATION_API_REFERENCE.md` §5 records it plainly: *"Telegram has no OAuth and no
multi-tenant app concept. A bot token is issued by `@BotFather` to one person/organization,
and a single bot lives in exactly one Telegram 'workspace' owned by one account."* F110 is the
recommendation **against**; F111 documents the only model that would work and what it costs.

**3. The generic customer webhook destination is the highest SSRF risk surface in the
product.** It is the *only* place a customer-supplied URL is fetched by us with
attacker-chosen shape. F115 is the security feature; F116 and F117 are its consequences.

---

## F105 — Destination registry and plugin model

**Priority** P0 · **Status** 🟡 typed kind registry (`src/connectors/destinations/kind-registry.ts`: kind list, name key, label, capabilities, limits with reference citations, availability flag, signing-secret rule) read by the adapters, the integrations API, the consumer's gate and the dashboard picker; adapter table `adapters.ts` replaces the `index.ts` switches; every kind has an adapter and every adapter module is registered (`tests/destinations/kind-registry.test.ts`, ADR 0052). Not built: per-configured-destination capabilities, `destination_id` column, rollout stage, limiter and budget keys, egress policy and setup docs on the registration, the no-branch CI check · **Enables** F91/F92/F93

**Story** As a maintainer, I want every destination registered through one table-driven
registry, so that adding a destination touches no routing, queueing or UI code.

**Acceptance**
- [ ] A destination is a **data row plus a module**, never an `if`/`switch` in the router.
      The registry is the only place a `DestinationId` becomes known.
- [ ] Registration is **exhaustive over the contract**. A destination missing any of the six
      F91 methods fails its conformance suite and cannot be registered (see **Schema**).

```ts
// F105 — the only shape the router knows about.
// This is the *registration surface*, not a restatement of F91's interface:
// DestinationAdapter (F91) remains the definition; this is how one is bound into the system.
export interface DestinationRegistration<A extends DestinationAdapter = DestinationAdapter> {
  readonly adapter: A;
  /** Idempotency + circuit-breaker key namespace. Never shared between destinations. */
  readonly limiterKey: string;
  /** Where this destination's outbox rate limit and budget are accounted. */
  readonly outboundBudgetKey: string;
  /** Feature flags gating rollout. A flag never changes behaviour at runtime. */
  readonly rollout: { stage: 'internal' | 'beta' | 'ga'; flag?: string };
  /** Docs the customer must see before configuring this destination. */
  readonly setupDocs: SetupDoc;
  /** Destinations this one degrades into, in F93's declared order. */
  readonly degradation: readonly DegradationRung[];
}
```

- [ ] **The router, the queue consumer, the dashboard and the setup wizard all read the
      registry.** There is no destination-specific branch in `src/index.ts`, in the consumer,
      or in a React component. A CI check greps for `destination ===` / `switch (destination)`
      outside the registry and fails.
- [ ] **Today's counterexample is the thing being fixed.** `src/index.ts:7` types the
      destination as `'lark'|'slack'`, `src/index.ts:79` branches on
      `d.destination==='slack'` inline, and `migrations/0001_init.sql` carries
      `CHECK(destination IN ('lark','slack'))`. Three hard-coded lists that must agree. Lark
      has a real adapter; Slack does not (D8). The registry is what makes "add Discord" a
      module plus a row rather than a fourth edit to three lists.
- [ ] `DestinationId` becomes an **open union extended by the registry**, not a hand-edited
      union in a shared types file. Registration is what adds a variant.
- [ ] Capabilities are computed per **configured destination**, not per type (F92's rule),
      because Slack hook vs Slack Web API and Lark custom bot vs Lark app differ
      materially. The registry stores the credential-mode discriminator on the configured row.
- [ ] Each registered destination declares its **provider-documented limits** as data
      (`maxBodyBytes`, rate limits, size caps). F92's golden-table test reads that data, so an
      upstream limit change fails CI against the recorded value rather than in production.
- [ ] Every destination has a **setup doc** attached, and the setup wizard renders the doc's
      steps verbatim — not a paraphrase invented by the frontend.
- [ ] Registration order is not load-bearing. Destination `slack` and destination `email`
      must not affect each other's behaviour, their limiters, their queue or their
      credentials.
- [ ] **A destination is never a special case in the data model.** `integrations` gains
      `orgid` and `connectionid` (F25/F27) and a `destination_id` column referencing the
      registry; `destination` stops being a `CHECK` constraint on a two-value enum.

**Schema**
```ts
// F105 — the registration surface, not a restatement of F91.
// DestinationAdapter (F91) remains the definition of an adapter; this is how one is
// bound into the registry and therefore into the router, consumer, wizard and docs.
export interface DestinationRegistration<A extends DestinationAdapter = DestinationAdapter> {
  readonly adapter: A;
  /** Idempotency + circuit-breaker key namespace. Never shared between destinations. */
  readonly limiterKey: string;
  /** Where this destination's outbox rate limit and budget are accounted. */
  readonly outboundBudgetKey: string;
  /** Feature flags gating rollout. A flag never changes behaviour at runtime. */
  readonly rollout: { stage: 'internal' | 'beta' | 'ga'; flag?: string };
  /** Provider-documented limits, as DATA. F92's golden table reads this. */
  readonly providerLimits: Readonly<Record<string, number | string>>;
  /** Egress policy. An adapter with none cannot be registered. */
  readonly egress: EgressPolicy;
  /** Docs the customer must see before configuring this destination. */
  readonly setupDocs: SetupDoc;
  /** Destinations this one degrades into, in F93's declared order. */
  readonly degradation: readonly DegradationRung[];
}
```

**Design** — The registry is the structural fix for D8. The reason Slack is an inline string
and Lark is an adapter is not that Slack is harder; it is that nothing required the second
one to be an adapter. A registry with a conformance gate makes "is this really a
destination?" a question with a test behind it.

`rollout.stage` exists so a new P2 destination ships **internal-only** until it has real
provider evidence, which is the release rule in `AGENTS.md`. It is a static row value, not a
runtime toggle — a runtime toggle would let a destination's behaviour differ between two
deliveries, which is exactly the "fake capability" failure F93 exists to prevent.

**Errors**
| Condition | Behaviour |
|---|---|
| Adapter registered missing any F91 method | Registration fails; CI failure |
| A `DestinationId` used with no registry entry | `unknown_destination`, permanent — never a default branch |
| Rollout stage is `internal` and the connection belongs to a paying customer | Connection creation refused with the reason |
| A destination's recorded provider limit differs from the golden table | CI failure naming the destination and the field |

**Security** — the registry is where the **egress policy** attaches. A destination declares
its outbound allowlist shape (fixed host set for Slack/Lark/Discord; a validated
customer-supplied policy for the generic destination — F115). There is no default: an
adapter with no egress policy cannot be registered, which removes the possibility of a new
destination accidentally inheriting "fetch anything".

**Tests**
- `every_registered_destination_satisfies_the_f91_conformance_suite`
- `no_destination_branch_exists_outside_the_registry`
- `destination_order_does_not_affect_behaviour`
- `unknown_destination_id_is_a_permanent_error_not_a_default`
- `recorded_provider_limits_match_the_golden_table`
- `internal_rollout_stage_blocks_customer_connections`
- `an_adapter_without_an_egress_policy_cannot_be_registered`

**Deps** — F91, F92, F93. **Blocks** every feature in this file.

---

## F106 — Destination liveness and active health detection

**Priority** P1 · **Status** ❌ not started: no scheduled probe, `degraded` state, last-probe line or probe budget. Only the manual send-a-test (F98, ADR 0018) exists; also depends on F98 gaps and the rate-limit budget (F187)

**Story** As a customer, I want to know that my destination is actually working before real
events depend on it, so that a silently broken integration is caught in minutes not weeks.

**Acceptance**
- [ ] **Three distinct health signals, never conflated:**

| Signal | Trigger | What it proves | Cost |
|---|---|---|---|
| `test_delivery` | customer presses "Send a test" (F98) | the whole path works **right now** | one message |
| `last_success` / `last_attempt` | passive, from the delivery ledger | something has worked recently | free |
| `probe` | scheduled, opt-in, low frequency | the destination is reachable **with no event** | one message per interval |

- [ ] A scheduled probe sends a real canonical event (`test: true`) through the real renderer
      and the real `send`, and is excluded from statistics, billing and the customer's message
      volume. It is **rate-limited separately** from customer traffic and can never exhaust a
      provider quota (F187).
- [ ] Probe cadence is per destination type and bounded: default **6 h**, floor **1 h**, and
      the probe is skipped entirely when `last_success` is younger than the cadence — a probe
      that proves nothing is pure cost.
- [ ] Health is expressed in the **provider's own acknowledgement semantics** (F100), never
      as a boolean:
  - Slack webhook → HTTP 200 + literal body `ok`
  - Lark custom bot → `code: 0`
  - Lark app → `code: 0` + `message_id`
  - Discord with `wait=true` → the created message (delivered)
  - Teams Workflows → `202` = **accepted**, never "delivered"
  - Email → provider API acceptance, with the reference's warning that Cloudflare Email
    Sending reports binding sends as *dropped* even on success
  - Generic webhook → any `2xx`, subject to the customer's declared expected-status policy
- [ ] **The one thing health checking exists to catch is silent provider-side disablement.**
      Teams Workflows are *"linked only to specific users (referred to as owners of the
      workflow) and not to a Teams team or channel"* — so *"if the creating user leaves, the
      flow breaks silently"* — and *"Messages can't be posted if the Workflow is turned off in
      Teams."* Neither state is visible in a delivery response. The probe is the only mechanism
      that detects it, which is why F104's failure list points here.
  - ⚠️ **Detection is inference, not proof.** A probe returning `202` on a Workflow that has
      been turned off may still return `202`, because Teams acknowledges receipt before the
      flow runs. The UI therefore says *"the flow accepted the request"* and offers an owner
      health check, rather than claiming the message arrived.
- [ ] A probe that fails **three consecutive times** marks the connection `degraded` and
      surfaces a dashboard banner with the classified cause. It does **not** disable the
      destination — F118 owns that decision.
- [ ] Probes never carry customer event content. They use a fixed synthetic envelope with no
      repository, actor or branch data, so a probe can never leak into a real channel as a
      confusing real notification.
- [ ] Probe traffic is **not** recorded in the customer-visible delivery log, except as a
      last-probe line on the connection page. A probe that fills an audit log is a probe nobody
      reads.
- [ ] Cost control: probes are budgeted per workspace, disabled above a free-tier threshold,
      and skipped when the workspace has no active rules for that destination (an idle rule
      set does not need a liveness check).

**Design** — F98 already proves a destination works *once*, at setup. It does not prove it
works on Tuesday. The provider-specific failure modes in this file — an orphaned Teams flow, a
deleted Discord webhook, a revoked Lark bot, an expired customer webhook secret — all produce
either a success-looking acknowledgement or nothing at all. Health checking is the difference
between "we did not get an error" and "we checked".

The cost discipline is deliberate: the cheapest health check is the last real success, and a
probe that fires on a schedule regardless of recent traffic is how a health feature becomes a
line item on someone else's invoice.

The honesty point is the one to preserve. Because Teams returns `202` before the flow runs, a
probe cannot prove delivery for Workflows destinations. The UI must not convert `202` into a
green tick (F100). For Workflows, health is *"the trigger accepted our request"* — which is
the truth and also the ceiling of what any non-Microsoft party can observe.

**Errors**
| Condition | Behaviour |
|---|---|
| Probe fails once | Logged, connection stays healthy, no user-visible change |
| Probe fails 3 consecutive times | `degraded` + banner with the classified cause |
| Probe succeeds after degradation | Clears the banner, records time-to-recovery |
| Probe's provider response is unclassified | `destination_unavailable` + **metric raised** (F91's totality rule) |
| Probe skipped because `last_success` is recent | Recorded as `skipped`, not as success |
| Probe would exceed the workspace probe budget | `skipped`, surfaced in the workspace usage view |

**Security** — probes use the destination's stored credential exactly as a real send does, so
they exercise the real decryption and AAD path (F97). A probe never logs the credential, the
URL, or the rendered payload. The probe envelope contains no customer data, so a probe that
leaks into a shared channel leaks nothing.

**Tests**
- `probe_uses_the_real_renderer_and_send_path`
- `probe_is_excluded_from_statistics_billing_and_the_delivery_log`
- `probe_failure_counters_never_label_teams_202_as_delivered`
- `three_consecutive_probe_failures_mark_the_connection_degraded`
- `probe_is_skipped_when_a_recent_success_exists`
- `probe_contains_no_customer_content`
- `probe_rate_is_bounded_and_budgeted_per_workspace`
- `probe_is_not_run_for_a_destination_with_no_active_rules`

**Deps** — F98, F99, F100, F187.

---

## F107 — Discord destination

**Priority** P2 · **Status** 🟡 slice 8a, ADR 0014: adapter, `discord.com`-only URL policy with optional `thread_id`, `wait=true`, `allowed_mentions` on every payload, classifier, wizard and setup copy (`src/connectors/destinations/discord/`, `tests/destinations/discord.test.ts`). Not built: message-id capture (so update/delete/reply/identity report false), programmatic webhook creation, username/avatar, threading toggle. Not tried against a real server

**Story** As a Discord community manager, I want GitHub events posted into my Discord channel,
so that my contributors find out about CI failures where they already are.

**Acceptance**
- [ ] Endpoint: **`POST https://discord.com/api/v10/webhooks/{webhook.id}/{webhook.token}`**,
      cited in `docs/DESTINATION_API_REFERENCE.md` §4.
- [ ] ⚠️ **`wait=true` is mandatory, not a default.** Discord documents `wait` as
      *"waits for server confirmation of message send before response, and returns the created
      message body (**defaults to false; when false a message that is not saved does not return
      an error**)"*. Consequences we accept:
      - We get the created message object back, therefore a **message id**, therefore
        `canUpdate` and `canDelete` are truthfully `true` rather than `false`.
      - A silently dropped message becomes **detectable** instead of invisible.
      - We give up the lower-latency fire-and-forget path. That is a deliberate trade: F100
        records that Discord with `wait=false` returns 204 and *"not confirmation"*.
- [ ] **`allowed_mentions` is always set explicitly on every send.** Discord: *"consider
      sanitizing the data to prevent unexpected behavior and using `allowed_mentions` to prevent
      unexpected mentions."* Default is **the empty object** — no `parse`, no `users`, no
      `roles`, no `replied_user`. Mentions are opt-in per destination and default off (F94).
- [ ] A GitHub branch named `@here`, a PR body containing `<@&123>`, or a commit message with
      `<@everyone>` therefore **cannot ping a human**. This is tested, not assumed.
- [ ] Onboarding supports **both** paths and is explicit about which is which:
      - **Paste a webhook URL** — Server Settings → Integrations → Webhooks.
      - **Programmatic creation** — `POST /channels/{channel_id}/webhooks` under a bot OAuth
        install with the `MANAGE_WEBHOOKS` permission. Discord's name rule is applied at save
        time: 1–80 characters, and may not contain *"clyde"* or *"discord"*
        (case-insensitive).
      - App-based webhooks **do** accept `username` and `avatar_url`, so identity
      customisation is genuinely available here — unlike Slack app webhooks (F103) and Teams
        Workflows (F104). The capability is `true` and the UI offers it.
- [ ] `thread_id` is supported and, when the customer enables threading, used; Discord notes it
      *"will automatically unarchive"* the thread, which is stated in the UI because
      unarchiving is a side effect the customer should expect.
- [ ] The stored credential is the URL and is treated as a bearer secret (F97). Slack's
      reminder generalises: a webhook URL leaks through proxy logs, browser history and
      screenshots.
- [ ] Capabilities reported per F92: `canUpdate: true`, `canDelete: true`, `canReply: true`,
      `supportsInteractive: true`, `supportsCallbacks: false` (Discord interactions require a
      registered application and a public interaction endpoint), `canCustomizeIdentity: true`,
      `supportsServerSideIdempotency: **false**`, `supportsThreads: true`,
      `requiresCustomerOwnedCredential: true`.
- [ ] Dedup is therefore **client-side** (F186), keyed on the delivery id, and the "this
      message may have been sent twice" surface (F185) is shown for Discord destinations.

**Design** — Discord is the easiest destination in this file to add correctly and the easiest
to add incorrectly. The single line that separates them is `wait=true`: without it we cannot
tell the difference between "posted" and "accepted", cannot update or delete a message, and
cannot detect a drop — and F100's semantics table already refuses to call a `wait=false` 204 a
delivery.

The three capability booleans it gets *right* are worth noting because they are all `false`
on the P0 destinations: Discord can update, delete and reply. A CI status card can be edited
in place here, and unlike Slack that requires no separate app install. That is a real
advantage over the P0 set, and the wizard should say so rather than letting the customer
discover it by trying.

**Errors**
| Condition | Behaviour |
|---|---|
| HTTP `404` | **Terminal** — see F108, this is the most important row in this file |
| HTTP `401` / `403` | Permanent; counts toward the invalid-request budget (F108) |
| HTTP `429` | Transient; honour `retry_after` from the body or `Retry-After` (F108) |
| HTTP `400` with an embed/content limit message | Permanent, `payload_too_large` — the renderer is at fault, not the customer |
| `2xx` with `wait=true` | Delivered; capture `id` for update/delete |
| Malformed response body on `2xx` | `destination_unavailable` + metric raised |

**Security** — the webhook URL is a bearer secret: encrypted before D1, masked after creation,
never logged, never shown in the test-payload preview without redaction (F98). Mentions are
off by default. `avatar_url` and `username`, when the customer uses them, are values *we*
supply, not values from the event body.

**Tests**
- `discord_always_sends_wait_true`
- `discord_always_sets_allowed_mentions_explicitly`
- `branch_named_at_here_does_not_ping_a_discord_channel`
- `discord_discovers_a_deleted_webhook_terminal_on_404_without_retrying`
- `discord_captures_the_message_id_from_the_created_message`
- `discord_honours_retry_after_on_429`
- `discord_credential_is_encrypted_and_masked`
- `discord_capabilities_match_the_verified_matrix`
- `discord_name_validation_rejects_clyde_and_discord`

**Deps** — F91, F92, F95, F96, F97.

---

## F108 — Discord failure semantics and the shared-egress budget

**Priority** P0 · **Status** 🟡 slice 8a: 404/410 and 401/403 with Discord code 10015/50027 are permanent with zero retries and auto-pause the integration with an `integration.auto_pause` audit (`src/connectors/destinations/discord/classify.ts`, `src/pipeline/consumer.ts`, `tests/destinations/discord.test.ts`); 429 honours body then header. Not built: global persisted cross-workspace breaker, customer notice, `X-RateLimit-*` pacing; per-route limit UNVERIFIED · **This is the highest-consequence destination bug
available**

**Story** As an operator, I want one customer's dead Discord webhook to not degrade everyone
else's Discord deliveries, so that a shared-infrastructure penalty never becomes an outage.

**Acceptance**
- [ ] ⚠️ **`404` is terminal, immediately, with zero retries.** Discord: *"If a webhook returns
      a 404 status you should not attempt to use it again - repeated attempts to do so will
      result in a temporary restriction."* A deleted webhook will never become undeleted, so
      retrying it is guaranteed useless work against a shared egress address.
  - On `404`: classify permanent → `destination_unavailable`, **no retry schedule at all**
        (F177's tier ladder does not apply), circuit-breaker the destination, notify the
        workspace with the exact instruction *"this Discord webhook no longer exists —
        recreate it in Discord"*, write an audit event (F28).
- [ ] ⚠️ **The invalid-request limit is a shared budget and our retries spend it.** Discord's
      *"Invalid Request Limit (Cloudflare ban): '10,000 per 10 minutes'"* counts **any request
      returning 401, 403 or 429**. Three consequences:
  1. A destination with a revoked token must be circuit-broken **on its first `401`/`403`**,
     not after a backoff ladder. Retrying a `403` is spending a shared budget on a request we
     know will fail.
  2. Rate-limit responses are honoured from `retry_after` (body) or `Retry-After` (header) and
     never retried early.
  3. The destination's circuit state is **global per registry `limiterKey`**, not per
     workspace, so one bad actor's 403 storm cannot exhaust the budget for everyone — the
     breaker trips before the budget does.
- [ ] ⚠️ **Rate limits are parsed from headers, never hard-coded.** Discord's own instruction:
      *"Because rate limits depend on a variety of factors and are subject to change, rate
      limits **should not be hard coded** into your app. Instead, your app should parse response
      headers."* The only number we treat as fixed is the documented **global 50
      requests/second**. Everything else comes from `X-RateLimit-Limit`,
      `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `X-RateLimit-Reset-After` and
      `X-RateLimit-Bucket`.
- [ ] A `429` body is read for `retry_after` and `global`. `global: true` escalates to the
      destination-wide breaker rather than a per-request retry.
- [ ] ⚠️ **UNVERIFIED — the numeric per-route limit for `Execute Webhook`.** Discord documents
      per-route limits in a separately rendered tab that we could not extract. We ship with
      header parsing only and **must not invent a number**. Before enabling general
      availability, retrieve the per-route limit for `webhook_id + webhook_token` and record it
      in F105's golden table.
- [ ] **Scope note.** The reference records the consequence as *"retrying a deleted webhook
      gets your egress IP Cloudflare-banned for the whole Discord API for 10 minutes"*. Discord's
      own published words are narrower — *"a temporary restriction"* — and the `10,000 per 10
      minutes` figure is the invalid-request ceiling rather than a stated ban duration. We
      therefore specify the **rule** (`404` terminal, `401`/`403` break the circuit, `429`
      honoured) rather than the inferred blast radius, and do not quote a ban duration in
      customer-facing or internal documentation.
- [ ] Circuit-breaker state is persisted, not per-isolate, so a breaker tripped in one Worker
      instance trips in all of them. A per-isolate breaker is not a breaker.
- [ ] The delivery ledger records which `classifyError` code fired, so the "why did Discord
      stop receiving anything" question is answerable from the dashboard (F184).

**Design** — This is the clearest case in the whole destination set of a *shared-infrastructure
coupling*, and it is why generic backoff (F177) applied uniformly to Discord is a bug. On
Lark or Slack a `403` costs one wasted request. On Discord, our egress address is shared, the
budget is per-IP, and the penalty for overspending it is taken by every other tenant's
deliveries. The failure is **not local to the request that caused it**.

That makes the correct behaviour *asymmetric*: give up earlier than feels right. A `403` on
the first attempt stops retrying; a `404` never retries at all; only `429` and `5xx` use the
backoff ladder. This is the one destination where "generous retries" is the bug.

The operational corollary is that Discord's 403 is not only a credential problem, it is a
**budget alarm**, and it should be treated with the urgency of a rate limit rather than the
comfort of a validation error.

**Errors**
| Condition | Behaviour |
|---|---|
| `404` | Permanent, **zero retries**, breaker open, audit, customer instructed to recreate |
| `401` / `403` | Permanent, breaker opens on first occurrence, audit, credential flagged invalid |
| `429` with `retry_after` | Transient, delayed exactly that long, no early retry |
| `429` with `"global": true` | Transient, destination-wide breaker opens |
| `5xx` | Transient, F177 ladder |
| `400` on a known embed/content limit | Permanent, `payload_too_large` |
| Repeated breaker trips inside the cool-down | Breaker window extends; customer is notified each time |

**Security** — the breaker is a safety control, not a convenience: it prevents a compromised
or revoked credential from consuming a shared egress budget. Breaker state is keyed by the
registry `limiterKey` and is **not** scoped by `orgid`, because the resource being protected —
the egress budget — is not tenant-scoped. The UI must not expose another workspace's
destination state when reporting breaker status; a customer sees their own connection's health
and a generic "temporarily paused, retrying" message.

**Tests**
- `discord_404_is_terminal_and_is_never_retried`
- `discord_403_opens_the_circuit_on_the_first_occurrence`
- `discord_429_honours_retry_after_from_body_or_header`
- `discord_global_429_opens_the_destination_wide_breaker`
- `rate_limits_are_parsed_from_headers_and_never_hard_coded`
- `only_the_documented_global_fifty_per_second_is_a_fixed_constant`
- `breaker_state_is_shared_across_worker_instances`
- `no_documented_ban_duration_is_quoted_anywhere`
- `breaker_status_does_not_leak_another_workspaces_destination_state`

**Deps** — F13, F105, F177, F178, F179, F183.

---

## F109 — Discord rendering

**Priority** P2 · **Status** 🟡 slice 8a: one embed always, field limits and visible truncation, mention neutralisation, content/markdown/plain ladder (`src/connectors/destinations/discord/render.ts`, `tests/destinations/discord.test.ts`). Not built: update-in-place by message id (F156), threading toggle

**Story** As a Discord user, I want a readable card with the CI result, so that I can triage
from the channel without opening a browser.

**Acceptance**
- [ ] **Hard limits, enforced at render time** (F95), all cited in
      `docs/DESTINATION_API_REFERENCE.md` §4:

| Field | Limit | On violation |
|---|---|---|
| `content` | **2000** characters | truncate visibly with `…` |
| embed `title` | **256** | truncate |
| embed `description` | **4096** | truncate |
| embed `fields` | **25** | drop the excess, record `truncated_fields` |
| `field.name` / `field.value` | **256** / **1024** | truncate |
| `footer.text` | **2048** | truncate |
| `author.name` | **256** | truncate |
| **Combined across all embeds** | **6000** | reduce to one embed |
| embeds per message | **10** | reduce |

  Discord: *"Violating any of these constraints will result in a Bad Request response"* — so
  a renderer that overshoots does not degrade, it **fails permanently**, which is why this is
  an acceptance criterion rather than a best effort.
- [ ] ⚠️ **Never emit two embeds with the same URL.** Discord: *"Embeds are deduplicated by
      URL. If a message contains multiple embeds with the same URL, only the first is shown."*
      Two GitHub events from the same repository would silently collapse into one. The Discord
      renderer therefore emits **exactly one embed per message**, always. This is a hard rule
      with a test, not a style preference.
- [ ] Discord markdown is escaped per F94, with `allowed_mentions` defaulting to the empty
      object (F107). The message body is provider content and is never passed through a
      template engine with evaluation.
- [ ] Links are `https:` only, length-capped, and built from `data.url` after validation.
- [ ] Threading, when enabled, uses the stored `thread_id`; without it, a new message is sent
      and the parent link is included in the body (F93's second rung).
- [ ] **Update-in-place is supported and is the feature worth building.** `canUpdate: true`
      is only true because we send `wait=true` and persist the message id; the renderer must
      therefore support re-rendering the same message for a correlated update (F156) rather
      than posting a second message. Reuse of the message id is keyed on the correlation id,
      never on the delivery id, so a retry after a crash updates rather than duplicates.
- [ ] `config.summary.content` has no Discord equivalent, but the chat-list preview does: the
      top-level `content` field carries a short plain-text summary, which also satisfies the
      accessibility requirement Slack states explicitly for the same reason.
- [ ] Renderer is pure, synchronous and deterministic (F91). No clock reads beyond an explicit
      `now`.

**Design** — The embed-dedupe trap is the kind of detail that looks cosmetic until two CI
failures from the same repository produce one message and a support ticket saying "we missed
one". It is also a reminder that Discord's "rich" model is not additive the way Block Kit is:
more embeds is not more information.

The real prize in this destination is `canUpdate`. With `wait=true` we hold a message id, so a
`workflow_run` sequence — queued → running → failed → resolved — can be **one message that
changes**, which is the behaviour F156 is designed around and which Slack requires a separate
app install to achieve and Teams Workflows cannot achieve at all. Discord is the cheapest
destination in the catalogue for status-card UX, and the spec should say so in the wizard so
customers pick it deliberately rather than by accident.

**Errors**
| Condition | Behaviour |
|---|---|
| Rendered body over any documented cap | Deterministic field elision with `truncated_fields` recorded — never a `400` |
| Elision would still exceed the combined embed total | Reduce to a single minimal embed, record `cap_reduced` |
| A second embed with a duplicate URL would be emitted | Renderer returns the single-embed form instead |
| HTML or markdown in a title | Escaped, never interpreted |
| Update target message id is missing | Falls back to F93's rung 1: a new message prefixed "Update:" |

**Security** — this is the mention-injection and XSS boundary for Discord specifically. Provider
content is untrusted user input: a commit message, a branch name and a PR title are all
attacker-chosen. `allowed_mentions` is the control that stops that content reaching a human's
attention, and it is set explicitly on every send without exception.

**Tests**
- `discord_emits_exactly_one_embed_per_message`
- `discord_never_emits_two_embeds_with_the_same_url`
- `discord_respects_the_2000_character_content_limit`
- `discord_respects_the_6000_character_combined_embed_limit`
- `discord_field_count_never_exceeds_25`
- `mentions_are_suppressed_by_default_on_discord`
- `over_limit_fields_truncate_visibly_and_record_the_fields`
- `discord_update_reuses_the_message_id_for_correlated_updates`
- `discord_render_is_pure_and_deterministic`

**Deps** — F94, F95, F156.

---

## F110 — Telegram: the architectural blocker

**Priority** P2 · **Status** 🚫 decided against: Telegram not built, a bot token belongs to one workspace's bot and the shared-bot architecture is rejected (ADR 0014, followed in slice 8a) · **Decision: do not build**

**Story** As a product owner, I want the reasons Telegram does not fit recorded in the spec,
so that we do not ship it later on momentum.

**Acceptance**
- [ ] **Recommendation: do not ship Telegram in V1 or V2.** The blocker is structural, not
      effort-based.
- [ ] **The blocker, from `docs/DESTINATION_API_REFERENCE.md` §5:** *"Telegram has **no OAuth
      and no multi-tenant app concept**. A bot token is issued by `@BotFather` to one
      person/organization, and **a single bot lives in exactly one Telegram 'workspace' owned
      by one account.** There is no documented mechanism for a third-party SaaS to have a
      customer grant it scoped access to their own bot or chats."*
- [ ] The three options that exist, and what each costs:

| Option | What it means | Why it fails |
|---|---|---|
| **We own one bot** | Every customer's notifications appear under our bot's identity | One shared rate-limit pool of ~30 msg/s globally; one abuse surface; a customer blocking us affects every other customer; customers cannot bring their own identity; our brand is in every alert |
| **We operate a Bot API Enterprise account** | Contract directly with Telegram | A commercial negotiation gated on company size. ⚠️ **UNVERIFIED — whether this is realistically obtainable for a small SaaS.** It is a commercial question, not a docs question, and it gates the entire destination |
| **Customer creates their own bot** | Customer runs `@BotFather` and hands us the token | `@BotFather` is not delegable; we would store a customer's high-value credential; every customer must be a bot developer to use a chat app; the setup flow is a terminal and a secret paste |

- [ ] ⚠️ **Setup friction is the worst of all six destinations, per Telegram itself:**
      *"Unfortunately, there are no out-of-the-box ways to create a working bot if you are not
      a developer."* Our audience is explicitly non-technical (`AGENTS.md`), so this option
      fails the product's own primary criterion.
- [ ] **What the customer experience would look like, stated plainly:** a non-technical
      Telegram user cannot connect Noti to Telegram at all. Telling them to *"create a bot with
      `@BotFather`"* and paste a token is a support ticket, not an onboarding flow.
- [ ] **The capability story is also the weakest**, per the verified matrix
      (`docs/DESTINATION_API_REFERENCE.md` §7): `canCustomizeIdentity: —` (nothing to
      customise, because there is only our bot), and **4096 characters** — the tightest body
      cap of any destination, tighter even than Lark custom bot's 20 KB.
- [ ] The **binding rate limit is the group cap**, not the per-chat cap: *"In a group, bots are
      not be able to send more than **20 messages per minute**."* A single busy channel in a
      single customer's workspace can exhaust a destination-wide budget that is shared by
      every customer on the platform — the same class of problem as F108, but with **no
      per-tenant isolation available at all** because there is no per-tenant bot.
- [ ] **Therefore Telegram must not appear** in the destination catalogue, the setup wizard, or
      the marketing site. It is recorded here as a decision with reasons so the next person
      reads this rather than re-deriving it from the API docs.
- [ ] **Revisit only on a triggering event**, stated in advance: a documented Telegram OAuth or
      app-distribution mechanism for third-party SaaS, **or** a Bot API Enterprise agreement.
      Neither exists today. F111 is what ships *if* one does.

**Design** — Every other P2 destination in this file has an awkward setup path and a clean
multi-tenant credential model. Telegram has the exact inverse: a clean API and no multi-tenant
credential model whatsoever. There is no architecture that produces "customer A's alerts go to
customer A's bot" without a commercial agreement with Telegram, and no amount of our own
engineering creates the missing concept.

The product argument is decisive and does not depend on the technical one. Our wedge is GitHub
events to a team chat in minutes. Telegram's path to the same outcome requires the user to be
a bot developer. That contradicts `AGENTS.md`'s audience and `docs/PRODUCT.md`'s first-delivery
target, so Telegram would be a connector that makes the product worse for the users it reaches.

The one thing Telegram would give us that nothing else does is consumer reach — but consumer
reach is not this product's audience, and building for it is how a focused tool becomes a
Zapier clone.

**Errors**
| Condition | Behaviour |
|---|---|
| A `telegram` destination id is requested at registration | Refused with this feature's reasoning |
| A customer asks for Telegram in support | Documented answer: not offered, with the reason; a link to the nearest supported destination |
| A future change makes any option above viable | F111 is unblocked; F105's registry is where it lands |

**Security** — the option most likely to be chosen under commercial pressure is "the customer
creates their own bot and hands us the token". That would make us a **credential aggregator
for a third party's account**, holding a token that can read and post as a customer-controlled
identity in a chat system we have no visibility into, with no revocation path we control. It
is rejected on security grounds as well as product grounds.

**Tests**
- `telegram_is_not_registered_as_a_destination`
- `telegram_does_not_appear_in_the_setup_wizard_or_the_catalogue`
- `telegram_decision_is_recorded_with_its_reasons`
- `the_decision_names_the_blocking_axis_and_the_trigger_to_revisit_it`

**Deps** — F73, F105. **Blocks** F111.

---

## F111 — Telegram if the blocker ever clears

**Priority** P2 · **Status** 🚫 deferred: conditional on F110 whose blocker is not cleared, nothing built (ADR 0014) · **Not started · conditional on F110**

**Story** As a maintainer, I want the only viable Telegram design written down in advance, so
that if the blocker clears we ship a correct integration rather than a rushed one.

**Acceptance**
- [ ] **Precondition, explicit:** this feature is not started until **either** a documented
      Telegram app/OAuth mechanism for third-party SaaS exists **or** a Bot API Enterprise
      agreement is in place. Neither exists today. No code ships before that.
- [ ] **The only model that works without those: one bot per workspace, provisioned by us.**
      - A workspace admin adds our bot to their chat/workspace once; the bot token stays with
        us; **the customer never pastes a token.**
      - **The 20 messages/minute group cap is per chat**, so isolation exists at the chat
        level even though the token is shared — the destination-wide ~30 msg/s broadcast cap
        is the remaining shared resource and must be budgeted (F187).
      - This is a materially better design than the three options in F110, and it is not
      available because Telegram has no OAuth to drive it.
- [ ] If Telegram ever ships, the verified constraints below are enforced (all from
      `docs/DESTINATION_API_REFERENCE.md` §5):

| Constraint | Value | Enforcement |
|---|---|---|
| Message length | **4096 characters after entity parsing** | renderer cap; exceeding is a permanent API error |
| `parse_mode` | `Markdown`, `MarkdownV2`, `HTML` | `MarkdownV2` requires escaping **18** reserved characters — the single most common failure source |
| Group rate limit | **20 messages/minute** | per-chat limiter |
| Per-chat rate limit | ~1 message/second | per-chat limiter |
| Bulk broadcast | ~30 messages/second without paid broadcasts | destination-wide budget |
| Paid broadcasts | up to 1000 msg/s, 0.1 Stars/message, requires ≥100,000 Stars balance and ≥100,000 MAU | **not offered** — a pricing dependency we refuse to inherit |
| Error shape | `{"ok": false, "error_code": N, "description": "…"}`, with `parameters.retry_after` on `429` | `classifyError` mapping |
| Idempotency | **none documented** | client-side dedup (F186) |

- [ ] **`MarkdownV2` escaping is a first-class, tested renderer feature** (18 reserved
      characters). A PR title containing an underscore — one of the 18 — otherwise fails to
      send. Getting this wrong means **every** notification whose title contains a `.` or `-` or
      `_` fails permanently, and it looks like a provider outage.
- [ ] Delivery is confirmed: `sendMessage` **does return `message_id`**, so
      `canUpdate`/`canDelete`/`canReply` are genuinely available via `editMessageText` with a
      bot in the chat. That is a real advantage and must be stated honestly.
- [ ] Notification settings are documented as *"per-user"* with implicit opt-in from behaviour
      (assignment, opening, commenting, `@`-mentions), which is a **noise-control consideration**
      we must respect (F146–F148) even for an outbound-only destination.
- [ ] The connector is added through F105's registry with full F91 conformance and fixture
      coverage (F119), like any other destination. There is no "lighter" path.

**Design** — Writing this down before the blocker clears is the point. The most likely future
sequence is: Telegram ships a SaaS app mechanism, someone says "we could add Telegram now",
and the team re-derives this analysis from scratch under schedule pressure. Having the design,
the limits and the tests already specified means the decision point is a checkbox rather than
a research project.

The per-chat / per-workspace isolation insight is the genuinely useful part: it reframes the
problem from "one shared bot is unacceptable" to "one shared bot is acceptable **if** the
per-chat limits give isolation, and the residual shared resource is a bounded broadcast
budget". That is an engineering problem with a known solution. The blocker is purely the
absence of a provisioning mechanism, which is a business problem, not ours.

**Errors**
| Condition | Behaviour |
|---|---|
| F110's precondition is not met | Feature is not started; this document is the record |
| `MarkdownV2` escaping is incomplete | Permanent send failure; caught by fixture tests |
| Message over 4096 characters after entity parsing | Deterministic truncation before send, never a provider error |
| `429` | Transient; honour `parameters.retry_after` |
| Group cap exceeded | Per-chat limiter defers; surfaced, never silently dropped |

**Security** — bot tokens are high-value credentials: they can read and post in any chat the
bot is in. Encrypted with `key_version`, never logged, rotatable, revocable, and per-bot so one
revocation does not affect others. **The customer never sees or pastes a token** under the
only viable model; that is the whole security improvement over F110's rejected option three.

**Tests**
- `telegram_is_not_implemented_until_the_f110_precondition_clears`
- `markdownv2_reserved_characters_are_escaped`
- `message_length_never_exceeds_4096_after_entity_parsing`
- `per_chat_and_group_rate_limits_are_enforced_separately`
- `send_message_message_id_is_persisted_for_update_and_delete`
- `bot_tokens_are_per_bot_encrypted_and_never_logged`

**Deps** — F110, F105. **Blocked.**

---

## F112 — Email destination: provider decision

**Priority** P2 · **Status** 🚫 deferred: not built in slice 8a, needs a per-customer provider account, verified-recipient flow and an unsubscribe surface; Cloudflare Email Sending rejected for notifications (ADR 0014) · **Fixes** a contradiction in F32

**Story** As a customer, I want email as a destination so that a notification reaches someone
who is not in a chat tool.

**Acceptance**
- [ ] **Recommendation: a dedicated transactional provider for outbound; Cloudflare Email
      Routing for inbound.** `docs/DESTINATION_API_REFERENCE.md` §6.4 says exactly this:
      *"**Outbound:** a dedicated transactional provider (Resend is the smallest API surface
      and has an obvious Workers-friendly shape) rather than Cloudflare Email Sending, because
      the verified-destination and your-routing-domains-only constraints create a per-customer
      domain-onboarding dependency that is disproportionate to 'we also send email'."*
- [ ] ⚠️ **Why Cloudflare Email Sending is rejected for *notifications*, despite being used for
      auth email today** (`src/auth/email.ts`, binding `AUTH_EMAIL`):

| Constraint | Verbatim | Consequence for a notification destination |
|---|---|---|
| Verified-destination gate | *"Before you onboard a sending domain, you can send emails only to verified destination addresses in your account"* | Capable of reaching 200 addresses. Useless as a notification destination |
| Recipient cap | **200 verified destination addresses per account**, *"shared across all domains in the account"* | Not a scale path |
| Routing domains only | *"**You can only send from your routing domains.**"* | Every customer must onboard **their** domain into **our** Cloudflare account — SPF/DKIM/DMARC provisioning, DNS propagation, and the domain leaving our brand's control |
| Product status | Email Sending is **Beta** and requires the Workers **Paid** plan | A beta dependency on the notification path |
| Daily quota | *"New accounts start with a conservative daily quota and scale up over time… **Limits are applied per account and may be adjusted automatically.**"* — **no number published** | Cannot be capacity-planned or advertised |

- [ ] ⚠️ **Two workable SaaS shapes were considered and both are rejected:**
  - *Customer onboards their own sending domain into our Cloudflare account.* Gives unlimited
      recipients, but takes the domain out of our control, creates a per-customer onboarding
      dependency with real failure modes, and puts their brand on our billing.
  - *We onboard our own domain and send as `notifications@ourproduct.com`.* Simple, but
    "every customer's notifications come from your domain — bad for their DMARC reputation and
    bad for deliverability if one customer's mail gets you blocklisted."
- [ ] **Recommendation is Resend**, the only third-party provider verified this session:
      `POST https://api.resend.com/emails`, `Authorization: Bearer re_…`, body `from`, `to[]`,
      `subject`, `html`, `text`, response `{"id": "…"}`
      (<https://resend.com/docs/api-reference/emails/send-email>). The reference explicitly
      notes it has *"the smallest API surface"* and is *"an obvious Workers-friendly shape"* —
      all plain HTTPS, no Node runtime required.
- [ ] ⚠️ **Postmark, SendGrid and SES are not verified** and must not be implemented from
      assumption. Before any is added: retrieve
      <https://postmarkapp.com/developer/api/email-api>, the SendGrid v3 mail send reference,
      and the SES v2 API reference; record endpoint, auth header, request shape and Workers
      compatibility. SES additionally requires **SigV4** in Workers, which is *"real work"* per
      the reference and is a reason to prefer an HTTP-API provider over SMTP.
- [ ] ⚠️ **Delivery correctness constraints the adapter must honour** (all verified):
  - **Recipients (to+cc+bcc) per email: 50** — Cloudflare's documented limit; the adapter caps
    fan-out at 50 and splits beyond that rather than failing.
  - **Subject line: 998 characters** (RFC 5322).
  - **Total message size: 5 MiB** including attachments (25 MiB to verified destinations).
  - **Header size: 16 KB** for all custom headers.
  - ⚠️ Provider-specific equivalents for a third-party provider are **unverified**; re-check
      against the chosen provider's reference and record them in F105's golden table.
- [ ] **No documented send deduplication exists at any provider.** Deliver at-least-once with
      our own ledger dedup, and emit a **stable `Message-ID`** plus a custom header carrying
      the delivery id so downstream systems can correlate. The reference states this directly:
      *"Deliver **at-least-once** with your own outbox + delivery-ledger dedupe, and include a
      stable `Message-ID` / custom header so downstream systems can correlate."*
- [ ] **Credentials**: the provider API key is encrypted with `key_version`, per workspace,
      never logged, rotatable and revocable; it is **per customer** (BYO key) so one customer's
      key cannot send on another's domain and so our own sending reputation is not a shared
      blast radius.
- [ ] ⚠️ **Contradiction to resolve.** `02-identity-tenancy.md` F32's ADR records *"The
      Cloudflare Email Sending Paid/Beta/**3,000-per-month** constraint is accepted for V1"*.
      **No 3,000-per-month figure exists in the verified reference**, which states that the daily
      quota is unpublished. The ADR's number must be corrected to *"unpublished; query at
      runtime"* before any capacity claim is made anywhere. This is recorded here because the
      ADR is the document a future contributor will read.
- [ ] ⚠️ **Observability gotcha, recorded so nobody builds the wrong analytics.**
      Cloudflare: *"Emails sent from a Worker using the `send_email` binding appear in the Email
      Routing summary as **dropped**, even when they were delivered successfully. To track
      outbound send success, use Email sending metrics and logs instead."* Any dashboard
      derived from Email Routing data would report 100% failure. Email delivery analytics must
      come from our ledger and the provider's own events.

**Design** — Email is the only destination where the hosting platform is the *obvious* choice
and the wrong one. Cloudflare Email Sending is genuinely good for transactional mail to a known
address — which is exactly what auth email is, and `src/auth/email.ts` is correct for that
case. It is structurally wrong for a notification destination, because a notification
destination's defining property is that the recipient set is unbounded and not previously
known.

That is the whole argument, and it is worth stating because the counter-argument sounds strong:
"use the platform, one less vendor". The vendor is not the cost — the **per-customer domain
onboarding dependency** is. Every other destination in this file is one paste. Email-via-
Cloudflare would be the only destination requiring DNS records, propagation and approval
workflows, which contradicts the product's core promise and would be invisible in a UI that
just says "connect your domain".

**Schema**
```ts
// F112. BYO provider key: one customer's key can never send on another's domain,
// and our own sending reputation is not a shared blast radius.
export interface EmailDestinationConfig {
  readonly destinationId: 'email';
  readonly provider: 'resend' | 'postmark' | 'sendgrid' | 'ses';
  readonly apiKeyCiphertext: string;   // AES-GCM, AAD-bound to this row, keyVersion
  readonly keyVersion: number;
  readonly fromAddress: string;        // must be a domain verified with THIS provider
  readonly replyTo?: string;
  /** Our limits, mirrored from F105's golden table. Never guessed per provider. */
  readonly limits: {
    readonly maxRecipients: 50;        // Cloudflare-documented; re-verified per provider
    readonly maxSubjectChars: 998;     // RFC 5322
    readonly maxBodyBytes: 5242880;    // 5 MiB
    readonly maxHeaderBytes: 16384;    // 16 KB
  };
  /** No provider documents send dedup. At-least-once is the contract (F113). */
  readonly dedupe: 'client-side-ledger-only';
}
```

**Errors**
| Condition | Behaviour |
|---|---|
| Provider API key missing or invalid | `400` at save (F96); never stored |
| More than 50 recipients | Split into batches at render time, recorded |
| Subject over the provider limit | Truncate visibly; record `truncated_fields` |
| Message over the size limit | Deterministic elision; `payload_too_large` only if unavoidable |
| Provider returns a permanent error (invalid address, suppressed) | Permanent; classification must handle per-recipient success/failure |
| Provider returns a temporary error | Transient; `Retry-After` honoured |
| Provider quota exceeded | `destination_unavailable` + customer-facing explanation, never silent |

**Security** — HTML bodies are rendered from the canonical envelope, not from provider
markdown, and all interpolated values are HTML-escaped. Links are `https:` only and
constructed by us, never from payload fields. The sending domain's SPF/DKIM/DMARC posture is
the customer's responsibility and the UI says which records exist. Unsubscribe is handled by
F150 (sticky one-click unsubscribe) and is a legal requirement, not a feature.

**Tests**
- `email_delivery_uses_the_verified_resend_endpoint_and_body`
- `email_uses_a_per_workspace_encrypted_api_key`
- `outbound_email_is_at_least_once_with_a_stable_message_id`
- `recipients_are_capped_and_split_at_the_documented_limit`
- `subject_and_message_size_limits_are_enforced_at_render_time`
- `no_cloudflare_email_sending_daily_quota_number_is_claimed_anywhere`
- `the_f32_adr_three_thousand_per_month_figure_is_corrected`
- `html_body_escapes_all_interpolated_values`
- `unsubscribe_is_present_and_honoured`

**Deps** — F91, F92, F96, F97, F150, F185.

---

## F113 — Email rendering and honest delivery semantics

**Priority** P2 · **Status** 🚫 deferred: not built because the email destination is not built (F112, ADR 0014)

**Story** As a customer, I want to know whether an email actually arrived, so that I do not
assume a notification succeeded when it was only accepted.

**Acceptance**
- [ ] A notification email is a **plain-text-first, HTML-optional** message. Plain text is the
      accessibility floor and the deliverability floor; HTML is an enhancement containing the
      same information, never the only copy.
- [ ] The envelope's body is **length-capped at render time** using the provider's documented
      limit (F112), with elision recorded. Truncated silently is unacceptable; F95's rule
      applies.
- [ ] Every message carries:
      - a stable `Message-ID` derived from the delivery id (deterministic, so a retry reuses
        it),
      - a custom header carrying the delivery id and the correlation id,
      - `List-Unsubscribe` and `List-Unsubscribe-Post` headers wired to F150,
      - a plain-text footer naming the workspace, the event, and how to stop receiving it.
- [ ] **Delivery semantics are stated honestly.** SMTP acceptance is not delivery. The
      destination is reported as `accepted` until a provider event confirms otherwise, and the
      UI uses the same vocabulary as F100: *"Accepted by the mail provider"* is never
      *"Delivered to Alice's inbox"*.
- [ ] ⚠️ **No bounce/complaint webhook may be claimed until one is verified.** ⚠️
      **UNVERIFIED — Resend's webhook event list and signature scheme.** Retrieve
      <https://resend.com/docs/api-reference/webhooks> (or the chosen provider's equivalent),
      record the event names, the signature header and the retry schedule, and only then add
      bounce and complaint handling. **Until then, bounces are invisible to us and the UI must
      say so** rather than implying we monitor deliverability.
- [ ] **A hard-bounce address is never silently retried forever.** Once bounce handling exists,
      a hard bounce moves the address to a workspace suppression list; every subsequent send to
      it is a permanent skip, not a retry loop.
- [ ] Recipient addresses are validated at save time: RFC-shaped, length-capped, and the
      **number of recipients per destination is capped** so one rule cannot fan out to
      thousands of addresses.
- [ ] Rate limiting and daily-volume limits are surfaced **before** the customer hits them,
      using the provider's published limits where they exist and an honest *"the provider's
      limit is not published; we query it at runtime"* where they do not (F112).
- [ ] Rendering safety is the same as everywhere else: F94 escaping, `https:`-only links,
      default-off mentions are n/a, and no provider content is ever interpolated as HTML.

**Design** — Email is the destination where the gap between "we sent it" and "they got it" is
widest, and where the temptation to over-claim is strongest because the customer cannot easily
tell the difference either. F100's whole thesis applies with more force here, not less.

The `Message-ID` determinism is the quiet piece: making it a pure function of the delivery id
means a retry after a crash reuses the same identifier, so a downstream mail system threading
on `Message-ID` collapses the duplicate for us. That is the only server-side-ish dedup
available for email and it is worth having.

`List-Unsubscribe` is a deliverability feature as much as a legal one — bulk senders that omit
it accumulate spam complaints, and complaints are the mechanism by which a shared sending
reputation degrades. It is therefore part of the delivery contract, not a preference.

**Errors**
| Condition | Behaviour |
|---|---|
| Malformed recipient address | `400` at save, never stored |
| Message body over the provider limit | Deterministic elision, recorded |
| Provider accepts, no delivery confirmation available | `accepted`, UI says *"accepted by the mail provider"* |
| Bounce/complaint webhook not yet supported | Surfaced in the UI as a known limitation |
| Hard bounce, once handling exists | Suppression list; subsequent sends are permanent skips |
| Suppression list full or provider rejects the request | `destination_unavailable` with a plain-language cause |

**Security** — the message body contains repository names, branch names, actor logins and URLs.
That is exactly the content class F102 redacts for Lark's DLP gate and F51 retains for a
limited window. Email is durable in the recipient's mailbox in a way chat is not, so the
retention and redaction posture must be reviewed before general availability, not after.
Unsubscribe links are **signed and single-use**, so an unsubscribe cannot be forged to silence
someone else's notifications.

**Tests**
- `message_id_is_deterministic_from_the_delivery_id`
- `email_reports_accepted_not_delivered`
- `ui_never_labels_accepted_as_delivered`
- `list_unsubscribe_headers_are_present_and_single_use`
- `malformed_recipients_are_rejected_at_save_time`
- `body_is_length_capped_with_recorded_elision`
- `html_body_is_escaped_and_links_are_https_only`
- `no_bounce_handling_is_claimed_until_the_provider_webhook_is_verified`

**Deps** — F94, F95, F99, F100, F112, F150.

---

## F114 — Inbound email as a reply-to-webhook source

**Priority** P2 · **Status** ❌ not started: no `email()` handler or inbound source; depends on the email destination decision (F112, deferred in ADR 0014) and is P2

**Story** As a customer, I want to reply to a notification email and have that reply become an
actionable event, so that on-call engineers can respond without leaving their inbox.

**Acceptance**
- [ ] **This is Cloudflare Email Routing, which is inbound-only** — it is not Email Sending,
      and the reference flags this confusion explicitly: *"Do not write 'Cloudflare Email
      Routing' for the outbound feature — Email Routing is inbound-only and is a common source
      of spec confusion."*
- [ ] **It is the only one of these mail features that works on the Workers Free plan** —
      the reference states this, and it is the deciding factor: inbound email must not put the
      product behind a paid-plan gate.
- [ ] Implementation is the `email()` Worker handler. Inbound message size is **25 MiB**
      (documented); attachments are **not** forwarded to destinations and are discarded after
      parsing.
- [ ] ⚠️ **Inbound email has no sender authentication by default.** SPF/DKIM/DMARC results
      must be read from the headers and **surfaced to the customer** — a reply that fails DMARC
      is shown as unverified and must never be treated as proof of identity. Treating an email
      address as an authenticated actor is the central risk of this source and is prohibited by
      the same rule as GitHub's `sender` (F60): *"Don't assume `sender` always identifies the
      person who caused an event."*
- [ ] **Authorization is by the reply-to address, not by the sender.** A reply is actionable
      only if the `In-Reply-To` / `References` headers resolve to a message **we** sent to that
      exact address within the retention window. A reply from a stranger is stored and
      displayed, never executed.
- [ ] ⚠️ **Loop protection is a hard provider constraint, not our design.** The reference
      documents that `message.reply()` supports **100 `References` entries and throws beyond
      that** as loop protection. Reply threading is therefore capped well below that, and a
      thread that approaches the cap is closed with an explicit message rather than throwing.
- [ ] **Attachment and HTML handling**: HTML is sanitised to text before anything is rendered;
      attachments are stored by reference with a short TTL if the feature is built at all, and
      never rendered inline.
- [ ] **Every inbound message is bounded and rate-limited** per resolved address, because an
      email address is trivially spoofed and therefore trivially used to burn our quota.
- [ ] Replies are normalized as canonical events with `source` set to the replying address and
      `actor` marked **unknown** — never the workspace member whose address happens to match.
      F43's `isGhost`/`isBot` vocabulary does not apply; the correct value is "not
      authenticated".
- [ ] The capability is advertised as **reply-to-a-notification**, not "email source". It
      cannot receive arbitrary inbound mail.

**Schema**
```sql
-- F114. Authorization is deliberately ONE row: the message we sent plus the address
-- we sent it to. Anything else is data, not an instruction. The row is the entire
-- authorization surface, and it expires with the message it refers to.
CREATE TABLE inbound_email_reply (
  id             TEXT PRIMARY KEY,
  orgid          TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  sent_message_id TEXT NOT NULL,          -- a message WE sent, within retention
  to_address     TEXT NOT NULL,           -- the exact address we sent it to
  from_address   TEXT NOT NULL,           -- display only; never an identity claim
  dmarc_verdict  TEXT NOT NULL,           -- pass|fail|none — surfaced, never trusted
  actionable     INTEGER NOT NULL,        -- 1 only if sent_message_id AND to_address match
  action_taken   TEXT,                    -- acknowledge | resolve | NULL
  references_count INTEGER NOT NULL,      -- provider cap is 100 (F114); we close well before
  created_at     INTEGER NOT NULL,
  FOREIGN KEY (sent_message_id) REFERENCES outbound_email_message(id)
);
```

**Design** — Reply-by-email is the single highest-leverage, lowest-effort feature in this
whole document for the product's stated audience. Engineers already live in their inbox, the
interaction is one tap, and Cloudflare Email Routing is the only mail feature available on the
Free plan.

It is also the highest-injection surface in the entire product, and the reason this is P2
rather than P0 is entirely about identity, not about effort. A chat message from an unverified
GitHub actor is still an event about a repository. An email claiming to be from a customer's
on-call engineer is **unauthenticated content arriving in a channel**, and if the reply can
trigger an action — acknowledge, page, open a PR — then the address is an authorisation
mechanism and we have quietly built account takeover on the strength of a header.

The design rule that keeps this safe: **a reply is only ever an action against the specific
message it replies to, and only from the address that message was sent to.** Anything else is
data. That makes the authorization surface exactly one message id plus one address, both of
which we issued, both of which expire with the message.

**Errors**
| Condition | Behaviour |
|---|---|
| Reply from an address the message was not sent to | Stored for display, **never actioned**, labelled unverified |
| DMARC/SPF failure | Surfaced prominently; never treated as identity |
| `In-Reply-To`/`References` does not resolve to a message we sent | Stored, not actioned |
| Message older than the retention window | Not actionable; explained |
| References chain approaching the 100-entry provider cap | Thread closed with an explicit notice |
| Malformed MIME, oversized message | Rejected and recorded; never fatal |

**Security** — this feature must never convert an email address into a session, a role or an
authorisation. Unauthenticated senders may write text into a channel and nothing else. Reply
actions are limited to acknowledge/resolve-style operations on one specific correlated event,
and each is recorded as an audit event with the full SPF/DKIM/DMARC verdict attached, so a
security reviewer can see exactly what was trusted and what was not.

**Tests**
- `reply_is_actionable_only_from_the_address_the_message_was_sent_to`
- `dmarc_failure_is_surfaced_and_never_grants_identity`
- `unmatched_in_reply_to_is_stored_and_not_actioned`
- `references_chain_near_the_hundred_entry_cap_closes_gracefully`
- `attachments_are_never_rendered_inline`
- `html_email_is_sanitised_to_text_before_rendering`
- `inbound_email_is_rate_limited_per_address`
- `reply_actions_are_audited_with_the_spf_dkim_dmarc_verdict`

**Deps** — F41, F43, F60, F94, F149.

---

## F115 — Generic customer webhook: URL policy and SSRF

**Priority** P0 · **Status** 🟡 slice 8a: one URL-shape policy at save and send, save-time DNS-over-HTTPS check against a private-range table, no redirects, port 443, own-domain block (`src/connectors/destinations/url-policy.ts`, `dns-check.ts`, `tests/destinations/generic-webhook.test.ts`). Not built: per-workspace host allowlist, periodic re-resolution, recorded addresses; DNS rebinding not defeated (AR-30). Off by default (ADR 0014) · **Fixes** the customer-URL part of D9

**Story** As a security engineer, I want a customer's webhook URL to be impossible to point at
anything but the public internet, so that a connection cannot be used to read our internals or
attack our neighbours.

**Acceptance**
- [ ] ⚠️ **This is the only destination in the product that fetches an arbitrary,
      customer-supplied URL.** Everything else is a documented provider host. The Standard
      Webhooks spec names the risk precisely: *"Webhooks implementations are especially
      vulnerable to SSRF as they let their consumers (customers) add any URLs you want, which
      will be called from the internal webhook system."*
- [ ] **The complete policy, enforced at `validateConfig` (write time, F96) and re-enforced in
      `send` (defence in depth):**
  - scheme is exactly `https:`; no `http:`, no `file:`, no `gopher:`, no `data:`
  - no userinfo (`user:pass@`)
  - no fragment
  - port is **443** only
  - hostname is not an IP literal in any notation — IPv4 dotted, IPv6, decimal, octal,
    hexadecimal, integer. Reject on shape **before** any DNS resolution
  - hostname is not `localhost`, does not end in `.localhost`, `.local`, `.internal`, `.home`,
    `.lan`, `.corp`, or any other internal-suffix label
  - total URL length ≤ 2048; hostname ≤ 253
  - the same policy runs on **create, on update, and on send**, because a row can be altered
    by migration, by an admin tool, or by a bug
- [ ] ⚠️ **Optional per-workspace host allowlist.** A workspace may restrict its generic
      destinations to hosts it has explicitly allowed (F26's authorisation path applied to
      egress). This is **recommended and enabled for the first generic destination in a
      workspace**, prompted at save time with a one-line explanation, and the customer can
      relax it afterwards. It is the single most effective control because it removes the
      attacker's freedom entirely.
- [ ] ⚠️ **DNS-rebinding defence is partially available and must be described honestly.**
      Workers `fetch` resolves at the edge and we cannot pin a resolved address, so we cannot
      fully defend against a DNS record that resolves to a private address at request time.
      What we **can** do: reject IP literals and internal suffixes by shape, resolve and check
      the address at configuration time and on every periodic re-validation, and record the
      resolved addresses so a later change is visible. **Do not claim this fully defeats
      rebinding.** Verify Cloudflare's current egress and DNS behaviour before asserting
      anything stronger.
- [ ] ⚠️ **Private and reserved address ranges must never be reachable.** Explicitly rejected
      in any resolved form: `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
      `169.254.0.0/16` (**including `169.254.169.254`**, the cloud metadata address),
      `::1`, `fc00::/7`, `fe80::/10`, `0.0.0.0/8`, and the documentation ranges.
      ⚠️ **UNVERIFIED — whether Cloudflare Workers egress can reach `169.254.169.254` or RFC1918
      space at all.** Check Cloudflare's outbound-connectivity documentation and test before
      claiming either that the metadata endpoint is reachable (a real risk) or that it is
      unreachable (a defence we should not rely on without proof). **Assume reachable until
      tested.**
- [ ] **Redirects are never followed.** The invariant is *never follow a redirect*. A redirect
      is the cheapest bypass of every check above, and the customer's own server is what would
      issue it. *Amended 2026-10-13 ([ADR 0006](../adr/0006-destination-adapter-contract.md)):* destination sends use `redirect: 'manual'` and
      classify any 3xx as a permanent `destination_redirected`. `'error'` also never follows,
      but it surfaces as an ambiguous network `TypeError` that would be retried.
- [ ] **DNS resolution is re-checked periodically**, not only at save time, and a hostname
      whose resolution changes into a blocked range **disables the destination** and alerts.
- [ ] The rejected URL is **never echoed in full** in an error, a log or a support bundle
      (F96's rule): *"The user submitted it, but the error may be logged or shown to another
      workspace member."*
- [ ] The URL is a credential. A webhook URL often embeds a secret in its path or query — the
      same property Slack states about its own URLs — so it is encrypted before D1 (F97),
      masked after creation, and redacted everywhere.
- [ ] **Every outbound request carries a signature the customer can verify** (F116) so the
      destination is not an open relay into their infrastructure.

**Design** — Every other SSRF control in this product is a hostname allowlist against
documented provider domains. There is exactly one feature where a customer chooses the host,
and it is therefore the one place where an allowlist is not available and a **policy** is the
only defence. That is why it is P0 despite the destination being P2: the risk is created by
the feature, so the feature cannot ship before the controls do.

The three design decisions that matter:
1. **Validation at write time.** F96 already identified the current defect (D9): today's
   allowlist runs in the consumer, *after* the secret is persisted, so a hostile URL is stored
   and the failure surfaces hours later as an indistinguishable delivery error. For an
   arbitrary-URL destination that delay is the whole attack window.
2. **Port 443 only, no redirects.** These two remove an enormous amount of surface for almost
   no legitimate cost, because a customer with a genuinely unusual endpoint can be served by a
   normal reverse proxy.
3. **An optional workspace allowlist, recommended for the first destination.** Not mandatory
   because that would make the feature unusable for customers with many internal services —
   but prompted, explained in one sentence, and trivially added. It converts an open-ended
   capability into a closed one for the majority of users who accept the prompt.

The honesty requirement about DNS rebinding is deliberate. A spec that says "we prevent SSRF"
when it can only reject IP literals by shape is making a security claim we cannot support.
What we implement is shape-based rejection, periodic re-validation, recorded resolutions, and
a stated residual risk — and the residual risk is documented, not hidden.

**Errors**
| Condition | Behaviour |
|---|---|
| Non-`https:` scheme, non-443 port, userinfo, fragment | `400` at save, `destination_url_rejected` |
| IP literal in any notation | `400` at save |
| Internal suffix (`.internal`, `.localhost`, …) | `400` at save |
| Resolution into a blocked range at re-validation | Destination disabled, alert, audit |
| 3xx from the destination | Permanent failure — redirects are never followed |
| Hostname changes resolution to a blocked range | Disabled until re-validated and re-approved |
| URL supplied at send time fails re-validation | Permanent, `destination_url_rejected`, never retried |

**Security** — treat this destination's egress as the most privileged code path in the
product. The policy is small, pure, exhaustively unit-tested, and applied in exactly one place
that both `validateConfig` and `send` call. A single helper, one function, no duplication — a
duplicated policy is a divergent policy, and the divergence is always the hole.

**Tests**
- `generic_webhook_rejects_non_https_and_non_443_ports`
- `generic_webhook_rejects_userinfo_and_fragments`
- `ip_literals_in_every_notation_are_rejected_before_dns_resolution`
- `internal_suffixes_are_rejected`
- `cloud_metadata_and_rfc1918_ranges_are_rejected`
- `redirects_are_never_followed`
- `url_policy_is_identical_at_save_time_and_at_send_time`
- `a_single_shared_helper_implements_the_policy_for_both_call_sites`
- `rejection_messages_never_echo_the_full_url`
- `workspace_host_allowlist_blocks_unlisted_hosts`
- `resolution_change_into_a_blocked_range_disables_the_destination`
- `no_claim_is_made_that_dns_rebinding_is_defeated`

**Deps** — F91, F96, F97, F105.

---

## F116 — Generic customer webhook: outbound delivery semantics

**Priority** P2 · **Status** 🟡 slice 8a: Standard Webhooks v1 signing with stable `webhook-id`, canonical JSON envelope, never unsigned, one-time sealed secret (`src/connectors/destinations/generic-webhook/`, `tests/destinations/generic-webhook.test.ts`). Not built: payload template, secret rotation overlap, `x-noti-event-id` and correlation headers, send-a-test, per-destination request budget

**Story** As a customer with an internal service, I want Noti to sign what it sends me, so that
my endpoint can verify each notification really came from us.

**Acceptance**
- [ ] **We are the producer here, so we follow Standard Webhooks** — the same spec we consume
      in `06-source-generic-and-more.md` F74. The request carries `webhook-id`,
      `webhook-timestamp`, `webhook-signature`, with the signature being
      `HMAC-SHA256` over `msg_id.timestamp.payload`, base64, scheme `v1`, `whsec_`-prefixed
      base64 secret.
  - `webhook-id` is our delivery id and is **stable across our own retries**, which is exactly
      what the customer's dedup needs.
  - The documented multi-signature header supports our zero-downtime secret rotation on the
      outbound side too, matching F77.
- [ ] **Delivery is at-least-once and is labelled as such.** The customer's endpoint must be
      told, in their setup documentation, that duplicates are possible and that they should
      dedupe on `webhook-id`. The UI says the same thing. F185's honest-duplicate surface
      applies on both sides of this connection.
- [ ] **Method is `POST`. `Content-Type: application/json`. The body is the canonical envelope**
      (F41), not a provider payload — the customer's service gets the same stable field
      vocabulary regardless of which source produced the event.
- [ ] **A payload-template option exists but is bounded**, so a customer integrating an
      existing service can send the shape that service expects. It reuses F78's
      `GenericMapping` type verbatim — declared paths only, no expressions, no code — so the
      two features cannot drift. The default is the raw canonical envelope.
- [ ] **Response contract:** any `2xx` is `ok: true` delivered. `202` is reported as
      **accepted**, not delivered, exactly as F100 requires for Teams. The customer's setup
      doc states which statuses they should return and that anything else is retried.
- [ ] **Request budget** is enforced per destination (F189): max body bytes, max header bytes,
      and a hard outbound timeout. The Worker is the constraint — we are already inside a queue
      consumer invocation and must not hold it.
- [ ] **A stable header carrying the delivery id, the event id and the correlation id** is sent
      alongside the signature, so the customer can join their logs to ours without parsing the
      body.
- [ ] **The customer cannot see or influence our internal identifiers** beyond the documented
      envelope extensions; `orgid` is sent as the CloudEvents extension already defined in
      F41 and is an opaque id, not a name or a slug.
- [ ] **The destination is named, versioned and rate-limited** per the registry (F105): a
      customer may create many generic destinations and each gets its own limiter key and
      budget.
- [ ] **A "send a test" path exists** (F98) and reports exactly what was sent — status, latency,
      and the classified result — so the customer can debug their endpoint from our dashboard
      rather than from our logs.

**Schema**
```ts
// F116 — the configured row for a customer-supplied webhook destination.
// The URL is encrypted before D1 (F115/F97). Only the fields below are settable;
// there is deliberately no "custom headers" field, because a customer-supplied
// header is a header-injection vector.
export interface GenericWebhookConfig {
  readonly destinationId: 'generic_webhook';
  readonly urlCiphertext: string;             // AES-GCM, AAD-bound to this row (F36)
  readonly keyVersion: number;
  /** Our signing secret, so the customer can verify us. Standard Webhooks v1. */
  readonly signingSecretCiphertext: string;   // whsec_ prefixed, ≥ 32 bytes of entropy
  readonly activeSigningSecretIds: readonly string[]; // max 2 during rotation (F77)
  readonly payloadTemplate?: GenericMapping;  // F78's type, re-used verbatim
  /** Customer expectation only. NEVER widens retry classification (F117). */
  readonly expectedSuccessStatuses: readonly number[]; // default: 200–299
  readonly headers: {
    readonly 'x-noti-delivery-id': true;
    readonly 'x-noti-event-id': true;
    readonly 'x-noti-correlation-id': true;
  };
}
```

**Design** — Being a producer is a responsibility, not a convenience. A generic webhook
destination that sends an unsigned, un-identifiable, unversioned JSON blob hands the customer a
problem with no solution: they cannot verify us, cannot dedupe us, and cannot tell our events
apart from anything else in their logs. Producing Standard Webhooks means our output is
consumable by any Standard Webhooks library — the same argument the spec makes about inbound
fragmentation, pointed the other way.

The `webhook-id` decision is the one that pays off operationally. Because it is stable across
our retries, a customer who is slow and gets retried can dedupe correctly with the same
primitive we use. That symmetry — we consume it inbound and produce it outbound — is worth
more than any format we could invent.

The bounded payload template is the same trade as F78's mapping: a declarative, validated field
selection is configuration; an expression language is a code-execution surface. The type is
shared so the two features cannot drift.

**Errors**
| Condition | Behaviour |
|---|---|
| `2xx` | `ok: true`; `202` labelled **accepted**, not delivered |
| `3xx` | Permanent — we never follow redirects |
| `4xx` | Permanent; the message is shown to the customer with the status so they can fix it |
| `429` | Transient; `Retry-After` honoured and shown |
| `5xx` | Transient, F177 ladder |
| Body or headers over budget | Permanent, `payload_too_large`, recorded |
| Timeout | Transient; the outbound budget is exceeded and reported |
| Destination signature generation fails | Permanent `internal_error`; never sent unsigned |

**Security** — we never send an unsigned request: a destination that cannot be authenticated
by the customer is a place where our data could be forged into their system by anyone who
learns the URL. The signing secret is generated by us, shown once, rotatable with an overlap
window, and encrypted at rest. Customer-provided header values are not accepted at all, since
a customer-supplied header is a header-injection vector.

**Tests**
- `outbound_request_carries_standard_webhooks_headers`
- `outbound_webhook_id_is_stable_across_our_retries`
- `outbound_signature_verifies_against_the_documented_recipe`
- `never_send_an_unsigned_request`
- `delivery_is_labelled_at_least_once_and_the_customer_is_told`
- `202_is_reported_as_accepted_not_delivered`
- `customer_supplied_headers_are_rejected`
- `payload_template_uses_the_shared_validated_mapping_type`
- `test_delivery_reports_status_latency_and_classified_result`

**Deps** — F41, F78, F98, F99, F100, F115, F185, F188.

---

## F117 — Generic customer webhook: response classification

**Priority** P2 · **Status** 🟡 slice 8a: total status mapping, `Retry-After`, unknown 4xx permanent and flagged, body never read (`src/connectors/destinations/generic-webhook/classify.ts`, `tests/destinations/generic-webhook.test.ts`). Not built: configurable success statuses (deliberate, ADR 0014 decision 16), response-body excerpt, breaker or banner

**Story** As a customer, I want to know exactly why my endpoint failed, so that I can fix it
instead of guessing.

**Acceptance**
- [ ] `classifyError` is **total** (F91). Every HTTP status, every thrown `TypeError` from
      `fetch`, every TLS failure and every timeout maps to exactly one taxonomy code with a
      retry decision. An unmapped outcome **raises a metric** and falls back to
      `destination_unavailable`; it never falls back to "retry forever".
- [ ] The mapping is explicit and written down, because the customer's endpoint is the one we
      know least about:

| Customer response | Classification | Retried? |
|---|---|---|
| `200`–`299` | `delivered` / `accepted` (see F116) | no |
| `3xx` | `destination_url_rejected` — permanent | no |
| `400`, `422` | `payload_invalid` — permanent; our body or their contract is wrong | no |
| `401`, `403` | `destination_credentials_invalid` — permanent; likely a rotated secret on their side | no |
| `404` | `destination_unavailable` — permanent; endpoint moved | no |
| `405`, `501` | `destination_unavailable` — permanent; wrong method | no |
| `408`, `425` | transient | yes |
| `429` | transient, honour `Retry-After` | yes |
| `500`–`599` | `destination_unavailable` — transient | yes |
| `fetch` threw / TLS error / DNS failure | `destination_unavailable` — transient, **unless the hostname fails re-validation, which is permanent** | yes / no |
| Timeout past the outbound budget | transient | yes |
| Body over budget before sending | `payload_too_large` — permanent | no |

- [ ] ⚠️ **The customer can configure the expected success status range**, because some
      existing internal services return `201` or `204` and some legacy services return `302`
      for success. The setting is per destination, is validated to a small explicit set, and
      **the default is `2xx`**. ⚠️ **A configurable status range must not be able to widen the
      retry policy into "treat 5xx as success"** — the retry classification is derived from the
      status code, not from whether the status is "expected".
- [ ] **The failure detail shown to the customer** is the status code, our classified code, a
      plain-language cause, and — only when they have explicitly enabled it — a truncated,
      redacted excerpt of the response body. Provider response bodies can echo the request,
      which contains event content and sometimes URLs; the default shows neither.
- [ ] **After repeated permanent failures the circuit breaker opens** (F183) and the UI says
      *"we have paused delivery to this endpoint"* with the last error and a one-click
      **redeliver**. F118 owns what happens next.
- [ ] **The destination is never silently abandoned.** Every permanent failure surfaces in the
      delivery log, in the connection health (F106) and in an audit event if delivery is
      disabled.
- [ ] **The customer's response body is never logged verbatim.** It passes through F12's
      redaction and is size-capped before storage.
- [ ] Because we cannot know the customer's endpoint is healthy, **a `2xx` is our only
      evidence**, and the UI says exactly that: *"Your endpoint returned 2xx. We have no way to
      confirm what happened next."*

**Design** — `classifyError` being total is not a formality here. Every other destination's
error surface is documented by its vendor, so the mapping is mostly transcription. Here the
error surface is arbitrary and the temptation is to write `if (!res.ok) throw` — which is
precisely the defect the audit records as D11, and precisely why a permanent 404 on a deleted
Slack webhook is currently retried five times before being dropped without a word to the
customer.

The configurable success range deserves a warning in its own acceptance list because it is the
one setting that could turn a well-behaved feature into a silent black hole. A customer who
configures `200,302` because their WAF redirects, and whose endpoint then returns `302` for
every error, would silently receive nothing while the dashboard shows green. The rule that
separates these — *the retry classification comes from the status code, never from whether
the status is expected* — prevents that configuration from being dangerous.

**Errors**
| Condition | Behaviour |
|---|---|
| Unclassified provider outcome | `destination_unavailable` + **metric raised** (never a silent default) |
| Permanent failure, retries remaining | **No retries** — terminal immediately, ledger row written |
| Permanent failure | Circuit breaker opens, dashboard banner, audit |
| Response body requested by the customer | Shown only when explicitly enabled, truncated and redacted |
| Re-delivery requested | Uses the same delivery id, so the customer's dedup collapses it |

**Security** — the response body is attacker-controlled (it comes from a customer-controlled
host, which may be compromised). It is treated as untrusted content: redacted, capped, never
rendered as markup, never executed. The classified cause shown to the user is derived from our
own taxonomy, not from the response body, so a hostile body cannot inject a misleading error
message into the dashboard.

**Tests**
- `classify_error_is_total_for_every_status_and_thrown_error`
- `permanents_are_not_retried_at_all`
- `customer_configured_success_range_does_not_change_retry_classification`
- `retry_after_is_honoured_and_shown_to_the_customer`
- `response_body_is_not_logged_verbatim`
- `unclassified_outcome_raises_a_metric`
- `permanent_failure_opens_the_breaker_and_writes_an_audit_event`
- `ui_states_that_2xx_is_the_only_evidence_we_have`
- `redelivery_reuses_the_delivery_id`

**Deps** — F13, F12, F100, F115, F178, F179, F183.

---

## F118 — Destination disable, deprecation and removal

**Priority** P1 · **Status** 🟡 only fragments: pause and resume via PATCH `enabled` (audited), Discord auto-pause with audit, credential quarantine hides rows from delivery (`src/api/integrations.ts`, `src/pipeline/consumer.ts`). Not built: four-state model (degraded, retired), pause reason, three-consecutive-failure auto-disable, customer notice, deprecation process, retired banner

**Story** As a customer, I want to know when a destination has been paused or is going away,
so that a silent stop never looks like "nothing happened".

**Acceptance**
- [ ] **Four distinct, visible states** — never collapsed into a boolean:

| State | Meaning | Delivery behaviour | Customer-visible |
|---|---|---|---|
| `active` | working | attempts | green |
| `degraded` | failing, still retrying | attempts | amber with the cause |
| `paused` | circuit breaker open (F183) or the customer paused it | **no attempts** | red, with a resume action |
| `retired` | provider or product has withdrawn it | no attempts, **data retained** | red banner naming the replacement |

- [ ] `retired` is distinct from `deleted` and from `paused` because it has different
      consequences: a retired destination **stops accepting new configurations, stops
      delivering, retains its delivery history for the audit window, and offers a documented
      migration path**. It is never a silent write-off.
- [ ] **Auto-disable requires an explicit, bounded rule.** F108's Discord breaker trips on the
      first `403` for a documented reason (shared budget). Elsewhere, auto-disable requires
      **three consecutive permanent failures on the same destination**, and is always paired
      with a customer notification and an audit event.
- [ ] **Auto-disable never deletes anything.** Credentials are retained (encrypted) so a resume
      is immediate; the customer can revoke them explicitly at any time.
- [ ] **Customer-initiated pause is a first-class action** with a reason, visible to the whole
      workspace and audited. Pause is not the same as delete.
- [ ] **Deprecation is a process, not a flag:**
  1. Announce in-product and by email with a **stated minimum notice period** (proposed: 90
     days) and a named replacement or a stated reason there is none.
  2. Keep existing connections delivering throughout the notice period.
  3. Show a per-connection banner with the date and the migration path.
  4. Only after the notice period may the destination move to `retired`.
  5. The destination is removed from the catalogue in a **separate, later change** with its own
     ADR.
- [ ] ⚠️ **Precedent to honour.** Office 365 Connectors were disabled from **18–22 May 2026**
      and *"learn.microsoft.com"* still serves live "create connector" pages with working
      manifests and only a soft banner. A destination that a provider has withdrawn must be
      removed from our UI **in the same change** that we learn about it, not at the end of a
      notice period we scheduled for ourselves.
- [ ] **Disconnect and retention** mirror F70: disconnecting a *source* does not delete
      destination credentials (they belong to the workspace), and the UI says so. This applies
      symmetrically.
- [ ] Every state transition writes an `audit_events` row (F28) with `from`, `to` and `reason`.
- [ ] The **delivery ledger is never rewritten** by a state change. History stays true.

**Schema**
```ts
// F118. Four states because they have four different sets of consequences.
// Collapsing them into `enabled: 0` is how a customer spends a week filing a ticket
// about a feature that was working.
export type DestinationState = 'active' | 'degraded' | 'paused' | 'retired';
export type DestinationTransition = {
  readonly destinationId: string;
  readonly orgid: string;
  readonly from: DestinationState;
  readonly to: DestinationState;
  readonly reason: string;          // never a raw provider body (F12)
  readonly at: number;
  /** Populated only for 'retired'. A retirement without a path is not permitted. */
  readonly replacement?: string;
};
// Auto-disable rule, stated once and asserted:
//   - 3 consecutive PERMANENT failures on the same destination → 'paused'.
//   - Exception, Discord: circuit opens on the FIRST 401/403 (F108) because the
//     invalid-request budget is shared egress, not a per-tenant resource.
// Credentials are RETAINED on pause and retired; only explicit revoke destroys them.
```

**Design** — Destinations fail in ways that are invisible from the outside: a Teams Workflow
whose owner left the company, a Discord webhook someone deleted, a Lark bot that was removed
from the group, a customer endpoint that started returning 500. In every case the product's
default behaviour would be to quietly stop delivering, which is exactly the "silent loss"
`AGENTS.md` prohibits.

Four states with four different sets of consequences is the minimum that makes the difference
between *"we paused this"* and *"this is gone"* legible. Collapsing them into `enabled: 0` is
how a customer spends a week filing a ticket about a feature that was working.

The deprecation process exists because we will get this wrong for someone. The Microsoft
Connectors timeline is the worked example: a full year of waves, a banner that lagged the
devblog, and live documentation that kept working after the feature died. We cannot control
provider behaviour, but we can control ours, and the rule is that **a provider withdrawal
triggers immediate removal** rather than a notice period.

**Errors**
| Condition | Behaviour |
|---|---|
| Three consecutive permanent failures | `paused` + notification + audit |
| Circuit breaker opens | `paused`, resumes automatically per F183's cool-down |
| Customer pauses | `paused`, no automatic resume |
| Provider or product withdraws the destination | `retired`, banner with migration path, history retained |
| Customer deletes a destination | Credentials revoked, history retained per policy |
| Resume after pause | Immediate, with the failure that caused the pause still visible |
| Notice period elapses | Destination moves to `retired`; existing connections stop delivering with an explanation |

**Security** — pausing and retiring must not leak. A `paused` destination shows the customer
**their own** connection state only; cross-tenant destination health is never exposed (F108's
rule). Revocation calls the provider where one exists, so a revoked credential is actually
revoked rather than merely forgotten.

**Tests**
- `destination_states_are_distinct_and_rendered_distinctly`
- `three_consecutive_permanent_failures_pause_the_destination`
- `pause_notifies_and_audits_but_never_deletes_credentials`
- `retired_destinations_retain_history_and_offer_a_migration_path`
- `retirement_is_never_silent_and_always_names_the_replacement`
- `state_transitions_write_audit_events_with_from_to_and_reason`
- `delivery_ledger_is_never_rewritten_by_a_state_change`
- `destination_health_never_leaks_across_workspaces`
- `revocation_actually_calls_the_provider`

**Deps** — F70, F98, F106, F108, F183, F184, F222.

---

## F119 — P2 destination conformance and fixture suite

**Priority** P1 · **Status** 🟡 Discord and generic webhook run in the shared conformance suite and golden capability table (`tests/destinations/conformance.test.ts`, `discord.test.ts`, `generic-webhook.test.ts`). Provider limits are recorded in the kind registry with a cited, verbatim-checked reference excerpt and asserted equal to the enforced caps (`tests/destinations/kind-registry.test.ts`, ADR 0052). Not built: per-credential-mode resolution, captured real-payload fixture corpus (F79), Email and Telegram (not built)

**Story** As a maintainer, I want every P2 destination to pass the same conformance and
fixture bar as Lark and Slack, so that "it mostly works" is impossible to ship.

**Acceptance**
- [ ] Every P2 destination — Discord, Email, generic webhook, and Telegram if ever
      unblocked — passes:
  - F91's conformance suite: `render` is pure, `render` is deterministic, `send` has no side
    effects in `render`, `classifyError` is total, `validateConfig` rejects malformed input.
  - F92's capability golden table, with **per-credential-mode** capability resolution (F92's
    rule that a type-level constant would be a lie).
  - F93's degradation ladder, asserted rung by rung.
  - F94's rendering-safety tests, including the destination-specific mention rules.
  - F95's size caps, asserted against the **documented** provider limits.
  - F79's fixture corpus: at least one real captured payload rendered to this destination.
- [ ] **Every documented limit in this file is asserted in a test**, and the recorded value
      lives in the registry so a change fails CI:

| Destination | Limit | Source |
|---|---|---|
| Discord | content 2000; combined embeds 6000; 25 fields; title 256; description 4096; footer 2048; 10 embeds max | Discord message resource |
| Discord | **global 50 req/s**; per-route numeric limit **not recorded** ⚠️ | Discord rate limits |
| Discord | invalid-request limit 10,000 per 10 min; 401/403/429 count | Discord rate limits |
| Email | subject 998; recipients 50; message 5 MiB; headers 16 KB | Cloudflare Email limits |
| Email | inbound 25 MiB; `message.reply()` References cap 100 | Cloudflare Email limits |
| Generic webhook | outbound request budget (F189); URL policy (F115) | ours |
| Telegram (if ever) | 4096 chars after entity parsing; 20 msg/min per group; ~1 msg/s per chat | Telegram Bot API / FAQ |

- [ ] **Adapter fixtures are rendered, not asserted as strings.** Each fixture asserts a
      structural shape (field types, required fields, absence of forbidden fields) rather than
      a byte-exact body, so a harmless provider addition does not produce noise while a
      capability regression still fails.
- [ ] **Negative fixtures are mandatory**: an over-cap payload, a payload containing a
      mention token, a payload containing a URL that is not `https:`, and a payload with an
      empty title. All four must produce a documented, deterministic outcome.
- [ ] **Error-classification fixtures** cover, at minimum, every permanent and transient row in
      F108's and F117's tables, including the "unclassified outcome" path.
- [ ] **A P2 destination cannot reach general availability** without: conformance green,
      fixtures present, a setup doc attached, and **real-provider acceptance evidence** — the
      release rule in `AGENTS.md`. `rollout.stage` (F105) is the mechanism.
- [ ] **Telegram's entry in the conformance suite is skipped, not passing.** It is not
      registered (F110), and a skipped destination must be visibly absent from the catalogue
      rather than silently green.
- [ ] The suite runs in CI and is **not** allowed to skip a registered destination for any
      reason other than its rollout stage, which is itself asserted.

**Design** — F72 established fixture replay as the mechanism that turns an upstream change
into a red build. This feature extends it across the P2 set, with one addition that matters
more than the rest: **negative fixtures**.

Positive fixtures prove that the happy path works. Negative fixtures prove that the *limits*
work — and the limits are where the permanent failures in this file live. An over-cap Discord
embed is not a degraded render, it is a `400`; a `4096`-exceeded Telegram message is an API
error; an email over the header limit fails at the provider. Each of those is a customer-visible
dead letter caused by our renderer, and each is caught by exactly one negative fixture.

The "skipped, not passing" rule for Telegram is the mechanism that keeps F110's decision real.
An absent destination that reports green is how a deprioritisation quietly becomes a half-shipped
feature.

**Errors**
| Condition | Behaviour |
|---|---|
| A registered destination has no fixtures | CI failure |
| A recorded provider limit changes upstream | CI failure naming destination and field |
| A registered destination is skipped for a non-rollout reason | CI failure |
| A destination is at rollout stage `internal` without acceptance evidence | Cannot be promoted; the promotion is a separate reviewed change |
| A negative fixture produces an undocumented outcome | CI failure |

**Security** — the conformance suite includes the SSRF policy tests (F115) as
**mandatory** for the generic destination, not optional: the destination with the largest
attack surface gets the most conformance coverage, not the least. Fixture files for the generic
destination use `https://example.invalid` hosts and never a routable address.

**Tests**
- `every_registered_p2_destination_passes_the_conformance_suite`
- `every_documented_provider_limit_is_asserted_in_a_test`
- `negative_fixtures_cover_over_cap_mentions_unsafe_urls_and_empty_titles`
- `unclassified_error_outcomes_are_covered_by_fixtures`
- `an_absent_destination_reports_absent_rather_than_green`
- `general_availability_requires_real_provider_acceptance_evidence`
- `the_generic_destination_ssf_policy_suite_is_mandatory`

**Deps** — F72, F79, F91, F92, F93, F94, F95, F105.

---

## F120 — Customer-facing capability matrix

**Priority** P1 · **Status** 🟡 `docs/CAPABILITIES.md` generated from the kind registry (`npm run docs:capabilities`, `src/connectors/destinations/render-capabilities.ts`) with matrix, cited limits, unknowns, the confirmation row and a not-offered section with Telegram; a stale page fails `tests/destinations/kind-registry.test.ts` (ADR 0052). Not built: per-credential-mode columns (one built mode per kind), setup-doc links per row, a matrix in the wizard (its summary reads the same data)

**Story** As a customer choosing where my notifications go, I want to know what each
destination can actually do before I choose it, so that I pick based on my needs.

**Acceptance**
- [ ] **A single generated page**, `docs/CAPABILITIES.md`, produced from F105's registry data —
      never hand-maintained. A hand-maintained capability page drifts from the code within one
      release, and the drift is always in the customer's favour.
- [ ] It renders, per destination and per credential mode:

| | Slack hook | Slack API | Teams Workflow | Lark hook | Lark app | Discord | Email | Generic webhook |
|---|---|---|---|---|---|---|---|---|
| Update message | ❌ | ✅ | ❌ | ✅ | ✅ | ✅ | n/a | n/a |
| Delete message | ❌ | ✅ | ❌ | ❌ | ✅ | ✅ | n/a | n/a |
| Thread reply | needs external `ts` | ✅ | ❌ | ❌ | ✅ | ✅ | n/a | n/a |
| Interactive buttons | ✅ | ✅ | ❌ | URL-only | ✅ | ✅ | n/a | n/a |
| Custom identity | ❌ | ✅ | ❌ | name set in UI | ✅ | ✅ | ✅ `From:` | n/a |
| **Server-side dedup** | ❌ | ❌ | ❌ | ❌ | **✅ `uuid`** | ❌ | ❌ | ❌ |
| Body cap | ~40 KB | ~40 KB | **28 KB** | **20 KB** | 30 KB card | 2000 + 6000 embed | provider | budget |
| **Confirmation** | 200 `ok` | `ok:true`+`ts` | **202 — accepted only** | `code:0` | `code:0`+`id` | message returned (`wait=true`) | provider accepted | `2xx` |

  Every cell traces to a citation in `docs/DESTINATION_API_REFERENCE.md`. Where the reference
  is ⚠️ UNVERIFIED, the cell says so rather than guessing.
- [ ] **Three rows are the ones customers actually need, and they are the ones we are worst at
      communicating:**
  - **Only Lark's app API has server-side idempotency.** Everything else needs client-side
      dedup, which is why duplicates are possible and why F186 exists.
  - **Teams Workflows `202` is acceptance, not delivery.** The flow can fail after the `202`.
  - **Every cap differs**, and the *tightest* is Lark custom bot at 20 KB, then Teams at 28 KB,
      then Telegram at 4096 characters. The envelope budget (F45) therefore cannot be set by
      the envelope alone.
- [ ] **The page states what we do not know**, quoting the reference's open questions rather
      than omitting them: Discord's numeric per-route limit, Power Automate throttling numbers,
      private-channel support, Adaptive Card max version, the full Lark error-code table, the
      Cloudflare Email Sending daily quota, Postmark/SendGrid/SES specifics.
- [ ] **Each row links to the setup doc** (F105's `setupDocs`) and to the destination's
      capability-degradation explanation (F93).
- [ ] **The wizard renders the same data**, so the marketing page, the setup wizard and the
      delivery log cannot disagree.
- [ ] The page is **regenerated in CI and a dirty diff fails the build**, which is the
      enforcement mechanism.
- [ ] ⚠️ **Telegram appears in the page's "not offered" section with the reason**, linking to
      F110. It does not appear in the capability matrix, because a row in the matrix reads as
      an offer.

**Design** — This is the product's honesty surface, and it exists because `AGENTS.md`
requires *"capability-aware renderers and honest fallbacks, not a fake universal rich-card
schema"* — and a marketing page that lists a logo is exactly a fake universal schema rendered
in HTML.

Three details do the real work. First, **generation from the registry**, so the page cannot
drift from behaviour. Second, **the unverified cells are printed**, because a table that
quietly omits "we don't know Discord's per-route limit" is telling a half-truth. Third, **the
confirmation row**, which is the one customers cannot discover for themselves: a Slack webhook
that returns `200 ok` is a delivery, a Teams Workflow that returns `202` is an acceptance, and
the difference is invisible until the day it matters.

The "not offered" section is deliberately shaped the way F110 is shaped. Saying *"Telegram is
not available and here is exactly why"* costs one paragraph and saves every future
conversation about it.

**Errors**
| Condition | Behaviour |
|---|---|
| A destination is registered without capability data | Registration fails (F105) |
| Registry data changes without regenerating the page | CI failure |
| A cell has no citation | The generator refuses to emit it |
| A cell corresponds to an ⚠️ UNVERIFIED reference claim | Rendered with the ⚠️ marker and a link to what to check |
| A destination is `retired` | Removed from the matrix, listed in "no longer offered" with a replacement |

**Security** — the page contains no customer data and no configuration. It is safe to be
public, which is deliberate: a capabilities page that requires a login to read is useless at
the moment a customer is deciding whether to sign up.

**Tests**
- `capabilities_page_is_generated_from_the_registry`
- `a_dirty_capabilities_page_fails_ci`
- `every_capability_cell_has_a_citation`
- `unverified_cells_render_with_the_warning_marker`
- `wizard_and_documentation_render_the_same_matrix`
- `teams_202_is_documented_as_accepted_not_delivered`
- `only_lark_app_lists_server_side_idempotency`
- `telegram_is_listed_as_not_offered_with_its_reason`

**Deps** — F91, F92, F93, F105, F110.

---

## Open items this file did not close

1. **Discord numeric per-route rate limit for `Execute Webhook`** — not retrievable; Discord
   renders it client-side. Ship header-parsing only; record the number before general
   availability.
2. **Scope of the Discord "temporary restriction"** — Discord's words are narrower than the
   operational interpretation in the reference. The rule (404 terminal) is specified; the
   blast radius is not quoted.
3. **Cloudflare Workers egress reachability to `169.254.169.254` and RFC1918 space** —
   unverified and **assumed reachable until tested**. The URL policy does not depend on the
   answer, but the runbook does.
4. **Cloudflare Workers DNS-rebinding exposure** — unverified. Do not claim rebinding is
   defeated.
5. **Resend webhook events and signature scheme** for bounce/complaint handling — not
   retrieved; blocks F113's bounce features.
6. **Postmark, SendGrid, SES** — endpoint, auth and Workers compatibility all unverified.
7. **Telegram Bot API Enterprise** availability for a small SaaS — a commercial question, not
   a docs question, and it gates F111 entirely.
8. **Cloudflare Email Sending daily quota** — unpublished; must be queried at runtime. The
   `3,000-per-month` figure in F32's ADR is unsupported and must be corrected.
9. **Power Automate / Logic Apps throttling** — still unretrieved; blocks capacity planning
   for the Teams destination (carried from `docs/DESTINATION_API_REFERENCE.md` §2.2).

**Deps** — F91, F92, F93. **Blocks** nothing.
