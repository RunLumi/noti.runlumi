# 07 — Destination Capability Model

> Verified against official provider docs **2026-10-13**. Provider facts are cited to
> `docs/DESTINATION_API_REFERENCE.md`, which is the source of record for this file.
> Anything marked ⚠️ there is treated here as **unknown**, not as "probably fine".

## The problem this solves

`AGENTS.md` requires *"capability-aware renderers and honest fallbacks, not a fake universal
rich-card schema."* The current code is the counterexample: Lark has a proper adapter with
`render`, `sign` and `classifyError`, while Slack is an inline
`{text: title + '\n' + url}` fetch at `src/index.ts:66`. Two destinations, two architectures,
and the flatter one is the most common integration in the market.

This file defines the interface both must satisfy, and the capability contract that makes an
unsupported feature **visible to the user** instead of silently degraded.

---

## F91 — Destination adapter contract

**Priority** P0 · **Status** partial — contract, adapters and conformance suite in `src/connectors/destinations/` (ADR 0006); `validateConfig` is synchronous; not yet called by the consumer · **Fixes** D8

**Story** As a maintainer, I want one interface every destination implements, so that
Slack stops being an inline string and starts being an adapter like Lark.

**Acceptance**
```ts
interface DestinationAdapter {
  readonly id: DestinationId;              // 'lark' | 'slack' | 'msteams' | ...
  readonly adapterVersion: string;

  // What can this destination actually do? Drives UI, validation and fallbacks.
  capabilities(config: DestinationConfig): DestinationCapabilities;

  // Validate + normalize a customer-supplied credential at WRITE time (F72).
  validateConfig(raw: unknown): Promise<ValidatedConfig>;

  // Pure function of the canonical event. No I/O. No hidden state.
  render(ev: CanonicalEvent, cfg: ValidatedConfig, caps: DestinationCapabilities): RenderedMessage;

  // The only place network I/O happens.
  send(msg: RenderedMessage, cfg: ValidatedConfig): Promise<SendResult>;

  // Map provider errors onto the closed taxonomy (F13).
  classifyError(e: unknown): ClassifiedError;
}
```

- [ ] Every destination implements all six. A shared conformance suite runs against each.
- [ ] `render` is **pure and synchronous**. No counters, no "previous message" memory, no
      clock reads beyond an explicit `now` parameter.
- [ ] `validateConfig` runs at **write time**, not at send time — D9 is precisely the bug
      where a hostile URL is stored and only rejected hours later at delivery.
- [ ] A destination with fewer capabilities is **not** a lesser integration. It is a different
      honest integration.

**Design** — `send` returning a typed `SendResult` rather than throwing lets `classifyError`
be total: every possible outcome maps to exactly one taxonomy code with a retry decision.
Throwing loses that structure, and today `src/index.ts:69` collapses every failure into
`Error('Provider HTTP '+status)`, which is exactly why D11 (no error classification) exists.

**Errors** — `classifyError` must be total. Every provider error, every HTTP status, every
thrown `TypeError` maps to a taxonomy code. Unmapped inputs raise a metric rather than
silently defaulting.

**Security** — `validateConfig` is the SSRF boundary (F102). `send` re-checks (defence in
depth) because a row can be edited by migration or by an admin tool.

**Tests** — a shared conformance suite: `render_is_pure`, `render_is_deterministic`,
`send_has_no_side_effects_in_render`, `classifyError_is_total`, `validateConfig_rejects_malformed`.

**Deps** — F13, F41. **Blocks** every destination in `08` and `09`.

---

## F92 — Capability contract

**Priority** P0 · **Status** partial — per-mode capability declarations with a golden-table test; no UI surface yet

**Story** As a user, I want the UI to tell me what a destination can actually do, so that I
choose it based on what I need rather than what a logo suggests.

**Acceptance** — the interface must expose at minimum:

```ts
interface DestinationCapabilities {
  canUpdate: boolean;              // edit an existing message
  canDelete: boolean;
  canReply: boolean;               // thread a reply
  supportsInteractive: boolean;    // buttons that call back
  supportsCallbacks: boolean;      // click → our server
  canCustomizeIdentity: boolean;   // name/avatar override
  supportsServerSideIdempotency: boolean;
  maxBodyBytes: number;
  maxTitleChars: number;
  supportsThreads: boolean;
  requiresCustomerOwnedCredential: boolean;  // paste-a-URL vs OAuth
}
```

- [ ] **Any** of these being `false` produces a visible, honest UI state — never a silent
      downgrade.
- [ ] Capability is computed **per configured destination**, not per destination type. A Lark
      custom-bot webhook and a Lark app bot have materially different capabilities
      (F101), so the type-level constant would be a lie.

**The real matrix** (from `docs/DESTINATION_API_REFERENCE.md` §7)

| Capability | Slack hook | Slack API | Teams Workflow | Teams Bot | Lark hook | Lark app | Discord | Telegram |
|---|---|---|---|---|---|---|---|---|
| Update message | ❌ | ✅ | ❌ | ✅ | ❌ | ✅ | ✅ | ✅ |
| Delete message | ❌ | ✅ | ❌ | ✅ | ❌ | ✅ | ✅ | ✅ |
| **Server-side dedup** | ❌ | ❌ | ❌ | ❌ | ❌ | **✅ `uuid`** | ❌ | ❌ |
| Thread reply | needs external `ts` | ✅ | ❌ | ✅ | ❌ | ✅ | ✅ | ✅ |
| Interactive buttons | ✅ | ✅ | ❌ | ❌ | URL-only, no callback | ✅ | ✅ | ✅ |
| Custom identity | ❌ | ✅ | ❌ | ❌ | set in UI | ✅ | ✅ | — |
| **Body cap** | ~40 KB | ~40 KB | **28 KB** | 80 KB | **20 KB** | 30 KB card | 2000+6000 embed | **4096** |

**Design** — Note the row that matters most: **only Lark's app API has server-side
idempotency.** Everything else must dedupe client-side, which is why F112 is a cross-cutting
feature rather than a per-destination nicety.

Note also that the **tightest body cap is Lark custom bot at 20 KB**, then Teams at 28 KB,
then Telegram at 4096 *characters*. The envelope budget (F45) cannot be set by the envelope
alone — rendering must be capped per destination.

**Errors** — a render that exceeds `maxBodyBytes` is `payload_too_large` (permanent), never a
silent truncation. Truncated Slack messages are worse than a clear failure.

**Security** — `requiresCustomerOwnedCredential: true` drives the UI to show the credential
exactly once, never to echo it, and to warn that it is a bearer secret.

**Tests** — `capabilities_match_the_verified_provider_matrix`; a golden table test that fails
if a documented provider limit changes without a spec update.

**Deps** — F91.

---

## F93 — Honest degradation ladder

**Priority** P0 · **Status** partial — card → markdown → plain ladder reports the rung used and the rungs skipped; not yet stored on the delivery row; no save-time feature validation

**Story** As a user, I want to know when a feature I enabled is not available on my
destination, so that I am not surprised that my CI card did not update in place.

**Acceptance** — when a requested feature is unavailable, degrade in this **declared** order
and **tell the user which rung was used**:

| Feature requested | Destination lacks it | Degradation |
| --- | --- | --- |
| Update existing message | `canUpdate: false` | Send a new message, prefixed "Update:" |
| Thread reply | `canReply: false` | New message with a link to the parent |
| Interactive button | `supportsInteractive: false` | Plain markdown link |
| Rich card | no card format | Plain text with title, actor, URL |
| Server-side idempotency | `false` | Client-side dedupe window (F112) |

- [ ] The chosen rung is recorded on the delivery row and shown in the delivery detail view.
- [ ] The setup UI **disables** the option rather than accepting it and degrading silently.
- [ ] A connection's configured feature set is validated against its capabilities at **save
      time**, not at delivery time.

**Design** — The specific failure to prevent is a customer enabling "update the same message"
on a Slack incoming webhook, seeing it work for weeks with the Web API, then silently
receiving 40 duplicate CI notifications after switching to a webhook. Configuration must be
rejected at save time with an explanation.

**Errors** — `capability_unavailable` is recorded on the delivery, never thrown.

**Security** — n/a.

**Tests** — `degradation_ladder_is_deterministic`; `user_visible_feature_is_never_silently_downgraded`;
`save_time_validation_rejects_incompatible_configuration`.

**Deps** — F92.

---

## F94 — Rendering safety

**Priority** P0 · **Status** partial — per-dialect escaping/neutralisation, mentions off, https + length-capped links, visible `…` truncation for Slack/Teams/Lark; `truncated_fields` not persisted

**Story** As a customer, I want a malicious commit message or branch name to be displayed as
text, so that a `PR titled "@here fix login"` does not ping my entire team.

**Acceptance**
- [ ] Every string from a provider payload is **escaped per destination** — Lark markdown,
      Slack mrkdwn, Discord markdown, Telegram MarkdownV2 (which requires escaping **18**
      reserved characters), Teams/HTML.
- [ ] ⭐ **`allowed_mentions` is set explicitly on Discord.** Discord: *"consider sanitizing
      the data… and using `allowed_mentions` to prevent unexpected mentions."* A branch named
      `@here` or a PR body containing `<@&123>` otherwise pings real humans. Default: **no
      mentions at all**, opt-in per destination.
- [ ] URLs are validated as `https:` and length-capped before being placed in a card link.
- [ ] Markdown is **not** passed through a template engine with code execution.
- [ ] Titles are truncated at the **provider's** limit, not ours, and truncation is visible
      (`…`).

**Design** — Discord's documented guidance is the sharpest instance of a general rule: every
destination that supports mentions must have an explicit, default-off mention policy. An
untrusted event body must never be able to reach a human's attention.

**Errors** — an over-limit field is truncated with an ellipsis and `truncated_fields` recorded.

**Security** — this is the XSS/mention-injection boundary for provider payloads. Provider
content is untrusted user input, full stop.

**Tests**
- `mentions_are_suppressed_by_default_on_all_destinations`
- `telegram_markdownv2_reserved_characters_are_escaped`
- `branch_named_at_here_does_not_ping`
- `html_in_title_is_not_interpreted`
- `over_limit_fields_truncate_visibly`

**Deps** — F48, F92.

---

## F95 — Body size budget per destination

**Priority** P0 · **Status** partial — renderers respect `maxBodyBytes` (over-cap → `payload_too_large`); Slack top-level `text` always present; elision not yet logged

**Story** As an operator, I want rendering to respect each destination's real limit, so that
a chatty event never dead-letters on Teams at 28 KB.

**Acceptance**
- [ ] Each renderer is cap-aware via `capabilities().maxBodyBytes` and a title/char limit.
- [ ] Enforced documented limits:

| Destination | Limit | Source |
| --- | --- | --- |
| Teams Workflows | **~28 KB** incl. all HTML; over → *"Request Entity too large"* | MS connector reference |
| Lark custom bot | **20 KB** request body | Lark custom-bot guide |
| Lark app | 30 KB card / 150 KB text (`230025`) | `im/v1` reference |
| Slack | `section.text` 3000; `text` 4000 recommended, truncated >40000 | Block Kit reference |
| Discord | 2000 content; embeds: 6000 total, 25 fields, title 256, description 4096 | Discord message resource |
| Telegram | **4096 chars** after entity parsing | Bot API |

- [ ] Slack top-level `text` is **always populated as a full fallback**, because: *"screen
      readers will default to the top-level text field of your post, and will not read the
      content of any interior blocks."* This is both an accessibility requirement and a
      notification-preview requirement.
- [ ] Over-cap is `payload_too_large` (permanent) **or** deterministic field elision — the
      choice is per destination and documented, never silent.

**Design** — Note Discord's extra trap: *"Embeds are deduplicated by URL. If a message
contains multiple embeds with the same URL, only the first is shown."* Two GitHub events from
the same repo would collapse. Never rely on multiple embeds.

**Errors** — elision must be logged so the customer can see the notification was abridged.

**Security** — n/a.

**Tests** — `renderer_respects_its_destination_cap`; `slack_top_level_text_is_always_present`;
`discord_does_not_emit_duplicate_embed_urls`.

**Deps** — F92, F45.

---

## F96 — Credential validation at write time

**Priority** P0 · **Status** partial — `validateDestinationConfig` + send-time re-check exist; the integrations API (PR #9) still validates with the narrower `src/pipeline/allowlist.ts`, and switching it to `validateDestinationConfig` is pending · **Fixes** D9

**Story** As a security engineer, I want an invalid or malicious destination rejected when it
is saved, so that a hostile URL is never persisted in the first place.

**Acceptance**
- [ ] `validateConfig` runs on every create and update. It performs the **complete** URL
      policy: scheme, hostname allowlist, path prefix, no userinfo, no fragment, length cap.
- [ ] Only then is the value encrypted and written.
- [ ] The same check re-runs at send time as defence in depth (a row can be altered by
      migration, by an admin tool, or by a bug).
- [ ] A rejected credential never reaches D1. There is no "store then fail at delivery" path.
- [ ] Editing a destination re-validates even if the credential was not changed — a
      destination whose hostname has since been removed from our allowlist must fail.

**Design** — Today's allowlist in `src/index.ts:65` (https + hostname + path prefix + no
userinfo + `redirect:'error'`) is materially stricter than the common default and is worth
preserving verbatim. What is wrong is *when* it runs. Today a hostile URL is stored, and the
failure surfaces hours later as an indistinguishable delivery error.

**Errors** — `destination_url_rejected`, permanent, with a message that explains the policy
("This destination is not permitted") and never echoes the rejected URL back in full.

**Security** — rejection messages must not leak the URL. The user submitted it, but the error
may be logged or shown to another workspace member.

**Tests**
- `invalid_url_is_rejected_at_save_time_and_never_persisted`
- `send_time_revalidation_catches_a_post_save_policy_change`
- `rejection_message_does_not_echo_the_full_url`

**Deps** — F91, F102.

---

## F97 — Destination credential storage and rotation

**Priority** P0 · **Status** partial

**Acceptance**
- [ ] Credential material is encrypted **before** D1, never after.
- [ ] Ciphertext is bound to its row via AAD (F36), so a ciphertext cannot be moved between
      destinations.
- [ ] Each row carries `key_version`, so rotation does not require a full rewrite.
- [ ] Rotation is available per destination and takes effect for the next delivery, not the
      next event batch.
- [ ] The UI shows the credential **masked**, never in full after creation.
- [ ] Revocation is available and takes effect immediately.

**Design** — Today `integrations.webhook_ciphertext` holds the destination URL. That is the
right shape. What is missing is AAD binding (D6): without it, a ciphertext swapped between two
`integrations` rows decrypts cleanly and is delivered to the wrong destination.

**Errors** — a failed decrypt is `destination_credentials_invalid` and raises an alert; it is
never retried blindly, because a wrong key will never become right.

**Security** — see F36.

**Tests** — `ciphertext_is_bound_to_its_row_via_aad`; `credential_is_masked_in_all_reads`;
`rotation_takes_effect_on_the_next_delivery`.

**Deps** — F36.

---

## F98 — Destination health and verification

**Priority** P0 · **Status** not started

**Story** As a user setting up for the first time, I want to press "send a test" and know it
worked, so that I trust the connection before real events depend on it.

**Acceptance**
- [ ] A **test delivery** endpoint sends a synthetic canonical event through the real
      renderer and the real `send`. It does not take a shortcut.
- [ ] The test event is a real canonical envelope flagged `test: true`, routed through the
      actual pipeline, and excluded from statistics and billing.
- [ ] The result shows: rendered payload preview, HTTP status, provider response code,
      classified taxonomy code, and a plain-language explanation.
- [ ] It is available during onboarding before any event type is selected.
- [ ] For capability-gated destinations, the test reports exactly what it could and could not
      verify (e.g. "this does not confirm the message can be edited later").

**Design** — `docs/PRODUCT.md` requires ≥80% of new users to complete their **first delivery**
without developer help. A working test message is the teachable moment and the proof that the
whole path functions. It is a P0 onboarding feature, not a debug affordance.

**Errors** — the test surfaces the exact taxonomy code and the user-facing message from F13,
never a raw provider body.

**Security** — the rendered payload preview must show a **redacted** credential, since a
Lark/Slack webhook URL is a bearer secret that appears inside some card payloads.

**Tests**
- `test_delivery_uses_the_real_renderer_and_send_path`
- `test_delivery_reports_the_classified_error_code`
- `test_payload_preview_redacts_credentials`
- `test_delivery_is_excluded_from_statistics`

**Deps** — F91, F216 (onboarding).

---

## F99 — Delivery result normalisation

**Priority** P0 · **Status** partial — classifiers return `{outcome, reason, retryAfterMs?}` with RFC 9110 `Retry-After`; not yet persisted · **Fixes** part of D11

**Story** As an operator, I want every provider's response normalised into one result shape,
so that the dashboard and retry policy do not special-case Slack forever.

**Acceptance**
```ts
type SendResult =
  | { ok: true;  providerMessageId?: string; providerTs?: string }
  | { ok: false; code: TaxonomyCode; retryable: boolean;
      retryAfterSeconds?: number; detail?: string /* redacted */ };
```

- [ ] `providerMessageId` is captured where the provider returns one — it is the **only**
      route to `canUpdate` and to client-side dedup.
- [ ] `retryAfterSeconds` is populated from `Retry-After` (RFC 9110 §10.3: `delay-seconds`
      or `HTTP-date`) or a provider equivalent, and **overrides** our computed backoff.
- [ ] `detail` is redacted through F12 before it is stored.
- [ ] Acknowledgement is **not** confirmation. Teams Workflows returns **202 Accepted with no
      meaningful body** — the flow can still fail after the 202. `ok: true` for Teams means
      "accepted", and the UI must say so rather than "Delivered".

**Design** — The Teams case is the reason this type exists. Collapsing "accepted" and
"delivered" into one success state is how a product ends up claiming delivery it cannot
prove. `AGENTS.md` is explicit: *"No fabricated benchmarks... No silent loss."* An honest
"Accepted by Teams" is better than a confident "Delivered" that is sometimes false.

**Errors** — an unmapped provider response becomes `destination_unavailable` (5xx) or
`internal_error`, **and raises a metric** so the mapping can be completed.

**Security** — `detail` never contains a URL, token or provider response body that echoes one.

**Tests**
- `every_destination_normalizes_into_send_result`
- `retry_after_is_parsed_from_both_rfc9110_forms`
- `retry_after_overrides_computed_backoff`
- `teams_202_is_reported_as_accepted_not_delivered`

**Deps** — F13, F91.

---

## F100 — Provider acknowledgement semantics in the UI

**Priority** P1 · **Status** partial — classifiers distinguish `accepted` (Teams) from `delivered`; UI not started

**Story** As a customer, I want the delivery log to tell me the truth about whether my
notification arrived, so that I can trust it enough to delete my own alerting.

**Acceptance**
- [ ] Delivery states distinguish `accepted` from `delivered`, where the provider allows it.
- [ ] Per-destination truthfulness:
      | Destination | What a success actually means |
      |---|---|
      | Lark custom bot | `code: 0` — delivered |
      | Lark app | `code: 0` + `message_id` — delivered |
      | Slack webhook | HTTP 200 body `ok` — delivered |
      | Slack Web API | `ok: true` + `ts` — delivered |
      | Discord (`wait=true`) | returns the created message — **delivered** |
      | Discord (`wait=false`, default) | 204 — **not** confirmation |
      | Teams Workflows | 202 — **accepted only** |
      | Telegram | returns `message_id` — delivered |
- [ ] ⚠️ **Discord must always send `wait=true`.** Otherwise Discord returns 204, the
      message id is unknown, and the message can never be updated or deleted — and a silently
      dropped message is undetectable.
- [ ] The UI never labels `accepted` as `delivered`.

**Errors** — n/a; this is presentation honesty.

**Security** — n/a.

**Tests** — `ui_never_labels_accepted_as_delivered`; `discord_sends_wait_true`.

**Deps** — F99, F213.

---

## F101 — Lark dual-mode credentials

**Priority** P1 · **Status** partial — custom-bot mode stores the domain and sets `config.summary.content`; app-bot mode not started

**Story** As a Lark customer, I want a zero-setup webhook option and a powerful app option,
so that I can start now and upgrade when I need message editing.

**Acceptance**
- [ ] Two credential types, explicitly distinguished in the data model and the UI:

| | Custom bot webhook | App bot |
|---|---|---|
| Credential | paste URL | OAuth app install |
| `canUpdate` | ❌ | ✅ via card PATCH |
| `supportsServerSideIdempotency` | ❌ | ✅ `uuid`, 1 h window |
| `canReply` | ❌ | ✅ |
| Admin approval | **not required** | required |
| Domains | `open.larksuite.com` **or** `open.feishu.cn` — **not interchangeable** | same |

- [ ] The domain is stored, because *"a webhook issued on one domain will not work on the
      other."*
- [ ] Custom bots **cannot be created programmatically** — there is no OpenAPI for it. The
      setup UI is a guided, screenshot-annotated paste flow. This is the one destination where
      pasting is unavoidable, and the copy must say so.
- [ ] `config.update_multi: true` is set on card messages destined for the app API — Lark's
      card PATCH *"only supports shared cards"*, and JSON 2.0 only allows `true`, so every 2.0
      card is already shared.
- [ ] `config.summary.content` is set. The current renderer sets none, so **the chat-list
      preview is blank** — a real, visible defect in `src/connectors/destinations/lark/webhook.ts`.

**Design** — `docs/LARK_REFERENCE_ARCHITECTURE.md` already specifies both modes (item 5) and
this feature is its implementation. Getting the modes distinct from day one avoids the
migration a single-mode design would force.

**Errors** — see F102 for the DLP gate, which is Lark-specific and GitHub-triggered.

**Security** — the custom-bot URL is a bearer secret; the app access token is encrypted (F36).

**Tests** — `lark_domain_is_stored_and_enforced`; `app_mode_sets_update_multi_true`;
`app_mode_sends_a_uuid_idempotency_key`; `card_includes_summary_content`.

**Deps** — F97.

---

## F102 — Lark DLP and rate-limit handling

**Priority** P1 · **Status** partial — DLP masking, `230028` permanent, throttling classified by code not status, unmapped codes flagged; per-mode rate limiters and hour offset not started · **New, from research**

**Story** As a GitHub→Lark customer, I want my CI notifications to actually arrive, so that
I can rely on them.

**Acceptance**
- [ ] ⚠️ **Sanitize before sending.** Lark error `230028`: *"消息DLP审查未通过，当消息内容中
      含有明文电话号码、明文个人邮箱等内容时可能会触发该错误"* — the DLP audit fails on **plaintext
      phone numbers and personal email addresses**. GitHub payloads contain both, routinely
      (commit author emails, issue bodies). This is a **predictable dead-letter cause specific
      to our wedge** and must be handled in the renderer, not discovered in production.
- [ ] A redaction step masks emails and phone-like strings in **free-text** fields before
      rendering, with `redacted_fields` recorded.
- [ ] `230028` is classified permanent, with the message "This notification contained personal
      contact details that Lark's DLP policy blocks. Contact details were removed."
- [ ] Rate limits: **custom bot 100/min and 5/sec**, distinct from app bots
      (tier 4 = 1000/min and 50/sec, plus 5 QPS per target). These are different numbers and
      a single global limiter will break one of them.
- [ ] ⚠️ **Legacy OpenAPIs may return HTTP 400 instead of 429** for throttling. Classify on the
      `x-ogw-ratelimit-*` headers and `code: 99991400`, **not** on HTTP status alone.
- [ ] Lark warns against sending on the hour and half-hour (error `11232` from system
      pressure). Avoid whole/half-hour boundaries with a small deterministic offset.
- [ ] ⚠️ **Unknown codes are expected.** The canonical error-code table 404s; `0`, `9499`,
      `19021`, `19022`, `19024`, `11232`, `2300xx` and `99991400` are verified individually.
      Do **not** assert a complete mapping. Unmapped codes raise a metric.

**Design** — The DLP gate is the single most likely cause of a GitHub→Lark dead letter, and
it is entirely preventable. It should be a renderer-level redaction with a test fixture, not
a runbook entry.

**Errors** — see above.

**Security** — PII redaction is a privacy control as well as a delivery fix. GitHub commit
author emails are personal data.

**Tests**
- `emails_and_phone_numbers_are_redacted_before_lark_send`
- `error_230028_is_permanent_with_a_specific_message`
- `legacy_400_throttle_is_classified_by_code_not_status`
- `custom_bot_and_app_rate_limits_are_enforced_separately`
- `unmapped_lark_code_raises_a_metric`

**Deps** — F94, F13.

---

## F103 — Slack dual-mode credentials

**Priority** P0 · **Status** partial — incoming-webhook adapter (Block Kit + text fallback, classifier); OAuth install and Web API mode not started · **Fixes** D8

**Story** As a Slack customer, I want a one-click "Add to Slack" button, so that I am not
copying webhook URLs out of Slack settings.

**Acceptance**
- [ ] **Preferred path — Slack app OAuth with the `incoming-webhook` scope.** Slack documents
      that this scope *"triggers a user-facing channel picker in the OAuth 2.0 installation
      sequence"*, and the OAuth response contains `incoming_webhook.url` plus `channel_id`.
      The customer picks a channel in Slack's UI; we never see the picker. **This is the
      gold-standard onboarding UX of all six destinations and should be the default path.**
- [ ] **Fallback — paste a webhook URL**, for customers who cannot install an app.
- [ ] App-based webhooks **cannot override channel, username or icon** — Slack: *"You cannot
      override the default channel (chosen by the user who installed your app), username, or
      icon."* The renderer must not attempt it, and the UI must not offer it.
- [ ] The stored credential is the URL. ⚠️ *"Your webhook URL contains a secret… Slack actively
      searches out and revokes leaked secrets."* Encrypted, never logged, never shown in full.
- [ ] ⚠️ **Do not state that Slack is deprecating incoming webhooks.** It is not. App-based
      incoming webhooks are Slack's recommended path with no announced sunset. What is
      deprecated is *legacy custom integrations*, which carry an **undated** "will be
      deprecated and possibly removed" warning. `X-Hub-Signature`-style claims of a sunset date
      must not appear in our docs.
- [ ] The Web API mode (`chat.postMessage`) is available where update/threading is needed,
      with `chat:write` — and `chat:write.public` if posting to any public channel.
- [ ] ⚠️ **Slack provides no server-side idempotency.** `client_msg_id` is **not** a documented
      `chat.postMessage` argument: it is absent from the method reference, has zero
      occurrences in `@slack/web-api@8.2.0` types, and all 15 hits in Slack's 8.6 MB platform
      doc are *response* fields. Dedup is client-side (F112).
- [ ] `internal_error` and `fatal_error` both warn *"It's possible some aspect of the
      operation succeeded before the error was raised"* — i.e. Slack explicitly warns you may
      have a **duplicate**. The ledger must tolerate this.

**Design** — Slack's own rate-limit docs note *"Calls to other methods on behalf of this
workspace are not restricted"*, so the cooldown is per-method-per-workspace, not global.

**Errors** — the full transient/permanent mapping is in `docs/DESTINATION_API_REFERENCE.md`
§1.3. `message_limit_exceeded` is a **workspace plan** limit, not our bug, and should say so.

**Security** — the webhook URL is a bearer secret in a URL, which means it will appear in
proxy logs, browser history and support screenshots. The UI must warn about this explicitly.

**Tests**
- `slack_oauth_returns_channel_and_url`
- `app_webhook_renderer_does_not_attempt_identity_override`
- `slack_send_uses_a_valid_adapter_not_an_inline_string`
- `slack_rate_limit_is_honoured_with_retry_after`

**Deps** — F91, F97.

---

## F104 — Teams Workflows as the only MVP path

**Priority** P0 · **Status** partial — Workflows adapter (Adaptive Cards only, host-pattern allowlist, `anyone` auth only, 28 KB budget); orphan-flow surfacing not started

**Story** As a Microsoft 365 customer, I want a Teams destination that a non-technical
administrator can set up, so that notifications actually reach my team.

**Acceptance**
- [ ] ⚠️ **Office 365 Connectors are dead and must not appear as an option.** They were
      *"progressively disabled"* from **18 to 22 May 2026** — *"This is the final deprecation
      timeline"*. Today is October 2026.
- [ ] ⚠️ **`learn.microsoft.com` still serves live "create connector" pages** with working
      manifests and only a soft "nearing deprecation" banner. **The Learn docs are stale
      relative to the devblog and Message Center MC1181996.** The devblog is authoritative.
      This is the most likely way a future contributor re-adds a dead integration.
- [ ] Only **Workflows** (`When a Teams webhook request is received`, operation
      `TeamsIncomingWebhookTrigger`) ships in V1. No premium licence is required — *"does not
      require a premium license"* — which is why it is the only path a non-technical customer
      can complete without IT.
- [ ] **Adaptive Cards only.** *"Interactive cards are not supported for MessageCard-formatted
      payloads."* `contentType: "application/vnd.microsoft.card.adaptive"`, `contentUrl: null`.
- [ ] ⚠️ **The trigger URL is opaque.** It is not documented in a form we can validate, so
      the SSRF allowlist must be **pattern-based** (`*.logic.azure.com:443` and regional
      variants), never exact-path-based. Treat the URL as a secret string.
- [ ] The 28 KB message limit is enforced at render time (F95). Over → "Request Entity too
      large".
- [ ] `@` mentions are capped at **20 users and 20 tags**; enforce or drop.
- [ ] ⚠️ **Authentication mode must be captured at setup.** `triggerAuthenticationType`
      ∈ `Anyone` | `Any user in my tenant` | `Specific users in my tenant`. *"Do not pass an
      authentication token header if you selected the 'Anyone' option, or POST requests to the
      trigger will fail."* The customer must tell us which mode they chose; getting it wrong
      fails every delivery.
- [ ] ⚠️ **Orphan flows are a permanent failure mode.** *"Workflows are linked only to specific
      users (referred to as owners of the workflow) and not to a Teams team or channel."* If
      the creating user leaves, the flow breaks silently. The dashboard must warn the owner
      and offer a health check.
- [ ] ⚠️ **Private channels are unproven.** The devblog (April 2026) says private channels
      are supported; the currently-published connector reference says they are not. Treat as
      **unproven** and require real-tenant verification before claiming support.
- [ ] GCC/GCCH/DoD is unsupported (Flow Bot), failing with `BotNotInConversationRoster`.

**Design** — Bot Framework is offered later as the "managed" tier: you control registration,
hold conversation IDs, get message IDs (enabling `canUpdate` and client-side dedup), and avoid
orphan flows. Costs: Entra app registration, tenant admin consent, Graph permissions, Azure
Bot Service, and an ~80 KB message budget. The honest product language is *"quick setup,
customer-owned, no read-back, no branding"* vs *"requires admin approval, gives message IDs
and update-in-place"*.

**Errors** — 202 is **accepted**, not delivered (F100). A flow turned off in Teams fails
silently — detect via F98 health checks and F105.

**Security** — the trigger URL is a bearer secret. The allowlist must be pattern-based and
must not follow redirects (F102).

**Tests**
- `teams_never_offers_office365_connectors`
- `teams_allowlist_is_pattern_based_and_rejects_other_hosts`
- `teams_uses_adaptive_cards_never_messagecards`
- `teams_respects_the_28kb_limit`
- `teams_auth_mode_is_captured_at_setup`
- `orphan_flow_risk_is_surfaced_in_the_dashboard`

**Deps** — F91, F96, F100.