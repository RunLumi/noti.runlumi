# 05 — GitHub Source

> GitHub is the wedge. Verified against official docs **2026-10-13** (GitHub API version
> header observed: `X-GitHub-Api-Version: 2026-03-10`).

## The finding that changes the architecture

> **GitHub does not automatically redeliver failed deliveries.** There is no retry schedule.
> The only recovery is manual redelivery, and only within a 3-day window.
> — [Redelivering webhooks](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks)

Everything in `12-delivery-reliability.md` — outbox, retries, DLQ, dedup — governs **our
delivery to the destination**. It guarantees nothing about GitHub's delivery to us. If we drop
an inbound event, nothing retries it.

Consequences, all mandatory:

1. Ingress must be **durably accepted before ack**, with no best-effort paths (F64).
2. Ingress failures must be **detected independently** by polling
   `GET /app/hook/deliveries?status=failure` (F65).
3. There must be a **reconciliation path from the API** to fill gaps (F69).

Also unverified and therefore *not* to be claimed anywhere: GitHub **auto-disabling** webhooks
after N failures. The agent checked About webhooks, Types of webhooks, Best practices,
Handling deliveries, Redelivering, Viewing deliveries, Disabling webhooks and App
registration — **no documented auto-disable exists**. The only documented deactivation is
manual. Do not write it; do not rely on it either.

---

## F55 — GitHub App registration

**Priority** P0 · **Status** 🟡 registration documented in `docs/GITHUB_APP.md`, ADR 0008 (OAuth verify leg), and `app-config.ts` fails closed on placeholders; not built: no App registered, permissions unverified against a real App

**Story** As a user, I want to connect Noti to GitHub with one click, so that I am not
pasting webhook URLs and secrets into a form.

**Acceptance**
- [ ] A **public** GitHub App. *"Only on this account"* Apps are not installable by others.
- [ ] Requested permissions are exactly the V1 minimum (F61). No write scopes. No
      `administration`, no `contents: write`, no `workflows`.
- [ ] `request_oauth` is **disabled**. It forces a callback-URL flow instead of a setup URL,
      and requests account permissions a notifier never needs. If we ever need it, the
      callback URL must be registered in advance.
- [ ] `setup_url` set with **Redirect on update** enabled, so repository changes re-sync us.
- [ ] One webhook, subscribed to the V1 event set.
- [ ] The private key is a Worker secret; the app ID and client ID are non-secret vars.
- [ ] A staging App and a production App are **separate registrations** with separate keys.

**Design** — Repository webhooks are structurally wrong for a multi-tenant SaaS: they cannot
be created by us (`POST /repos/{owner}/{repo}/hooks` needs repo admin, which we do not have),
each needs its own secret, there is a 20-hooks-per-event-type-per-repo ceiling, and **the
request contains no tenant identifier at all**. The App is not a preference; it is the only
model that produces an installation id.

**Errors** — a missing/invalid private key is a boot failure (F04), not a 500 per request.

**Security** — the private key never leaves the Worker. It is never logged, never sent to a
dashboard client, never included in an error.

**Tests** — `app_config_matches_the_declared_minimum_permissions`; `no_write_scopes_requested`.

**Deps** — F04.

---

## F56 — Install flow and tenant binding

**Priority** P0 · **Status** ✅ verified binding via user token + PKCE, single-use states (PR #11, ADR 0008, `tests/github/install-flow.test.ts`); real-App run not done

**Story** As a user, I want to install Noti and land back in my own workspace, so that I do
not have to re-find my account afterwards.

**Acceptance**
- [ ] We generate a signed, single-use `state` and redirect to
      `https://github.com/apps/<app>/installations/new?state=<state>`, bound to
      `{orgid, userId, expiry}`.
- [ ] On callback, `state` resolves the tenant from **our** record.
- [ ] ⚠️ **`installation_id` from the `setup_url` query parameter is never trusted.**
      GitHub: *"Bad actors can hit this URL with a spoofed `installation_id`. Therefore, you
      should not rely on the validity of the `installation_id` parameter."*
- [ ] Tenant binding is confirmed by the **`installation.created` webhook**, whose body
      carries the authoritative `installation.id` — signed with our App secret, therefore
      trustworthy.
- [ ] The installation is linked to `orgid` **only** after the signed event confirms it.
- [ ] A `Redirect on update` callback re-syncs the repository set without re-binding tenant.

**Design** — Two-phase: optimistic `pending` row from `state`, authoritative binding from
`installation.created`. This is the same shape as any OAuth `state` binding, and it is the
only version GitHub's docs actually support.

**Errors**
| Condition | Response |
| --- | --- |
| Missing/expired/replayed `state` | 400, no information leaked |
| `installation.created` for an unknown `state` | accept + store as `unclaimed`, surface for manual claim |
| Installation already bound to a different `orgid` | **refuse**, audit event, never silently rebind |

**Security** — rebinding an installation to another tenant would be a full account takeover.
It requires an explicit, audited, owner-only action.

**Tests**
- `state_is_single_use_and_expiring`
- `spoofed_installation_id_query_param_is_ignored`
- `tenant_binding_requires_the_signed_installation_created_event`
- `installation_cannot_be_rebound_without_an_audited_action`

**Deps** — F55, F57.

---

## F57 — Installation registry and lifecycle

**Priority** P0 · **Status** ✅ registry, lifecycle status, no-rebind trigger (PR #11, `migrations/0010_github_install_flow.sql`, `tests/github/install-flow.test.ts`) · **This is the tenant key**

**Story** As an operator, I want every inbound event to resolve to exactly one workspace via
its verified installation, so that no event can be routed using attacker-supplied data.

**Acceptance**
- [ ] `github_installations(id, orgid, installation_id UNIQUE, app_id, account_login,
      account_type, target_type, target_id, repository_selection, access_token_ciphertext,
      token_expires_at, status, suspended_at, created_at, last_sync_at)`.
      `id` is our row id; `installation_id` is GitHub's. `app_id` is stored so a payload can
      never be matched against an installation belonging to a *different* App.
- [ ] ⚠️ **`X-GitHub-Hook-Installation-Target-ID` / `-Type` are NOT used for routing.** GitHub
      documents them only as *"the resource where the webhook was created"*, and the only
      worked example is a repository webhook. For an App webhook the resource is the App
      itself, so what they carry is undocumented. Route on `installation.id` from the **body**.
- [ ] Lookup is `WHERE installation_id = ? AND app_id = ?`, then verify `orgid` from our row.
- [ ] A missing installation is `403` + audit event. It is never treated as "route to all".
- [ ] `status` ∈ `active | pending | suspended | uninstalled`.
- [ ] The access token is encrypted (F36) and cached with `token_expires_at` (F66).

**Schema note** — this table **replaces** routing by `integrations.repo`. See D3: today
`src/index.ts:38` does `SELECT ... FROM integrations WHERE repo=?` where `repo` is
`event.repository.full_name`, straight from the request body. That is the vulnerability, and
this table is its replacement.

**Errors**
| Condition | Behaviour |
| --- | --- |
| Unknown `installation_id` | 403, `unauthorized_tenant`, audit |
| `app_id` mismatch | 403, audit |
| Installation suspended | 403, user notified via dashboard |
| Installation uninstalled | 403 |

**Security** — this is the entire multi-tenant authorization boundary for GitHub. Every one
of the tenant-isolation tests required by `AGENTS.md` must exercise this lookup.

**Tests**
- `unknown_installation_is_rejected_with_audit`
- `installation_from_a_different_app_id_is_rejected`
- `repository_name_alone_never_authorizes_routing`
- `suspended_installation_receives_nothing`

**Deps** — F24, F25, F36.

---

## F58 — Signature verification

**Priority** P0 · **Status** ✅ raw-bytes HMAC via `crypto.subtle.verify`, shape guard, UTF-8, no SHA-1 path (`src/connectors/sources/github/events.ts`, `tests/github.test.ts` incl. known-answer vector); gaps: bad or missing signature returns 401 not 403, no explicit SHA-1 or whitespace test

**Story** As a security reviewer, I want GitHub deliveries verified against the raw bytes
before anything else touches them, so that a forged event can never reach a tenant.

**Acceptance**
- [ ] Verify `X-Hub-Signature-256` against the **raw request body**, before `JSON.parse`.
- [ ] `crypto.subtle.verify` where possible; constant-time compare otherwise. GitHub:
      *"Never use a plain `==` operator."* — [Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [ ] Shape-guard `^sha256=[a-f0-9]{64}$` **before** comparing. This is what makes the
      fixed-length compare sound — `src/connectors/sources/github/events.ts` does this
      correctly today. Preserve it.
- [ ] A missing header is a hard **403**, not "skip verification". The header is absent when
      no secret is configured.
- [ ] ⚠️ **`X-Hub-Signature` (SHA-1) is rejected outright.** GitHub: *"legacy purposes"*. No
      SHA-1 code path exists in the codebase.
- [ ] Handle the body as **UTF-8** — *"Webhook payloads can contain unicode characters."*
- [ ] **Known-answer test, verbatim from GitHub's docs:**
      ```
      secret:   It's a Secret to Everybody
      payload:  Hello, World!
      expected: sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17
      ```
- [ ] Body reordering, whitespace changes and re-serialization all fail verification.
- [ ] IP allowlisting via `GET /meta` is **defence in depth only**, never the primary check.
      GitHub rotates these ranges, so a hard IP allowlist will break the product on a
      schedule that is not ours to control.

**Design** — Today's implementation is genuinely good here and should be preserved. The two
hardening items are the known-answer test and an explicit `crypto.subtle.verify` path.

**Errors** — `401` with **no body detail**. No oracle about which check failed.

**Security** — the App secret is a single shared secret across all installations. That is
GitHub's model; per-installation isolation comes from F57, not from the secret.

**Tests**
- `github_known_answer_vector_passes`
- `legacy_sha1_header_is_rejected`
- `missing_signature_header_is_403`
- `modified_body_whitespace_fails_verification`
- `constant_time_comparison_is_used_never_equals`

**Deps** — F04.

---

## F59 — GitHub header contract

**Priority** P0 · **Status** ✅ header contract pinned (`tests/github/ingress-contract.test.ts`): missing event or delivery is 400, opaque delivery id, action from the body, case-insensitive, SHA-1 refused, target headers unused; a body that is not `application/json` (GitHub's form-encoded option) is 415 before anything is read (ADR 0028, `tests/github/ingress-codes.test.ts`)

**Story** As an operator, I want to see exactly which GitHub headers we rely on documented,
so that a GitHub change breaks a test rather than production.

**Acceptance**

| Header | Meaning | Used for |
| --- | --- | --- |
| `X-GitHub-Delivery` | "A globally unique identifier (GUID)" | `providerid` + dedup |
| `X-GitHub-Event` | event name, snake_case | event classification |
| `X-GitHub-Hook-ID` | "The unique identifier of the webhook" | observability only |
| `X-GitHub-Hook-Installation-Target-ID` | "resource where the webhook was created" | ⚠️ **not used** (F57) |
| `X-GitHub-Hook-Installation-Target-Type` | same | ⚠️ **not used** (F57) |
| `X-Hub-Signature-256` | HMAC-SHA256 hex | verification |
| `X-Hub-Signature` | HMAC-SHA1 hex | ⚠️ rejected |
| `User-Agent` | `GitHub-Hookshot/<sha>` | observability |

- [ ] `X-GitHub-Delivery` is treated as an **opaque string**. The published example
      `72d3162e-cc78-11e3-81ab-4c9367dc0958` is UUID-formatted but the docs specify only
      "GUID" — do **not** parse a version nibble.
- [ ] The **action** comes from the top-level `action` key in the **body**, not the header.
- [ ] Header lookup is case-insensitive (`Headers.get`), never raw indexing. Slack documents
      the case-insensitivity requirement; GitHub headers are HTTP-standard on this point.
- [ ] Every header we depend on is asserted in a contract test, so an upstream rename fails CI.

**Errors** — a missing `X-GitHub-Event` or `X-GitHub-Delivery` is `400` (`schema_invalid`).

**Security** — headers are untrusted input until the signature has been verified.

**Tests** — `delivery_id_is_opaque_not_parsed`; `action_comes_from_the_body`;
`header_lookup_is_case_insensitive`; `required_headers_are_asserted`.

**Deps** — F58.

---

## F60 — Actor trust and the ghost user

**Priority** P0 · **Status** ✅ login and `sender.type` only; ghost flagged and not shown as a person; `[bot]` suffix or `Bot` type sets `isBot`; display names never read (`tests/events/canonical.test.ts`, `tests/github/ingress-contract.test.ts`)

**Story** As a user, I want notifications to attribute activity correctly, so that a bot or a
system account is never presented as a colleague who broke the build.

**Acceptance**
- [ ] GitHub documents a `ghost` placeholder: *"Sometimes GitHub can't resolve a specific
      user… `sender` is populated with the `ghost` user… **Don't assume `sender` always
      identifies the person who caused an event, and account for the `ghost` user in any
      security or business logic that relies on it.**"*
- [ ] `login === "ghost"` maps to `data.actor.isGhost = true` (F43).
- [ ] Renderers display `ghost` as "GitHub" or omit attribution — never as a person.
- [ ] `sender.login` is **never** used for authorization, for tenant resolution, or for
      "is this my bot" identity beyond a non-authoritative display hint.
- [ ] Bot accounts (`[bot]` suffix / `type: "Bot"`) set `isBot`.

**Design** — This is small but it is exactly the kind of detail that makes a product feel
honest. A notification saying "ghost merged this PR" is a visible tell that nobody read the
payload schema.

**Errors** — a `null` sender yields `isBot: null, isGhost: false` — unknown, not "not a bot".

**Security** — `sender` is attacker-influenceable in the sense that any user can set their
display name. It is display data only.

**Tests** — `ghost_sender_is_flagged_and_never_rendered_as_a_person`;
`sender_is_never_used_for_authorization`.

**Deps** — F43, F62.

---

## F61 — Event catalog and permission gating

**Priority** P0 · **Status** 🟡 closed catalog of 18 types enforced at write and ingress (PR #9, `catalog.ts`); not built: check_run, check_suite, review_thread, repository events, permission gating needs a real App (3b)

**Acceptance**
- [ ] V1 subscribes to: `issues`, `issue_comment`, `pull_request`, `pull_request_review`,
      `pull_request_review_comment`, `pull_request_review_thread`, `workflow_run`, `push`,
      `check_run`, `check_suite`, `release`, `deployment_status`, `repository`, `ping`.
- [ ] Minimum read permissions, per GitHub's documented minimums:

| Event | Minimum permission |
| --- | --- |
| `issues`, `issue_comment` | read **Issues** |
| `pull_request*` | read **Pull requests** |
| `workflow_run` | read **Actions** |
| `push` | read **Contents** |
| `check_run`, `check_suite` | read **Checks** |
| `release` | read **Contents** |
| `deployment_status` | read **Deployments** |
| `repository`, `star` | read **Metadata** |

- [ ] ⚠️ GitHub gates subscription on granted permissions: *"You can only subscribe to events
      your permissions allow."* The install screen must therefore **justify each permission in
      plain language**, or the customer will deny them and the connector will silently
      receive nothing.
- [ ] ⚠️ Honest disclosure in the UI: *"The app will always have at least read-only access to
      all public repositories on GitHub."* This is a fixed, unavoidable install-screen line.
      Do not claim zero permissions.
- [ ] Permission keys are **read at runtime** from `GET /app` and the installation's
      `permissions` object rather than hardcoded as `issues: read`. The snake_case keys are
      conventional but the docs expose display names; `X-Accepted-GitHub-Permissions` is the
      authoritative echo.
- [ ] If a customer denies a permission, the affected event types are **disabled in the UI
      with an explanation**, not left selectable and silently empty.

**Design** — The install screen is the highest-friction moment in the whole product for a
non-technical user. It is also the only place we ask for trust. Every permission gets one
plain sentence.

**Errors** — an event arriving for a permission the customer did not grant is logged as
`permission_missing` and surfaced, not silently accepted.

**Security** — no write scopes, ever. A notification router that can write to a repository
is a supply-chain risk.

**Tests**
- `every_subscribed_event_has_a_documented_minimum_permission`
- `ui_explains_each_permission_in_plain_language`
- `denied_permission_disables_event_types_with_an_explanation`
- `no_write_scopes_are_requested`

**Deps** — F55, F42.

---

## F62 — Event normalization

**Priority** P0 · **Status** 🟡 every catalogued event maps to the canonical event, with documented examples as fixtures (`src/connectors/sources/github/map.ts`, `tests/fixtures/replay.test.ts`); not built: `rawOutcome`, state transitions (F44), `unmapped:<raw>`

**Acceptance**
- [ ] Every subscribed event maps to the canonical envelope (F41) with
      `data.actor`, `data.outcome`, `data.url`, `data.title`, `data.branch`, `data.labels`.
- [ ] `pull_request.closed` with `merged: true` becomes a **resolution** of the earlier
      `pull_request.opened`/`synchronize` state (F44), not an isolated fact.
      Today's `classifyGithubEvent` already distinguishes merged from closed — preserve that
      behaviour, then extend it into a state transition.
- [ ] `workflow_run.conclusion` maps to `data.outcome` with the documented mapping (F44),
      preserving the raw string in `data.rawOutcome`.
- [ ] Actions map into the closed catalog (F42). Unknown actions become `unmapped:<raw>` and
      are **surfaced**, not dropped.
- [ ] Adapters are versioned: `adapterVersion` is recorded on each event so a normalization
      change is replayable and debuggable.
- [ ] Renderers are pure functions of the envelope (F48).

**Design** — `classifyGithubEvent` today returns `kind + '.' + action` with unbounded
cardinality (D16). That is fine as a *diagnostic* string and wrong as a routing key.

**Errors** — normalization failure is `schema_invalid`; the raw body is still stored (F51) so
it can be diagnosed, and the event appears in the unmapped view.

**Security** — every string from the payload is length-capped and escaped at render time.

**Tests**
- `each_catalog_event_normalizes_deterministically`
- `merged_and_closed_prs_produce_different_transitions`
- `normalization_is_deterministic_across_runs`
- `adapter_version_is_recorded_on_each_event`

**Deps** — F41, F42, F44.

---

## F63 — Payload caps and truncation semantics

**Priority** P0 · **Status** 🟡 1 MiB cap documented, tested at the boundary, refusal logged with its reason (`tests/github/ingress-contract.test.ts`); 25 MB and the silent GitHub drops documented; `truncated` n/a (no commit arrays carried) · **Fixes** part of D15

**Acceptance**
- [ ] Documented upstream limits, all of which are **silent drops or partial data**, not
      errors:

| Limit | Behaviour |
| --- | --- |
| Payload > **25 MB** | *"GitHub will not deliver a payload for that webhook event"* — we receive nothing |
| > **5000** branches pushed at once | `push` **not created** |
| > **3** tags pushed at once | `push` **not created** |
| `push.commits` | capped at **2048** |
| `status.branches` | capped at **10** |
| `check_run`/`check_suite` fork pushes | empty `pull_requests`, null `head_branch` |

- [ ] The 1 MiB hardcoded check in `src/index.ts:27,29` becomes a documented per-provider
      policy with a named constant, checked against `content-length` **and** the encoded body.
- [ ] A `push` with `commits: []` is normal, not an error — the "no commits" case is
      common for branch deletes.
- [ ] `truncated: true` is set whenever any array is capped, with the dropped counts.

**Design** — The 5000-branch and 3-tag cases are invisible: GitHub creates no event at all.
We cannot detect them from the webhook stream. F69 (API reconciliation) is the only way to
notice. This is a strong argument for keeping reconciliation in V1 rather than deferring it.

**Errors** — oversize is `413` → `payload_too_large` (F13), permanent, never retried.

**Security** — the raw body may contain private repository content. Retention F51.

**Tests**
- `push_with_capped_commits_sets_truncated`
- `push_with_zero_commits_is_not_an_error`
- `body_over_the_documented_cap_is_rejected`

**Deps** — F45.

---

## F64 — Ack discipline

**Priority** P0 · **Status** ✅ 202 only after the durable write, 5xx on D1 failure, no outbound call, dispatcher kick after commit (`tests/github/ingress-contract.test.ts`); not built: a p99 SLO

**Story** As a user, I want a 2xx back within 10 seconds even when a destination is down, so
that GitHub considers the event delivered and does not hold connections open.

**Acceptance**
- [ ] Hard budget: GitHub *"should respond with a 2XX response within 10 seconds"*; beyond
      that it *"terminates the connection and considers the delivery a failure."*
- [ ] The handler does: verify → resolve tenant → dedup claim → durable batch write → `202`.
      Nothing else. **No destination I/O, no outbound API call** (F49).
- [ ] `eventually`/`waitUntil` is used only for the outbox pump kick; the response does not
      wait on it.
- [ ] p99 for the handler is tracked as an SLO. Budget: < 500 ms internally, leaving ample
      headroom.
- [ ] Workers Free gives only **10 ms CPU** per request
      ([workers/platform/limits](https://developers.cloudflare.com/workers/platform/limits/)),
      so no synchronous work beyond one HMAC and one D1 batch.

**Design** — Signature verification is one HMAC; the D1 batch is one transaction. That fits
comfortably. The thing that would break this budget is enrichment (F49) and it is therefore
opt-in and asynchronous.

**Errors** — anything past the budget returns `202` anyway if the event is durably stored.
Returning 5xx to GitHub achieves nothing, since **GitHub will not retry it**.

**Security** — n/a.

**Tests**
- `handler_completes_well_within_the_10s_budget`
- `handler_makes_no_outbound_network_calls`
- `ack_is_sent_only_after_the_durable_write`

**Deps** — F09, F50.

---

## F65 — Delivery-failure detection

**Priority** P0 · **Status** ⛔ blocked on the GitHub App private key (polling `GET /app/hook/deliveries` needs the App JWT); what is detectable without it is documented and tested: a redelivery is absorbed, ids carry no sequence (`tests/github/ingress-contract.test.ts`) · **New, from research**

**Story** As an operator, I want to know when GitHub could not reach us, so that a silent gap
in a customer's notifications is caught rather than discovered weeks later.

**Acceptance**
- [ ] A scheduled job polls `GET /app/hook/deliveries?status=failure` per active installation,
      within the **3-day** redelivery window.
- [ ] Requires a **JWT**, not an installation token.
- [ ] Failed deliveries are matched against our `event_receipts` by `X-GitHub-Delivery`.
- [ ] Any delivery GitHub recorded but we never stored is an **ingress gap**: queued for
      replay via F69, and surfaced to the customer.
- [ ] `throttled_at` from the delivery schema is recorded when present.
- [ ] Retries: Repository hooks need a repo admin; Organization hooks need an org owner;
      **App hooks need the App owner or App managers** — i.e. **us**. This is precisely why
      an App is required: only the App owner can programmatically redeliver.

**Design** — Without this, an ingress bug is a permanent, silent, per-customer data loss. With
it, ingress correctness becomes a *measured* property. This is the operational mirror of
`docs/RELEASE_GATES.md`'s "no silent loss".

**Errors** — a poll failure is `poll_failed`, retried, never silently ignored. A gap older
than 3 days is unrecoverable and must be reported as such honestly, not hidden.

**Security** — the JWT is minted per call, 60s lifetime, RS256 (F66).

**Tests**
- `failed_deliveries_are_polled_within_the_3_day_window`
- `unrecorded_delivery_is_flagged_as_an_ingress_gap`
- `gap_older_than_the_window_is_reported_as_unrecoverable`

**Deps** — F66, F69, F192.

---

## F66 — Credential lifecycle and token caching

**Priority** P0 · **Status** ❌ no App private key, JWT minting or installation-token cache exists; install flow uses only a short-lived user token (ADR 0008); needs a registered App for real validation

**Story** As an operator, I want GitHub credentials cached correctly, so that a traffic spike
does not get our GitHub App banned.

**Acceptance**
- [ ] **App JWT**: RS256, `iat` set **60 seconds in the past** to tolerate clock drift, `exp`
      **no more than 10 minutes** in the future, `iss` = the App **client ID** (recommended
      over the app id). Sent as `Authorization: Bearer <JWT>` — must be `Bearer`, not `token`.
- [ ] **Installation access tokens** expire after **1 hour** and are cached in D1 with
      `token_expires_at`.
- [ ] ⚠️ **Never mint a token per webhook.** `POST /app/installations/{id}/access_tokens` is
      an **OAuth access token request**, and the secondary rate limit is **2,000/hr** — the
      docs warn that *"Continuing to make requests while you are rate limited may result in
      **banning of your integration**."*
- [ ] Refresh at ≥5 minutes before expiry → ≤12 refreshes/hr/install.
- [ ] ⚠️ **Installation rate limits are per-installation**, so they scale with tenants but
      there is no shared pool: one installation cannot serve another installation's events.
- [ ] Primary limit: 5,000/hr per installation, scaling +50/hr per repo beyond 20, hard cap
      **12,500/hr**. GraphQL is **5,000 points/hr** per installation, cap 12,500.
- [ ] Secondary limits respected: 100 concurrent, 900 points/min REST, 2,000 points/min
      GraphQL, 90 s CPU per 60 s, 80 content-generating requests/min. Back off on
      `403`/`429` **and remember GraphQL returns `200` with an error body on primary
      exhaustion.**
- [ ] Tokens are encrypted at rest with the envelope scheme (F36) and are never logged, never
      placed in an envelope, never exposed to the dashboard.

**Design** — 12 refreshes/hr/install against a 2,000/hr OAuth-request secondary limit is a
16× margin. Getting this wrong bans the App for every tenant simultaneously — it is the
highest-consequence rate-limit mistake available in this codebase.

**Errors** — a 401 from GitHub invalidates the cached token and forces one refresh; a second
consecutive failure raises `github_credentials_invalid` and notifies the customer to
reinstall.

**Security** — see above. This is the single most sensitive credential we hold after
destination URLs.

**Tests**
- `jwt_exp_is_at_most_10_minutes_and_iat_is_60s_in_the_past`
- `installation_token_is_cached_not_minted_per_request`
- `oauth_token_request_rate_stays_under_the_secondary_limit`
- `graphql_primary_exhaustion_on_200_is_detected`

**Deps** — F36, F49.

---

## F67 — Repository selection enforcement

**Priority** P0 · **Status** ✅ enforced at ingress and integration write (PR #11, `repositoryInScope` in `tenant.ts`, `tests/github/install-flow.test.ts`)

**Story** As a customer, I expect Noti to respect "Only select repositories", so that a
restricted installation cannot route events from repositories the customer excluded.

**Acceptance**
- [ ] `installation_repositories` (`added` / `removed`; default subscription, cannot
      unsubscribe) is the authoritative live feed for the selected set.
- [ ] When `repository_selection == "selected"`, `repository.id` is checked against the
      installation's allowed set before any routing decision.
- [ ] A `removed` action immediately disallows that repository; subsequent events for it are
      rejected and audited.
- [ ] The repository set is synced on `setup_url` redirect-on-update **and** on the
      `installation_repositories` event, whichever arrives first.
- [ ] The dashboard shows exactly which repositories are in scope.

**Design** — Without this, a customer who deliberately restricted the App would still receive
events from repositories outside the selection, which is a data-scoping violation they
explicitly chose to avoid. It is also the check that keeps `check_run` events from forked
repos out of the wrong workspace.

**Errors** — an out-of-scope repository is `403` + `unauthorized_repository` + audit. It is
**not** silently routed to "no integration".

**Security** — this is the tenant boundary for repository-level scoping.

**Tests**
- `selected_installation_rejects_out_of_scope_repositories`
- `removed_repository_is_rejected_immediately`
- `repository_set_syncs_from_installation_repositories_events`

**Deps** — F57, F68.

---

## F68 — Lifecycle events as security events

**Priority** P0 · **Status** ✅ lifecycle events applied immediately and audited (PR #11, `lifecycle.ts`, `tests/github/install-flow.test.ts`); no real-App rehearsal

**Story** As a security reviewer, I want App authorization changes treated as security
incidents, so that a revoked customer loses access immediately and visibly.

**Acceptance**
- [ ] `installation` (`created`, `deleted`, `new_permissions_accepted`, `suspend`,
      `unsuspend`) and `github_app_authorization` are **security events**.
- [ ] On `suspend`/`deleted`: immediately stop delivery, suspend the connection, notify the
      workspace, write an audit event.
- [ ] On `github_app_authorization`: *"when it receives this webhook, it stops calling the API
      on behalf of the person who revoked the token."* We hold no user tokens (no
      `request_oauth`, F55), so the action is to record and audit.
- [ ] `installation` and `installation_repositories` **cannot be unsubscribed** from — they
      are delivered by default and are how we learn about revocation at all.
- [ ] Every lifecycle transition writes an `audit_events` row (F222).

**Design** — The unsubscribable nature is the point: these two events are our only reliable
revocation signal. Treating them as ordinary telemetry means a revoked customer keeps
receiving notifications indefinitely.

**Errors** — a missing/disabled webhook means we may not learn of a revocation. Mitigation:
token refresh failure (F66) is a secondary detection path, and the dashboard prompts the
customer to reinstall when the installation goes stale.

**Security** — this is revocation handling. Getting it wrong is a continuing-access failure.

**Tests**
- `suspend_stops_delivery_immediately`
- `deleted_installation_is_suspended_and_audited`
- `lifecycle_events_cannot_be_unsubscribed_and_are_always_handled`

**Deps** — F57, F68, F222.

---

## F69 — Reconciliation and backfill

**Priority** P0 · **Status** ⛔ blocked on the GitHub App private key and API access (F65/F66); nothing is implemented or claimed · **New, from research**

**Story** As a customer, I want gaps in my event stream to be filled, so that a transient
ingress bug does not permanently lose a CI failure notification.

**Acceptance**
- [ ] A scheduled reconciliation compares recent repository activity (via REST/GraphQL)
      against `event_receipts` for a bounded window.
- [ ] Missing events are synthesized into canonical envelopes with
      `reconciled: true` and `providerApiVersion` captured, then routed normally.
- [ ] Reconciliation is **bounded** — a window of hours, not months — and **budgeted**, never
      run inline.
- [ ] It runs at low frequency (hourly) and is disabled by default on the free tier.
- [ ] Reconciled events are **labelled** in the dashboard so nobody mistakes a reconstructed
      event for a live one.

**Design** — Because GitHub does not retry, this is not a nice-to-have; it is the mechanism
that makes the "at-least-once we never lose your events" claim honest on the **inbound** side.
Combined with F65 (detect) it closes the loop that our whole retry architecture cannot.

**Errors** — budget exhaustion stops the job and records `reconciliation_incomplete` rather
than half-running silently.

**Security** — synthesized events carry a synthetic `providerid` clearly marked as
reconstructed, so they can never be confused with a real delivery for dedup purposes.

**Tests**
- `reconciliation_detects_and_fills_a_known_gap`
- `reconciled_events_are_labelled_and_flagged`
- `reconciliation_respects_its_budget_and_window`

**Deps** — F65, F66, F192.

---

## F70 — Disconnect and data removal

**Priority** P1 · **Status** 🟡 uninstall or deletion events mark the installation `uninstalled` and stop delivery (`lifecycle.ts`), destination credentials untouched, workspace deletion purges installs (`src/pipeline/purge.ts`); not built: user-initiated disconnect, UI copy, token revocation (no tokens held)

**Story** As a customer, I want to disconnect GitHub and have everything removed, so that I
can satisfy a repo deletion request.

**Acceptance**
- [ ] Disconnect stops the App's delivery immediately and revokes our installation token.
- [ ] Connection row is marked `uninstalled`; envelope and credential ciphertext are purged
      per retention (F51).
- [ ] Destination credentials are retained — they belong to the workspace, not to GitHub —
      and the UI says so explicitly.
- [ ] A full audit trail of the connection's life is retained per the audit policy.

**Design** — Deleting the customer's destination credentials when they disconnect GitHub
would be wrong and surprising; deleting our GitHub token is required. Making that distinction
visible in the UI prevents a support ticket.

**Errors** — revoking a token that is already revoked is a no-op success.

**Security** — token revocation must actually call GitHub, not just delete the row, or a
leaked token stays valid at GitHub.

**Tests** — `disconnect_revokes_the_installation_token_at_github`;
`destination_credentials_survive_source_disconnect`.

**Deps** — F57, F51.

---

## F71 — Connector contract conformance

**Priority** P0 · **Status** 🟡 `SourceDescriptor` (`tests/conformance/descriptors.ts`) plus one conformance suite run against GitHub, generic, GitLab and Stripe (`tests/conformance/conformance.test.ts`); not built: the full `SourceAdapter` interface (`parse`, `capabilities`, `health`) as one type

**Story** As a maintainer, I want every source to satisfy one interface, so that adding
GitLab or Stripe does not mean re-learning the architecture.

**Acceptance** — every source adapter implements:

```ts
interface SourceAdapter {
  readonly id: string;               // 'github'
  readonly adapterVersion: string;   // '1.0.0'
  verify(raw: RawRequest, conn: Connection): Promise<VerifiedDelivery>;  // throws AuthError
  parse(raw: RawRequest): ProviderEvent;                              // never trusts input
  normalize(ev: ProviderEvent): CanonicalEvent;                       // pure
  catalog(): EventTypeDescriptor[];                                    // closed list
  capabilities(): SourceCapabilities;                                 // onboarding UX
  health(conn: Connection): Promise<ConnectionHealth>;
}
```

- [ ] `verify` runs **before** `parse`. Enforced by a unit test that fails if a source's
      handler calls `parse` without a prior `verify` success.
- [ ] `classifyError` is on the destination side (F13) and maps onto our closed taxonomy.
- [ ] `capabilities()` is what the setup wizard renders from, so a connector cannot be
      "supported" in the UI without declaring what it supports.

**Design** — This is the contract `docs/ARCHITECTURE.md` already describes. Making it an
enforced interface with a conformance suite is what stops it drifting.

**Errors** — a source that throws on a payload it should tolerate fails its conformance test.

**Security** — `verify` is the only place a source's credential is read. `parse` and
`normalize` receive already-verified data and must not re-read the credential.

**Tests** — a shared conformance suite runs against every registered source adapter.

**Deps** — F41.

---

## F72 — Fixture replay suite

**Priority** P0 · **Status** 🟡 replay suite over documented examples with goldens for canonical event, routing and four destinations (`tests/fixtures/replay.test.ts`, `tests/fixtures/README.md`); fixtures are documented or derived examples, not real captures; not built: octokit payload-schema validation, a real sanitisation run · **Fixes** part of D13

**Story** As a maintainer, I want real captured provider payloads as fixtures, so that an
upstream change breaks a test rather than a customer's channel.

**Acceptance**
- [ ] Fixtures are **captured from real deliveries** (sanitized), committed, and versioned by
      capture date.
- [ ] Each fixture records which event type it covers and which adapter version parsed it.
- [ ] Replay asserts: verify passes → parse succeeds → normalize produces the expected
      canonical event → render produces the expected destination payload.
- [ ] GitHub's machine-readable payload schemas
      ([octokit/webhooks](https://github.com/octokit/webhooks/tree/main/payload-schemas/api.github.com))
      are used to validate fixtures — they are GitHub-maintained, so drift is upstream-visible.
- [ ] Capture is a documented manual procedure with a sanitization checklist, because
      captured payloads contain real repository content and PII.

**Design** — GitHub: *"GitHub continues to add new event types and new actions to existing
event types."* Fixture replay is how we find out before a customer does. Without captured
fixtures, every parser change is untested against reality.

**Errors** — a fixture that no longer parses is a **CI failure**, not a skipped test. Skips
are how fixture suites quietly become useless.

**Security** — ⚠️ fixtures must be sanitized before commit: no tokens, no emails, no private
repo names, no real URLs. A CI check greps fixture files for the F12 denylist.

**Tests** — the suite is the test. Plus `fixtures_contain_no_denylisted_secrets` as a guard
against a future contributor committing a raw capture.

**Deps** — F12, F71.