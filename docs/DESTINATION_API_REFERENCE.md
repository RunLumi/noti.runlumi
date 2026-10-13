# Destination API reference (verified October 2026)

Research date: **2026-10-13**. Every claim below is cited. Anything I could not verify from a
primary source is in a `⚠️ UNVERIFIED` or `⚠️ CONFLICT` block and must be treated as unknown,
not as fact. No claim in this document comes from memory or from a blog post unless the blog
post is explicitly labelled as such.

Notation: `⚠️` = gap or conflict.

---

## 0. Cross-destination summary

| Destination | Outbound endpoint | Auth | Server-side idempotency | Programmatic onboarding | Setup friction |
|---|---|---|---|---|---|
| Slack | `POST https://hooks.slack.com/services/...` (app webhook) | Secret in URL | **None** | **Yes** — OAuth + `incoming-webhook` scope returns the URL | Low (paste URL) |
| Slack (Web API) | `POST https://slack.com/api/chat.postMessage` | Bot token `chat:write` | **None documented** | **Yes** — OAuth install | Medium (app install) |
| Microsoft Teams | Power Automate / Logic Apps flow trigger URL | Secret in URL + optional Entra JWT | **None** | **No** — user builds the flow, pastes URL | **High** |
| Microsoft Teams (Bot) | Bot Framework / Graph | Entra ID app + bot token | **None** | **Yes** — OAuth install | High |
| Lark / Feishu | `POST https://open.larksuite.com/open-apis/bot/v2/hook/...` | Secret in URL (+ optional HMAC sign) | **None** | **No** — manual setup in chat | Low (paste URL) |
| Lark / Feishu (App) | `POST https://open.larksuite.com/open-apis/im/v1/messages` | `tenant_access_token` | **Yes — `uuid`, 1-hour window** | **Yes** — app + scopes | High (admin approval) |
| Discord | `POST https://discord.com/api/v10/webhooks/{id}/{token}` | Secret in URL | **None** | Yes (bot OAuth w/ `MANAGE_WEBHOOKS`) | Low–Medium |
| Telegram | `POST https://api.telegram.org/bot{token}/sendMessage` | Bot token in URL | **None** | **No** — token is issued to one bot owner | **Very high** (single-tenant bot) |
| Email | Provider HTTP API / CF binding | API token | Varies | Yes (customer adds own domain) | Low |

**Single most important finding for the spec:** as of today, **three** of six destinations
(Teams Workflows, Lark custom bot, Telegram) cannot be provisioned by a SaaS programmatically
and require the customer to paste a URL or hand over credentials. Telegram is the worst: a bot
token belongs to one bot, so multi-tenant SaaS delivery to Telegram requires a **Bot API
Enterprise** relationship with Telegram, not a per-customer token. See §6.

---

## 1. Slack

### 1.1 Incoming Webhooks — status

**App-based incoming webhooks are current and not deprecated.** Slack publishes them as the
recommended path: "Sending messages using incoming webhooks"
(<https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks>).

**Legacy custom integrations are the deprecated flavour.** Slack keeps the legacy docs live
under `/legacy/` and tells you to move: "If you previously created any incoming webhooks using
legacy custom integrations, you should switch to using the same functionality with a Slack app
instead." (<https://docs.slack.dev/legacy/legacy-custom-integrations/legacy-custom-integrations-incoming-webhooks>)

The Marketplace listing for the old "Incoming WebHooks" app carries the notice "These
integrations lack newer features and they will be deprecated and possibly removed in the
future. We do not recommend their use." — **this quote comes from the Slack Marketplace listing
surfaced via web search, not from `docs.slack.dev`.** I could not load
`https://slack.com/marketplace/A0F7XDUAZ-incoming-webhooks` directly.

> ⚠️ **UNVERIFIED — there is no official sunset date for legacy incoming webhooks.** Slack's
> published deprecation timeline covers *classic apps* and *legacy custom bots*, and nothing
> else. The page body is literally: "Beginning **November 16, 2026**, classic apps will no
> longer function… Beginning **March 31, 2025**, legacy custom bots will no longer function."
> (<https://docs.slack.dev/changelog/2024-09-legacy-custom-bots-classic-apps-deprecation>).
> Do **not** write "Slack is deprecating incoming webhooks" in the spec. The correct statement is:
> *legacy custom-integration webhooks are discouraged and carry an undated deprecation warning;
> app-based incoming webhooks are the supported path and have no announced sunset.*

**Behavioural difference that matters for the renderer** (official, same legacy page):
legacy webhooks accept runtime `channel`, `username`, `icon_emoji`, `icon_url` overrides;
app webhooks **cannot** — "You **cannot override** the default channel (chosen by the user who
installed your app), username, or icon when you're using incoming webhooks to post messages."
(<https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks>)

### 1.2 Incoming Webhooks — endpoint, auth, errors

- **Endpoint:** `POST https://hooks.slack.com/services/T…/B…/XXXX`
  (GovSlack: `slack-gov.com`.)
- **Auth:** the URL *is* the credential. Slack: "Your webhook URL contains a secret… **Slack
  actively searches out and revokes leaked secrets.**"
- **Success body:** literal text `ok`. Note this is *not* JSON.
- **Idempotency:** none.
- **Cannot delete/update.** "Incoming webhooks do not allow you to delete a message after it's
  been posted." Threading requires an externally-sourced `ts` (Events API,
  `assistant.search.context`, or `conversations.history`) — the webhook response does not return one.
- **Error semantics** (official table, same page):
  - HTTP 400 / `invalid_payload` → permanent, do not retry.
  - HTTP 403 / `action_prohibited` → permanent ("should not be attempted again").
  - HTTP 404 / `no_service`, `no_service_id` → permanent (URL revoked/removed).
  - `channel_is_archived`, `user_not_found`, `channel_not_found`, `team_disabled` → permanent.
  - `no_active_hooks` → permanent.
  - `no_text`, `too_many_attachments` → permanent (payload bug).
  - HTTP 429 → transient; honour `Retry-After`.
  - Changelog with full matrix: <https://docs.slack.dev/changelog/2016-05-17-changes-to-errors-for-incoming-webhooks>

### 1.3 Web API `chat.postMessage`

- **Endpoint:** `POST https://slack.com/api/chat.postMessage`
  (<https://docs.slack.dev/reference/methods/chat.postMessage>)
- **Scopes:** `chat:write` for both bot and user tokens. To post to *any* public channel you also
  need `chat:write.public` — "New Slack apps do not begin life with the ability to post in all
  public channels."
- **Content types:** `application/json` or `application/x-www-form-urlencoded`.
- **Rate limit tier:** the page's *Facts* section says **"Special rate limits apply."** The raw
  frontmatter says `rate_limit: "t5"`.
  > ⚠️ Minor internal inconsistency on Slack's own page. Treat as "special tier", not Tier 5.
- **Threading:** `thread_ts` = parent message ts; `reply_broadcast: true` to surface the reply in
  the channel. Slack explicitly says "Avoid using a reply's `ts` value; use its parent instead."
- **`client_msg_id` — IMPORTANT NEGATIVE FINDING.** `chat.postMessage`'s documented argument list
  contains **no `client_msg_id`**. Yet the error table defines `duplicate_message_not_found`
  ("No duplicate message exists associated with `client_msg_id`") and `duplicate_channel_not_found`.
  I verified three ways:
  1. The full `chat.postMessage` reference page (fetched in both HTML and `.md`) — argument absent.
  2. `@slack/web-api@8.2.0` `dist/types/request/chat.d.ts` — zero occurrences (also checked v7.0.4).
  3. A full scan of `https://docs.slack.dev/llms-full-platform.txt` (8.6 MB, the entire
     language-agnostic platform docs): **15 occurrences, all as a response/event field** on
     message objects (`oversight`, `thread_broadcast` events, message examples) — never as a request argument.

  **Conclusion: Slack provides no documented server-side idempotency for `chat.postMessage`.**
  Spec must implement dedupe client-side (persist `ts` from the response, key by delivery id).

- **Rate limits** (<https://docs.slack.dev/apis/web-api/rate-limits>): "Posting messages — 1 per
  second. Short bursts >1 allowed." Method page: "It will generally allow an app to post 1 message
  per second to a specific channel… limiting posting to several hundred messages per minute."
- **429 handling:** Slack returns `HTTP 429` + `Retry-After: <seconds>`. Documented for all
  HTTP-based APIs including webhooks. Slack explicitly says "Calls to other methods on behalf of
  this workspace are not restricted" — so the cooldown is per-method-per-workspace.
- **Error semantics (transient vs permanent):**
  - Transient/retry: `ratelimited` / `rate_limited`, `internal_error`, `fatal_error`,
    `service_unavailable`, `request_timeout`. Note `fatal_error` and `internal_error` both say
    *"It's possible some aspect of the operation succeeded before the error was raised"* — Slack
    explicitly warns you may have a **duplicate**. Your delivery ledger must tolerate this.
  - Permanent/dead-letter: `channel_not_found`, `is_archived`, `no_permission`, `not_in_channel`,
    `missing_scope`, `invalid_blocks`, `invalid_blocks_format`, `msg_blocks_too_long`,
    `no_text`, `invalid_auth`, `token_revoked`, `token_expired`, `account_inactive`,
    `team_not_found`, `ekm_access_denied`, `restricted_action*`, `team_disabled`,
    `posting_to_general_channel_denied`.
  - `message_limit_exceeded` is a **workspace-plan** limit (Free plan), not your bug.

### 1.4 Web API `chat.update` (for CI status-card dedup)

- **Endpoint:** `POST https://slack.com/api/chat.update`
  (<https://docs.slack.dev/reference/methods/chat.update>)
- **Scopes:** `chat:write` (bot or user).
- **Rate limit:** **Tier 3: 50+ per minute** (explicitly listed in its Facts section).
- **Requires `channel` + `ts`.** "Only messages posted by the authenticated user are able to be
  updated." Bot messages can be updated by the same bot.
- **Sharp edge for a card renderer:** "If blocks are used and a message is being updated, the
  `edited` flag will not be displayed… If the `text` argument is provided and `blocks` are not
  provided, the blocks will be removed." So always send `text` *and* `blocks` together, and give
  every update a **new `block_id`** — "If a message is updated, use a new `block_id`."
- Permanent errors: `cant_update_message`, `message_not_found`, `edit_window_closed`,
  `is_inactive`, `invalid_blocks`, `block_mismatch`, `msg_too_long`, `no_dual_broadcast_content_update`.
- Transient: `ratelimited`, `internal_error`, `update_failed`.

### 1.5 Events API vs Web API (outbound)

**Not a choice — they are different directions.** The Events API delivers events *from Slack to
your app*; the rate-limit doc describes "Event deliveries to your server via the Events API"
(<https://docs.slack.dev/apis/web-api/rate-limits>). All outbound sending is Web API
(`chat.postMessage` / `chat.update`) or an incoming webhook. There is no Slack "Events API send"
operation.

Adjacent fact: the Events API inbound cap is 30,000 deliveries per workspace/team/app/60 min, and
you get an `app_rate_limited` event when exceeded — relevant only to source-side fan-in.

### 1.6 Formatting / Block Kit limits

| Limit | Value | Source |
|---|---|---|
| Blocks per message | **50** | <https://docs.slack.dev/reference/block-kit/blocks> |
| Blocks per modal / Home tab | 100 | same |
| `section.text` | 1–**3000** chars | <https://docs.slack.dev/reference/block-kit/blocks/section-block> |
| `section.fields` | max **10** items, **2000** chars each | same |
| `block_id` | max **255** chars; unique per message **per iteration** | same |
| Attachments | max **100** per message | chat.postMessage errors |
| `text` field | 4,000 chars recommended; Slack truncates >**40,000** | chat.postMessage |
| `markdown_text` | max **12,000** chars; cannot combine with `text`/`blocks` | chat.postMessage |
| RTM message size | 16 KB hard disconnect (legacy only) | rate-limits page |

Accessibility requirement Slack calls out explicitly (and it matches your AGENTS.md WCAG goal):
"screen readers will default to the top-level text field of your post, and will not read the
content of any interior blocks". Always populate top-level `text` as a full fallback.

### 1.7 Credential provisioning

**Yes, fully programmatic.** Include `incoming-webhook` in the OAuth `scope` list. "This scope
enables incoming webhooks and **triggers a user-facing channel picker in the OAuth 2.0
installation sequence**" (<https://docs.slack.dev/reference/scopes/incoming-webhook>). The OAuth
response then contains:

```json
"incoming_webhook": {
  "channel": "#channel-it-will-post-to",
  "channel_id": "C05002EAE",
  "configuration_url": "https://workspacename.slack.com/services/BXXXXX",
  "url": "https://hooks.slack.com/TXXXXX/BXXXXX/XXXXXXXXXX"
}
```

So the flow is: user clicks "Add to Slack" → picks channel in Slack's UI → you receive the URL →
store encrypted. **No pasting.** This is the gold-standard onboarding UX among all six destinations.

### 1.8 Slack rate-limit tiers (full table)

From <https://docs.slack.dev/apis/web-api/rate-limits>: Tier 1 = 1+/min, Tier 2 = 20+/min,
Tier 3 = 50+/min, Tier 4 = 100+/min, Special = per-method. "All Slack plans receive the same
rate limit tier for each method." Slack deliberately does **not** publish exact burst limits.

2025 change to note: effective **May 29, 2025**, newly-created commercially-distributed apps
**not** approved for the Marketplace face new limits on `conversations.history` /
`conversations.replies` (internal apps and Marketplace apps are exempt).
(<https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps>,
clarified <https://docs.slack.dev/changelog/2025/06/03/rate-limits-clarity>).

---

## 2. Microsoft Teams

### 2.1 Office 365 Connectors — RETIRED, and already past

**Microsoft 365 / Office 365 Connectors were permanently disabled on 18–22 May 2026.** Today is
13 October 2026, so this path is **dead** and must not appear anywhere in the spec as a current option.

> "Update 4/14/2026: New information related to Office 365 Connectors Retirement in Teams – Final
> Deprecation… Office 365 Connectors will be progressively disabled on the following schedule:
> Rollout begins: **May 18, 2026**; Rollout completes: **May 22, 2026**. After these dates, Office
> 365 Connectors will no longer function."
> — <https://devblogs.microsoft.com/microsoft365dev/retirement-of-office-365-connectors-within-microsoft-teams/>

Corroborated by Microsoft 365 Message Center **MC1181996** (same dates, "This is the final
deprecation timeline"): <https://mc.merill.net/message/MC1181996> (third-party mirror of the
MMC; the primary `microsoft.com` MMC requires tenant auth — flag that I could not reach the
tenant-authenticated original).

Full timeline history (useful for the ADR): Wave 1 blocked new connectors 15 Aug 2024; Wave 2
stopped them working 1 Oct 2024; webhook URL migration deadline 31 Jan 2025; end-of-2025
retirement; extended 31 Mar 2026 → 30 Apr 2026 → final 18–22 May 2026.

> ⚠️ `learn.microsoft.com` **still serves live "create connector" pages** with manifests and
> sample code (e.g. <https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/connectors-creating>,
> <https://learn.microsoft.com/en-us/microsoftteams/m365-custom-connectors>). Both carry only a
> soft "nearing deprecation" banner. **The Learn docs are stale relative to the devblog and MMC.**
> Do not trust the Learn banner alone; the devblog + MMC are authoritative.

### 2.2 Teams Workflows (Power Automate) — the official replacement

Template: **"Post to a channel when a webhook request is received"** (and the chat equivalent).
Built on the connector trigger `When a Teams webhook request is received`, operation ID
`TeamsIncomingWebhookTrigger`.

**Licensing — good news:** "Using these templates and the Teams webhook trigger **does not require
a premium license** to use."
(<https://support.microsoft.com/en-us/office/create-incoming-webhooks-with-workflows-for-microsoft-teams-8ae491c7-0394-4861-ba59-055e33f75498>)

**Can a third-party app call the URL?** Yes — it is a public HTTPS endpoint. But there is an
authentication mode you must handle (below).

**Request body schema** (official,
<https://learn.microsoft.com/en-us/connectors/teams/>):

```json
{
  "type": "message",
  "attachments": [{
    "contentType": "application/vnd.microsoft.card.adaptive",
    "contentUrl": null,
    "content": {
      "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
      "type": "AdaptiveCard",
      "version": "1.2",
      "body": [ { "type": "TextBlock", "text": "…" } ]
    }
  }]
}
```

- `type` — **required**, must be `"message"`.
- `attachments` — array; each item needs `contentType` (exactly
  `application/vnd.microsoft.card.adaptive`), `contentUrl` (required, must be `null`), `content`
  (the card object).
- A bare MessageCard body (`{"@type":"MessageCard","@context":"http://schema.org/extensions",…}`)
  is also accepted.

**Response:** **HTTP 202 Accepted**, no meaningful body. This is acknowledge-on-receive, *not*
delivery confirmation. Community reports consistently confirm 202 for both MessageCard and
AdaptiveCard, and confirm the flow can fail *after* the 202.

> ⚠️ **CONFLICT — MessageCard interactivity.** The devblog (4/14/2026 update) says: "Interactive
> cards are not supported for MessageCard-formatted payloads. MessageCard-formatted payloads will
> render content but will not support HttpPost action buttons… you will need to use Adaptive Cards."
> The connector reference says the same: "This trigger also does not support actionable messages,
> unlike deprecated Office Webhooks." **Use Adaptive Cards.**

> ⚠️ **CONFLICT — private channels.** The devblog says "Private channels are now supported for
> Workflows webhooks through the Power Automate portal" (April 2026). But the currently-published
> connector reference still says "**Posting a message or adaptive card to a private channel
> currently isn't supported**" and "Workflows can currently post messages on behalf of a user."
> These are both official and they disagree. Treat private-channel Workflows delivery as
> **unproven** and require real-tenant verification before shipping a claim.

**Authentication modes on the trigger** (`triggerAuthenticationType`):
- `Anyone` — "Do not pass an authentication token header if you selected the 'Anyone' option, or
  POST requests to the trigger will fail."
- `Any user in my tenant` / `Specific users in my tenant` — "you will need to pass an
  authentication token in requests to the When a Teams webhook request is received trigger."
  See MS docs on adding OAuth auth to HTTP request triggers.
  → Your onboarding UI must let the customer pick, and your Worker must know which mode it is in.

**Other documented constraints:**
- Message size: "**approximately 28 KB**. This limit includes all HTML elements such as text,
  images, links, tables, mentions and so on. If the message size exceeds 28 KB, the action fails
  with the error '**Request Entity too large**'."
- `@`-mentions: "A single message can @mention only up to **20 users and 20 tags**."
- Requires the Workflows app to be in the "allow" state in the Teams admin center.
- Flow Bot is **not supported in GCC/GCCH/DoD**; fails with
  `BotNotInConversationRoster - The bot is not part of the conversation roster`.
- "Workflows are linked only to specific users (referred to as owners of the workflow) and not to
  a Teams team or channel." → **orphan-flow risk**: if the creating user leaves, the flow breaks
  silently. This is a real, permanent failure mode for a SaaS.
- "Messages can't be posted if the Workflow is turned off in Teams."

> ⚠️ **UNVERIFIED — URL structure.** The `sig`/`sp`/`sv`/`api-version=2016-06-01` Logic Apps URL
> shape (`https://<region>.logic.azure.com:443/workflows/<id>/triggers/manual/paths/invoke?api-version=…&sp=…&sv=1.0&sig=…`)
> appears throughout community posts and Microsoft Q&A answers, but I could **not** find it stated
> in an official Microsoft page I could load. The official text is only: "The callback URL of the
> trigger will be displayed to you when you save the flow." **Treat the URL as an opaque secret
> string — do not parse or validate its structure.** That also means your SSRF allow-list for
> outbound Teams calls must be pattern-based (`*.logic.azure.com:443` and the
> `*.westus.logic.azure.com`-style regions), not exact-path-based.

> ⚠️ **GAP — Power Automate / Logic Apps request throttling.** I tried
> `https://learn.microsoft.com/en-us/power-automate/limits` (404) and did not retrieve the
> canonical throttling page. There **are** documented per-flow/per-tenant daily and concurrency
> ceilings for Power Automate and Logic Apps that will govern a Workflows-webhook destination, but
> **I did not verify their numbers.** Do not state a number. Retrieve
> `learn.microsoft.com/azure/logic-apps/logic-apps-limits-and-settings` before writing the spec.
> This is a genuine unknown, not a "probably fine".

### 2.3 Bot Framework / Graph path

- **Registration:** Entra ID app registration + bot channel configuration in Azure Bot Service,
  plus a Teams app manifest package. Official entry:
  <https://learn.microsoft.com/en-us/microsoftteams/platform/bot-concepts/> (I got 404s on
  `/bot-basics` and `/bot-concepts/bot-basics` — **⚠️ exact current URL unverified**).
- **Rate limits** (<https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/rate-limit>,
  page dated 2026-07-27, also mirrored in the MicrosoftDocs GitHub source):
  - Per-bot-per-thread, send to conversation: **1 s → 7 ops**, **2 s → 8**, **30 s → 60**, **3600 s → 1800**.
  - Per-app-per-tenant global: **50 requests/second**.
  - "As the exact values of rate limits are subject to change, your application must implement
    the appropriate backoff behavior when the API returns `HTTP 429 Too Many Requests`."
  - Per-thread-for-all-bots (shared): send to conversation 1 s → 14 ops, 2 s → 16.
- **Message size:** "The agent message size limit is **100 KB**… The 100 KB size limitation doesn't
  include base64 encoded images. During implementation, ensure … the message itself is **80 KB** to
  guarantee successful message delivery." Message splitting occurs near the limit and breaks
  proactive update/delete by message ID.
  (<https://learn.microsoft.com/en-us/microsoftteams/platform/bots/build-conversational-capability>)
- **Proactive messaging:** the app must be **installed in the team/channel** first, and you must
  have persisted the `conversationId`. "You can't create a new group chat or a new channel in a
  team with proactive messaging."
  (<https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages>)
- **Graph API alternative:** `chatMessage` supports *Send message in channel* and *Reply to message
  in channel*, which is how large-scale notification senders work.
  (<https://learn.microsoft.com/en-us/graph/api/resources/chatmessage?view=graph-rest-1.0>)
  → Requires a Graph app with tenant admin consent.
- **Cost/licensing:** ⚠️ **I did not verify Azure Bot Service / Entra costs.** Do not quote a number.

### 2.4 Adaptive Cards for Teams

- **Root wrapper:** for a **bot Activity**, the card lives under `attachments[]` with
  `contentType: "application/vnd.microsoft.card.adaptive"`; there is **no** `AdaptiveCard` wrapper
  around the Activity itself. For the **Workflows webhook**, the documented envelope is
  `{"type":"message","attachments":[{contentType, contentUrl:null, content:{type:"AdaptiveCard",…}}]}`
  — i.e. same `attachments` shape, `type: "message"` envelope.
- `Action.OpenUrl` — supported, standard Adaptive Cards action.
- `summary` field: used in the MessageCard-style payload (`"summary": "…"`); it is the
  notification/activity-feed text, **not** the body. For Adaptive Cards the equivalent is
  `config.summary.content` in Lark; for Teams, MS's own examples include a top-level `summary`
  alongside `type: "message"`.
- **Schema version:** MS's own examples use `1.0`, `1.2`, `1.4`, `1.6`.
  > ⚠️ **UNVERIFIED — maximum supported Adaptive Card version for Teams.** I did not find an
  > official "Teams supports up to Adaptive Cards vX" statement. Pin `version` to `1.5`/`1.6`
  > only after testing in a real tenant, or use `1.2` which every MS sample uses.

### 2.5 Recommendation for a commercial SaaS in 2026, and failure modes

**Do not ship Office 365 Connectors.** They are dead.

**Default (MVP): Workflows webhook.** Reasons: no premium licence, no Entra app registration, no
tenant admin consent, and no per-tenant identity plumbing. It is the *only* option a non-technical
customer can complete without IT.

Its failure modes, all of which you must handle:

1. **Orphan flows** — tied to a user, not a team. Owner leaves → silent failure.
2. **No delivery confirmation** — 202 Accepted only. You cannot report success to the user.
3. **Flows can be turned off in Teams** by the customer without warning.
4. **Identity is fixed** — "Messages will display with the default Workflows bot (Flow bot)
   identity. Custom icons and display names are not supported for Adaptive Card payloads." You
   cannot brand as your product.
5. **28 KB hard ceiling** → "Request Entity too large".
6. **Trigger auth mismatch** — sending a token when "Anyone" is set makes every request fail.
7. **Private channels unresolved** (§2.2 conflict).
8. **GCC/GCCH/DoD**: Flow Bot unsupported.

**Offer Bot Framework as the "advanced / managed" tier**, where you control registration, you hold
the conversation IDs, you get message IDs (enabling in-place CI status-card updates and dedup),
and you avoid the orphan-flow problem. Costs: Entra app registration, tenant admin consent, Graph
permissions, Azure Bot Service hosting, and the ~80 KB message budget.

**Honest spec language:** Webhook = "quick setup, customer-owned, no read-back, no branding";
Bot = "requires admin approval, gives message IDs and update-in-place".

---

## 3. Lark / Feishu

### 3.1 Custom group bot webhook

**Endpoint:** `POST https://open.larksuite.com/open-apis/bot/v2/hook/xxxxxxxxxxxxxxxxx`
(Feishu/China domain is the same path on `open.feishu.cn`.)
Header: `Content-Type: application/json`.
Source: <https://open.larksuite.com/document/client-docs/bot-v3/add-custom-bot>

**Domains:** `open.larksuite.com` for Lark; `open.feishu.cn` for Feishu. The two are **not
interchangeable** — a webhook issued on one domain will not work on the other. Your destination
record must store which.

**Signature algorithm — VERIFIED EXACT, and your repo is correct:**

```
stringToSign = timestamp + "\n" + secret          // secret = the bot's 签名校验 key
sign         = Base64( HMAC-SHA256( key = stringToSign, message = "" ) )
```

Official Java/Go/Python samples all agree: the HMAC **key** is `timestamp + "\n" + secret`, and the
**message is empty** (`mac.doFinal(new byte[]{})` / `h.Write(data)` with nil data).
`src/connectors/destinations/lark/webhook.ts:2-7` implements exactly this. ✅

- `timestamp` is **seconds**, and must be within **3600 seconds (1 hour)** of the current time:
  `"timestamp" : "1599360473"`. Failure → `code 19021`.
- Sent as **top-level string fields** alongside `msg_type`:
  `{"timestamp":"1599360473","sign":"…","msg_type":"text","content":{…}}`
- Server-side clock skew causes 19021 — the docs explicitly warn about this.

**Security settings (all three can be combined):**
| Setting | Limit | Failure code |
|---|---|---|
| 自定义关键词 custom keywords | **max 10** | `19024` `Key Words Not Found` |
| IP 白名单 allowlist | **max 10** IPs/ranges, supports `123.12.1.*` and `123.1.1.1/24` | `19022` `Ip Not Allowed` |
| 签名校验 signature | system-generated key, resettable | `19021` `sign match fail or timestamp is not within one hour from current time` |

⚠️ **IP allowlist + Cloudflare Workers is a conflict**: you cannot ask a customer to allowlist
Workers egress IPs (they are not a fixed published set per-account in a way the customer can
pre-allow). Treat IP allowlisting as **unsupported for the SaaS path**; push keyword or signature.

**Rate limits — note these DIFFER from normal apps:**
> "自定义机器人的频率控制和普通应用不同，为单租户单机器人 **100 次/分钟，5 次/秒**。"
> (single tenant, single bot: 100/min, 5/sec)

The frequency-control guide repeats it: "自定义机器人的频率控制和普通应用不同，为 100 次/分钟，5 次/秒。"
(<https://open.larksuite.com/document/ukTMukTMukTM/uUzN04SN3QjL1cDN>)

Plus a Lark-specific operational warning worth putting in your runbook:
> "建议发送消息尽量避开诸如 10:00、17:30 等整点及半点时间，否则可能出现因系统压力导致的
> **11232** 限流错误，导致消息发送失败。"
> (avoid on-the-hour and half-hour marks; you may get rate-limit error **11232** from system pressure)

**Body size:** "发送消息时，请求体的数据大小不能超过 **20 KB**."

**Idempotency:** **none.** No `uuid`, no dedup window. See §3.2 for the app-API alternative.

**Success body:**
```json
{ "StatusCode": 0, "StatusMessage": "success", "code": 0, "data": {}, "msg": "success" }
```
The docs explicitly label `StatusCode`/`StatusMessage` as **redundant legacy fields, not
recommended**. Parse `code === 0`. (Your `larkAccepted()` helper handles both — fine, but prefer `code`.)

**`msg_type` values (custom bot):** `text`, `post` (rich text), `image`, `share_chat`, `interactive` (card).
`interactive` puts the card in a **`card`** field at the top level (NOT `content`):
```json
{ "msg_type": "interactive", "card": { "elements": [ … ], "header": { … } } }
```
> `msg_type` `text`/`post` use `content`; `interactive` uses `card`. They are **not**
> interchangeable. This is a real footgun in the current `src/connectors/destinations/lark/webhook.ts`,
> which correctly uses `card`.

**Card limitations under a custom bot:** "通过自定义机器人发送的消息卡片，只支持通过按钮、文字链方式跳转 URL，**不支持点击后回调信息到服务端的回传交互**" — no interactive callbacks. `@` mentions only work via `open_id`, not `email`/`user_id`.

### 3.2 Lark app (`im/v1`) — needed for a real SaaS

**Endpoint:** `POST https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=<open_id|user_id|union_id|email|chat_id>`
(<https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create>)

- **Auth:** `Authorization: Bearer <tenant_access_token>`; `Content-Type: application/json; charset=utf-8` (fixed value).
- **Scopes** (any one suffices): `im:message`, `im:message:send_as_bot`, `im:message:send`.
  Update scopes: `im:message`, `im:message:send_as_bot`, `im:message:update`.
- **Prerequisites:** bot capability enabled on the app; bot must be **in the group** to post to it;
  bot needs *availability* scope for the user to DM it.

**✅ NATIVE IDEMPOTENCY — the only destination among the six that has it:**
> `uuid` (string, optional) — "由开发者生成的唯一字符串序列，用于发送消息请求去重；持有相同
> `uuid` 的请求 **1 小时内至多成功发送一条消息**"
> Max length **50** characters.

This is real, documented, and cheap to use. Persist the delivery UUID as your idempotency key and
pass it on retry. Lark will collapse duplicates inside the hour.

**Rate limits:** API-level tier 4 = **1000/minute AND 50/second** (per app, per tenant; either ceiling triggers throttling). **Plus** a per-target cap: "向同一用户发送消息的限频为 **5 QPS**，向同一群组发送消息的限频为群内机器人共享 **5 QPS**".

**Size limits:** text body ≤ **150 KB**; card and post ≤ **30 KB**. Error `230025` when exceeded.

**Throttle response:** `HTTP 429` + headers `x-ogw-ratelimit-limit` and `x-ogw-ratelimit-reset`
(seconds to wait), body `{"code":99991400,"msg":"request trigger frequency limit"}`.
> ⚠️ Legacy OpenAPIs may return **HTTP 400 instead of 429** for the same throttling condition.
> Classify on the header/code pair, not on HTTP status alone.

**Card update (the CI-status-dedup primitive):**
`PATCH https://open.larksuite.com/open-apis/im/v1/messages/:message_id`
(<https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/patch>)

Hard requirements, all documented:
- Only `interactive` (card) messages.
- **Only shared cards** — the card must declare `config.update_multi: true` explicitly.
- **Only messages sent within the last 14 days** (`230031`).
- **Not supported for batch messages.**
- 5 QPS per message.
- Message not recalled (`230011`) / not deleted (`230110`).
- Bot must have availability / be in the group (`230013`, `230002`).

**Text/post edit:** `PUT …/im/v1/messages/:message_id` — text and post only, **max 20 edits per message**,
only your own messages, operator must be in the group with send rights.

**`230028` is a DLP gate you must know about:** "消息DLP审查未通过，当消息内容中含有明文电话号码、明文个人邮箱等内容时可能会触发该错误" — message DLP audit fails when content contains **plaintext phone numbers or plaintext personal email addresses**. GitHub notification payloads are full of both. **Sanitize before sending.** This is a real, predictable dead-letter cause for a GitHub→Lark connector.

Other codes: `230001` invalid param, `230006` bot capability off, `230020` throttled, `230025` too long, `230027` external-group not permitted, `230038` cross-tenant P2P forbidden, `230035` send permission denied (group muted / tenant comms policy), `230099` card creation failed, `232009` chat dissolved.

**Frequency tiers** (<https://open.larksuite.com/document/ukTMukTMukTM/uUzN04SN3QjL1cDN>), per API per app per tenant:

| Tier | Limit |
|---|---|
| 1 | 10/min |
| 2 | 20/min |
| 3 | 100/min |
| 4 | **1000/min + 50/s** |
| 5 | 1/s |
| 6 | 5/s |
| 7 | 10/s |
| 8 | 20/s |
| 9 | 50/s |
| 10 | 50/s (100/s for commercial self-built apps) |
| 11 | 100/s |

⚠️ Self-service quota increase is not available; you must go through the tenant's CSM. And
**message / chat / bitable APIs cannot be temporarily raised at all.** That is a hard ceiling for
a large customer's burst.

### 3.3 Card JSON 2.0

Source: <https://open.feishu.cn/document/feishu-cards/card-json-v2-structure>
⚠️ This page exists on the **Feishu** domain; the equivalent `open.larksuite.com` path
`/document/feishu-cards/card-json-v2-structure.md` **404s**. Use the Feishu URL.

- `"schema": "2.0"` — must be declared explicitly; default is 1.0.
- **Client requirement:** "卡片 JSON 2.0 结构支持飞书客户端 **7.20 及之后**版本。当使用 JSON 2.0
  结构的卡片发送至低于 7.20 版本的客户端时，卡片标题可正常显示，但内容将展示兜底的升级提示文案."
  → **Older clients show an upgrade prompt instead of your content.** You need a client-version
  fallback or use schema 1.0.
- **Element cap:** "一张卡片最多支持 **200 个元素**" (200 elements/components per card).
- `header.template` colours — full enum: `"blue" | "wathet" | "turquoise" | "green" | "yellow" | "orange" | "red" | "carmine" | "violet" | "purple" | "indigo" | "grey" | "default"`.
  ⚠️ `"wathet"` is a typo in Lark's own docs. It is the literal accepted value.
- `config.update_multi` — in JSON 2.0 this **only supports `true`**. "JSON 2.0 暂时仅支持设为 true，
  即更新卡片的内容对所有收到这张卡片的人员可见." So every 2.0 card is a shared card by default,
  which is exactly what you want for CI status updates (matches §3.2 PATCH requirement).
- `config.width_mode` — `"compact"` (400 px) / `"fill"` / default (600 px).
- `config.enable_forward` — default `true`.
- `config.summary.content` — chat-list preview text. Essential, otherwise the preview is empty.
- `element_id` — required for streaming updates; globally unique within the card; letters/digits/
  underscore only; must start with a letter; **max 20 chars**.
- `body.direction` / `padding` / `horizontal_spacing` / `vertical_spacing` / `horizontal_align` /
  `vertical_align` — layout controls new in 2.0.
- `card_link` — `url` plus optional `pc_url` / `ios_url` / `android_url`; block a platform with
  `lark://msgcard/unsupported_action`.
- Empty `{}` card is accepted.

`src/connectors/destinations/lark/webhook.ts:11-14` produces a valid 2.0 skeleton (`schema`,
`config.enable_forward`, `header.title.tag: plain_text`, `header.template`, `body.elements[]`).
One gap vs. best practice: it sets **no `config.summary`**, so the chat preview will be blank.

### 3.4 Custom bot vs app bot — and provisioning

Capability comparison, official (<https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/bot-v3/bot-overview>):

| Capability | Custom bot | App bot |
|---|---|---|
| Add to **external** groups | ✅ | ❌ |
| Push to its group | ✅ | ✅ |
| Card with link jump | ✅ | ✅ |
| Card that posts clicks back to your server | ❌ | ✅ |
| Respond when @mentioned | ❌ | ✅ |
| DM a user | ❌ | ✅ |
| Create/manage groups, read org directory | ❌ | ✅ |

**Recommendation:** ship **both** modes, exactly as `docs/LARK_REFERENCE_ARCHITECTURE.md` already
specifies (item 5, "Capability modes"). Webhook mode = zero-friction paste-a-URL; app mode =
`uuid` idempotency, message-ID persistence, card PATCH for CI edits, threads.

**Provisioning:**
- **Custom bot webhooks CANNOT be created programmatically.** Creation is a manual UI flow:
  group → 设置 → 群机器人 → 添加机器人 → 自定义机器人 → 添加. The docs' own step list proves it.
  There is **no OpenAPI to create a group bot.** So the customer must copy a URL to you.
  → This is the one place in your spec where "paste a URL" is unavoidable. Make it a guided,
  screenshot-annotated step, and have the customer verify with a test message from *their* side
  before saving.
- Custom bots need **no tenant admin approval** ("无需经过租户管理员审核") — genuinely low friction.
- **App bots** need creation in the developer console, a version publish, and **tenant admin
  approval** of scopes. High friction, but they are the only path to `uuid` idempotency.

### 3.5 ⚠️ Unresolved: the full Lark error-code table

I confirmed `0`, `9499` (Bad Request), `19021`, `19022`, `19024`, `11232` (from the custom-bot
guide) and `2300xx` / `99991400` (from the `im/v1` method pages). I could **not** load a canonical
complete error-code table — `https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/error-code/error-code.md`
returns 404. Do not assert a full mapping from this document.

---

## 4. Discord

- **Endpoint:** `POST https://discord.com/api/v10/webhooks/{webhook.id}/{webhook.token}`
  (<https://discord.com/developers/docs/resources/webhook>)
- **Auth:** the token in the path. "Webhooks are a low-effort way to post messages to channels in
  Discord. They do not require a bot user or authentication to use."
- **Query params:** `wait` (bool, default `false`) — "waits for server confirmation of message send
  before response, and returns the created message body (**defaults to false; when false a message
  that is not saved does not return an error**)". **Always send `wait=true`** — otherwise Discord
  gives you a 204 and you cannot know the message ID, so you can never update/delete the message
  and cannot detect silent drops. `thread_id` — "Send a message to the specified thread within a
  webhook's channel. The thread will automatically be unarchived." `with_components` (default false).
- **Body:** at least one of `content` / `embeds` / `components` / `file` / `poll`.
  `username`, `avatar_url`, `tts`, `allowed_mentions` also supported.
  ⚠️ **Set `allowed_mentions` explicitly.** Discord: "consider sanitizing the data to prevent
  unexpected behavior and using `allowed_mentions` to prevent unexpected mentions." A GitHub
  branch name like `@here` or a PR body containing `<@&123>` will otherwise ping real humans.
- **Idempotency:** **none documented.**
- **Message content limit: 2000 characters.**
- **Embed limits** (<https://discord.com/developers/docs/resources/message>):

| Field | Limit |
|---|---|
| `title` | 256 |
| `description` | 4096 |
| `fields` | 25 |
| `field.name` | 256 |
| `field.value` | 1024 |
| `footer.text` | 2048 |
| `author.name` | 256 |
| **Combined total across all embeds** | **6000** |

  "Violating any of these constraints will result in a Bad Request response." Also: "Embeds are
  deduplicated by URL. If a message contains multiple embeds with the same URL, only the first is
  shown." → two GitHub events from the same repo would collapse. Do not rely on multiple embeds.
- Max **10 embeds** per message (from the Execute Webhook param table).

**Rate limits** (<https://discord.com/developers/docs/topics/rate-limits>) — Discord's guidance is
explicit: "Because rate limits depend on a variety of factors and are subject to change, rate
limits **should not be hard coded** into your app. Instead, your app should parse response headers."
- **Global: 50 requests/second** per bot/user (per IP if unauthenticated). "Interaction endpoints
  are not bound to the bot's Global Rate Limit."
- Per-route limits, scoped by top-level resource — currently limited to `channel_id`, `guild_id`,
  `webhook_id` / `webhook_id + webhook_token`.
- Headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`,
  `X-RateLimit-Reset-After`, `X-RateLimit-Bucket`, and on 429: `X-RateLimit-Global`,
  `X-RateLimit-Scope` (`user` | `global` | `shared`).
- **429 body:** `{"message": "...", "retry_after": <float seconds>, "global": <bool>, "code"?: int}`.
  Use `retry_after` from the body, or `Retry-After` header.
- **Invalid Request Limit (Cloudflare ban): "10,000 per 10 minutes"** — any request returning
  401, 403 or 429 counts. "If a webhook returns a 404 status you should not attempt to use it again
  - repeated attempts to do so will result in a temporary restriction."
  → **This is the failure mode that will actually bite you**: retrying a deleted webhook gets your
  egress IP Cloudflare-banned for the whole Discord API for 10 minutes, taking out every other
  Discord delivery. Treat 404 as terminal, immediately.

> ⚠️ **UNVERIFIED — per-route numeric limit for `Execute Webhook`.** Discord documents per-route
> limits in a separate "Rate Limits" tab rendered client-side, which I could not extract. I have
> **no verified number** for webhook executions. Parse the headers; do not hard-code.

**Provisioning:** the customer can create a webhook manually (Server Settings → Integrations →
Webhooks), or your app can create one via `POST /channels/{channel_id}/webhooks` with the
`MANAGE_WEBHOOKS` permission under a bot OAuth install. Name validation: may not contain "clyde"
or "discord" (case-insensitive), 1–80 chars.

---

## 5. Telegram

- **Endpoint:** `POST https://api.telegram.org/bot<token>/sendMessage`
- **Auth:** the bot token in the URL. No scopes, no OAuth.
- **Params** (<https://core.telegram.org/bots/api>): `chat_id` (Integer or String — int ID or
  `@channelusername`), `text` **1–4096 characters after entities parsing**, `parse_mode`,
  `entities`, `message_thread_id` (forum topics), `link_preview_options`,
  `disable_notification`, `reply_parameters`, `business_connection_id`.
- **Message length limit: 4096 characters** (post-entity-parsing). Exceeding → API error.
- **`parse_mode` options:** `Markdown`, `MarkdownV2`, `HTML`, and `MarkdownV2-extra` / `HTML` via
  `entities`. (`MarkdownV2` requires escaping 18 reserved characters — a very common failure source.)
  Entities can be nested under documented rules; `pre`/`code` may not contain other entities.
- **Rate limits** (<https://core.telegram.org/bots/faq>, "My bot is hitting limits, how do I avoid this?"):
  - "In a single chat, avoid sending more than **one message per second**… eventually you'll begin receiving **429** errors."
  - "In a group, bots are not be able to send more than **20 messages per minute**."
  - "For bulk notifications, bots are not be able to broadcast more than about **30 messages per second**, unless they enable paid broadcasts."
  - Paid broadcasts: up to **1000 messages/second**, 0.1 Stars per message over the free 30/s;
    requires **≥100,000 Stars balance and ≥100,000 MAU**, enabled via `@BotFather`.
  - "The API will not allow bulk notifications to more than ~30 users per second."
- **Errors:** the Bot API returns HTTP 4xx with `{"ok": false, "error_code": N, "description": "…"}`;
  on 429 the `parameters` object carries `retry_after` (seconds). ✅ transient; retry after that delay.
  → **the 20 msg/min group cap is the binding constraint**, not the 1 msg/s chat cap.
- **Idempotency:** none documented.
- **File limits (context):** `getFile` works up to **20 MB**; bots can send files up to **50 MB**.
- **No delivery read-back beyond `message_id`** — but `sendMessage` *does* return `message_id`,
  so you **can** dedupe client-side and, with a bot in the group, `editMessageText` for CI status cards.

### ⚠️ The architectural blocker for a multi-tenant SaaS

Telegram has **no OAuth and no multi-tenant app concept**. A bot token is issued by `@BotFather`
to one person/organization, and **a single bot lives in exactly one Telegram "workspace" owned by
one account.** There is no documented mechanism for a third-party SaaS to have a customer grant it
scoped access to their own bot or chats.

Practical consequences you must resolve before shipping Telegram at all:
1. Either the SaaS owns **one** bot and every customer's notifications appear under the SaaS's bot
   identity (single trust/brand, single rate-limit pool of 30 msg/s globally, abuse risk, and
   customers cannot block the bot without affecting others).
2. Or the SaaS operates a **Bot API Enterprise** account and must contract that with Telegram
   directly.
3. Or the customer creates their own bot via `@BotFather` and hands you the token — but
   `@BotFather` is explicitly not delegable, and you'd be storing a customer's high-value credential.

**Setup friction for a non-technical user is the worst of all six destinations** — Telegram's own
FAQ says: "Unfortunately, there are no out-of-the-box ways to create a working bot if you are not a
developer."

**Recommendation: deprioritise Telegram.** It does not fit a clean multi-tenant SaaS model without
a separate commercial agreement.

---

## 6. Email from a Cloudflare Worker

### 6.1 Cloudflare Email Service (the native option)

⚠️ **Naming changed recently.** The product is now "**Cloudflare Email Service**" (umbrella),
containing **Email Sending** (outbound, **Beta**, Workers **Paid** plan) and **Email Routing**
(inbound, Free and Paid). Do not write "Cloudflare Email Routing" for the outbound feature —
Email Routing is inbound-only and is a common source of spec confusion.
(<https://developers.cloudflare.com/email-routing/email-sending/>)

**Three outbound interfaces:**
1. Workers binding `send_email` → `env.EMAIL.send({to, from, subject, html, text})`
2. REST `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/email/sending/send`
3. Authenticated SMTP `smtps://smtp.mx.cloudflare.net:465`

**⚠️ THE VERIFIED-DESTINATION CONSTRAINT — this is the whole story for a SaaS:**

> "**Before you onboard a sending domain, you can send emails only to verified destination
> addresses in your account. After you onboard a sending domain, you can send to any recipient
> immediately.** Sends to verified destination addresses are always free: they do not count toward
> your monthly quota or your daily sending limits, on any plan… **You can only send from your
> routing domains.**"
> — <https://developers.cloudflare.com/email-routing/limits/>

Limits (<https://developers.cloudflare.com/email-routing/limits/>, page last updated 2026-09-25):

| Limit | Value |
|---|---|
| **Verified destination addresses per account** | **200** (shared across all domains in the account) |
| Recipients (to+cc+bcc) per email | 50 |
| Subject line | 998 characters (RFC 5322) |
| Total message size | **5 MiB** (incl. attachments) |
| Total message size → verified destinations | **25 MiB** |
| Header size (all custom headers) | 16 KB |
| Domains per zone (Routing + Sending) | 30 |
| Routing rules per domain | 200 |
| Inbound message size | 25 MiB |
| `message.reply()` References entries | 100 (throws beyond — loop protection) |
| Suppression list | 1 per address+scope; 1000/page; 1000 items per bulk import; 10 bulk imports/min (429 on exceed); note length 1000 |

**Daily sending limit: ⚠️ NO NUMBER PUBLISHED.** "New accounts start with a conservative daily quota
and scale up over time based on your sending behavior, deliverability rates, and account standing.
Limits are applied per account and may be adjusted automatically." Increase is by request form
only. **Do not invent a number.** Query the account's live limits via the API at implementation time.

**⚠️ Observability gotcha:** "Emails sent from a Worker using the `send_email` binding appear in
the Email Routing summary as **dropped**, even when they were delivered successfully. To track
outbound send success, use Email sending metrics and logs instead."

### 6.2 The SaaS problem with Cloudflare Email Sending

Because "you can only send from your routing domains" and recipients are capped at 200 verified
addresses until a domain is onboarded, the only workable SaaS pattern is:

**Each customer onboards their own sending domain into your Cloudflare account** (SPF/DKIM/DMARC
via your API), and you send as `notifications@customer.com`. That gives unlimited recipients.
This is a real onboarding flow with real failure modes (DNS propagation, admin approval on some
CF features) and it takes the domain out of your brand's control.

Alternative: you onboard **your own** domain and send everything as `notifications@yourproduct.com`.
Simpler technically, but every customer's notifications come from your domain — bad for their
DMARC reputation and bad for deliverability if one customer's mail gets you blocklisted.

### 6.3 Third-party providers from Workers

All are plain HTTPS APIs and work from a Worker via `fetch` — none need a Node runtime.
I verified Resend and reached Postmark's docs; treat the rest as unverified specifics.

| Provider | Endpoint | Auth | Verified this session |
|---|---|---|---|
| **Resend** | `POST https://api.resend.com/emails` | `Authorization: Bearer re_…` | ✅ endpoint, body (`from`,`to[]`,`subject`,`html`,`text`), response `{"id":"…"}` (<https://resend.com/docs/api-reference/emails/send-email>) |
| **Postmark** | `POST https://api.postmarkapp.com/email` | `X-Postmark-Server-Token` | ⚠️ docs index reached, exact endpoint/auth not confirmed (<https://postmarkapp.com/developer/api/email-api>) |
| **SendGrid** | `POST https://api.sendgrid.com/v3/mail/send` | `Authorization: Bearer SG.…` | ⚠️ not verified this session |
| **Amazon SES** | `email-smtp.<region>.amazonaws.com:587/465` or `ses.<region>.amazonaws.com` v2 API | SMTP creds, or **SigV4** | ⚠️ not verified this session. SigV4 is implementable in Workers with WebCrypto but is real work; prefer an HTTP API provider. |

> ⚠️ **Idempotency for email generally:** none of these offer documented send deduplication.
> Deliver **at-least-once** with your own outbox + delivery-ledger dedupe, and include a stable
> `Message-ID` / custom header so downstream systems can correlate.

### 6.4 Recommended approach

- **Inbound (GitHub → you, or replies → you): Cloudflare Email Routing** with the `email()`
  handler — it's the only one of these that works on the **Workers Free plan**, and inbound is
  25 MiB.
- **Outbound:** a dedicated transactional provider (Resend is the smallest API surface and has an
  obvious Workers-friendly shape) rather than Cloudflare Email Sending, because the verified-destination
  and your-routing-domains-only constraints create a per-customer domain-onboarding dependency
  that is disproportionate to "we also send email".
  If you do use Cloudflare Email Sending, the receiving-mode "dropped" reporting bug means you
  cannot build accurate delivery analytics from Email Routing data.

---

## 7. Capability-aware rendering — what the spec must encode

Destinations have genuinely different capabilities. A renderer abstraction that pretends otherwise
will produce silent failures:

| Capability | Slack hook | Slack API | Teams Workflow | Teams Bot | Lark hook | Lark app | Discord | Telegram |
|---|---|---|---|---|---|---|---|---|
| Update existing message | ❌ | ✅ | ❌ | ✅ | ❌ | ✅ (card PATCH) | ✅ | ✅ (bot in chat) |
| Delete message | ❌ | ✅ | ❌ | ✅ | ❌ | ✅ | ✅ | ✅ |
| Server-side dedup | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ `uuid` | ❌ | ❌ |
| Thread reply | needs external `ts` | ✅ `thread_ts` | ❌ | ✅ | ❌ | ✅ | ✅ `thread_id` | ✅ `message_thread_id` |
| Interactive buttons | ✅ (app hook) | ✅ | ❌ (Actions not supported) | ✅ | URL-only, no callback | ✅ | ✅ | ✅ |
| Custom bot identity/icon | ❌ (app hook) | ✅ | ❌ (Flow bot fixed) | ✅ | ✅ (name set in UI) | ✅ | ✅ | — |
| Body size cap | ~40 KB text | ~40 KB text | **28 KB** | 80 KB (100 KB hard) | **20 KB** | 30 KB card / 150 KB text | 2000 + 6000 embed | 4096 |

**Design consequence:** your `DestinationCapabilities` interface should have at least
`canUpdate`, `canDelete`, `canReply`, `supportsInteractive`, `canCustomizeIdentity`, `maxBodyBytes`,
`supportsServerSideIdempotency`. Anything else is a lie the customer finds out about in production.

---

## 8. Open questions this research did NOT close

1. **Slack:** is there any sanctioned idempotency for `chat.postMessage`? Current answer is
   **no**. Re-check if Slack documents `client_msg_id` again.
2. **Slack:** any dated sunset for legacy incoming webhooks? Current answer is **none published**.
3. **Teams:** Power Automate / Logic Apps request throttling numbers (daily requests, concurrency)
   — **not retrieved**. Blocking for capacity planning.
4. **Teams:** do Workflows webhooks actually deliver to private channels today? Official docs
   conflict (§2.2). Needs a real tenant test.
5. **Teams:** maximum supported Adaptive Card `version` for Teams. Not published; pin low and test.
6. **Teams:** Bot Framework / Entra / Azure Bot Service licensing cost. Not verified.
7. **Teams:** exact trigger-auth token format for "Any user in my tenant" / "Specific users in my
   tenant". Referenced by MS but I did not load that page.
8. **Lark:** complete canonical error-code table (`19001` specifically was asked about — **I did
   not verify what 19001 means**). The reference doc 404s; find the live path.
9. **Discord:** numeric per-route rate limit for `Execute Webhook`.
10. **Email:** Cloudflare Email Sending daily quota number (not published — query at runtime).
11. **Postmark / SendGrid / SES:** exact endpoints, auth, and Workers compatibility unverified.
12. **Telegram:** whether a Bot API Enterprise agreement is realistically obtainable for a small
    SaaS. Commercial question, not a docs question — but it gates the whole destination.