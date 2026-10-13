# 16 — Optional AI & The Post-V1 Roadmap

> External references read **2026-10-13**. Competitive billing facts are cited to
> `docs/specs/COMPETITIVE-FEATURE-SET.md`, which is the source of record. Security taxonomy
> cited to <https://genai.owasp.org/llm-top-10/> (loaded 2026-10-13).
>
> **Part A is not authorised for V1.** `docs/PRODUCT.md` lists "AI-generated facts" under
> **Non-goals**. `docs/ROADMAP.md` places it in P3 "Expand by demand". This file specifies it so
> that when it is authorised, it cannot be built in a way that violates `AGENTS.md` — and so that
> the constraints are on paper **before** there is commercial pressure to route around them.

## The constraint this file exists to enforce

`AGENTS.md`, verbatim:

> AI is optional and later: explain/filter/summarize noisy events with human-visible provenance,
> explicit opt-in, budget controls and deterministic fallback. **Never silently fabricate event
> facts.**

Two sentences. Everything in Part A is an engineering expression of the second one; everything
in Part A's acceptance criteria is a test for the first. A feature that satisfies "explain,
filter, summarize" but fails "never silently fabricate" is not this feature.

**The test a reviewer should apply to every F24x:** *if the model returns something false, what
does the customer believe, and is the belief visibly attributable to a machine?* If the answer
involves a sentence, a badge or a "possible" that a human may miss, the design is wrong.

---

# PART A — Optional opt-in AI

## What is allowed, and what is not

A closed set. This is not a starting point for expansion.

| Allowed | Shape | Delivered as |
| --- | --- | --- |
| **Summarize** | A short plain-language line about an event that **already exists in the message** | One labelled line, below the deterministic content |
| **Filter-assist** | Recommend suppressing an event that a deterministic rule could also suppress | A suggestion the user accepts once and writes back as a **deterministic rule** |
| **Explain** | Answer "why is this noisy?" or "what changed?" from the event's own fields | In-app, in the dashboard only — **never** in the notification body |

| Forbidden | Why |
| --- | --- |
| Generating an event title, actor, status, branch, link or any canonical field | That is fabricating an event fact. `AGENTS.md`, absolute |
| Rewriting a deterministic field "more clearly" | Same, with extra steps |
| Creating, modifying or deleting a routing rule autonomously | "Never arbitrarily…"; a routing change with no human is an unreviewed configuration change |
| Any model output in a URL, an action button, or a field that a capability trusts | Improper output handling — OWASP **LLM05:2025** (<https://genai.owasp.org/llm-top-10/>) |
| Sending raw private-repository payloads to a third party without explicit, specific consent | `docs/SECURITY.md` forbids exposing private event payloads to AI providers by default |
| Any claim of accuracy, confidence score, or "AI-detected anomaly" | OWASP **LLM09:2025 Misinformation**; we have no basis for a number and `AGENTS.md` bans fabricated benchmarks |

---

## F243 — AI capability boundary and the deterministic-first contract

**Priority** P2 · **Status** not started

**Story** As a customer, I want AI to be an optional extra I turn on myself, so that my
notifications never change because a model decided to.

**Acceptance**

- [ ] **AI is disabled by default at every level** — workspace, integration, per-destination.
      There is no trial, no beta cohort auto-enrolment and no "AI-assisted" preset.
- [ ] ⭐ **The deterministic path is executed unconditionally and first.** The canonical event
      is verified (F058), normalized (F062), rendered (F091) and durably accepted (F169) with
      **no model involvement**. The AI stage is a later, optional, separately-queued stage that
      consumes an already-recorded delivery. If F243 were reverted entirely, the product would
      behave identically minus three optional lines — and that must be verifiable by a test.
- [ ] The three capabilities (summarize, filter-assist, explain) are **independently
      switchable**. Enabling summarize must not enable anything that can suppress a message.
- [ ] Filter-assist output is **never applied automatically**. It becomes a suggestion in the
      dashboard; accepting it writes a **deterministic rule** (F161/F163) that the user can read,
      edit and delete without the model. The model is a rule *authoring assistant*, never a rule
      engine.
- [ ] Explain output is **dashboard-only** and is never delivered to a destination. A model
      answer in a Slack channel is a message the user will act on, with no provenance chrome to
      disambiguate it, which is precisely the fabrication risk.
- [ ] The AI stage is additive: **it can only ever reduce noise when it succeeds**, and when it
      fails or is disabled the deterministic behaviour applies unchanged. There is no path on
      which a model failure results in a notification not being sent, and no path on which
      suppression depends on a model being reachable.
- [ ] Every capability writes a **disclosure line** to the audit trail (F222) when enabled,
      disabled, or when its budget is exhausted.
- [ ] ⭐ **A single feature flag disables all AI in the account**, off the critical path, with
      no redeploy and no customer action — and a tested kill path (F252).
- [ ] The provider is **pluggable behind an interface** identical in shape to F091's
      `DestinationAdapter` — `capabilities / validate / render / send / classifyError` — so the
      AI stage is testable with a fake provider and the production provider is swappable. ⚠️ The
      provider choice, model ids, token prices and rate limits are an ADR with numbers read at
      implementation time; **no cost figure is asserted in this file**.

**Design** — The architectural decision that matters is **deterministic-first execution**. The
tempting design is a pre-render "AI filter" that decides whether an event is worth sending; it
is faster and cheaper and it is wrong here, because a model outage then becomes a notification
outage, and a model that is confidently wrong silently drops a CI failure. By rendering and
accepting first, AI can only ever *add* (a summary line) or *suggest* (a rule) — it can never
subtract a notification the deterministic system already decided to send. That single ordering
choice converts the entire Part A risk surface from "may lose notifications" to "may add
inaccurate text that is visibly labelled".

The cost is that we pay for a render that is later augmented, and that summarize cannot reduce
volume. Both are acceptable. Losing a CI failure is not.

**Schema**

```ts
type AiCapability = 'summarize' | 'filter_assist' | 'explain';

interface AiProvider {                       // mirrors DestinationAdapter (F091)
  readonly id: string;
  readonly adapterVersion: string;
  capabilities(): { max_input_bytes: number; max_output_tokens: number;
                    supports_structured_output: boolean };
  validateConfig(raw: unknown): Promise<ValidatedAiConfig>;
  render(ev: DeterministicEnvelope, task: AiTask, caps: AiCapabilities): AiRequest;
  invoke(req: AiRequest, cfg: ValidatedAiConfig): Promise<AiResponse>;  // no tools, no network
  classifyError(e: unknown): { code: AiErrorCode; retryable: boolean };
}

// Ordering invariant, asserted by a test:
type DeliveryFlow = { stages: ['verify','normalize','render','durable_accept',
                               '?(ai_summarize)','?(ai_filter_suggest)','send'] };
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| AI disabled (all levels) | Stage absent. Deterministic path byte-identical to no-AI |
| Provider unreachable | F248 deterministic fallback. **Never** a delivery failure |
| Provider error unmapped | Classified `ai_unavailable`, retried on the AI queue only, then dropped with a metric. Delivery is unaffected |
| Model returns invalid output | F250 validation rejects → deterministic content only |

**Security** — The AI stage runs **after** durable acceptance and holds the same tenant-scoped
data as the renderer. Provider credentials are Worker secrets, never customer-supplied, and a
customer cannot point us at an arbitrary model endpoint — that would be an SSRF vector with an
egress bill attached (F102's threat class). No customer data reaches the provider except what
the consent in F246 explicitly scopes.

**Tests**
- `deterministic_path_is_identical_with_and_without_ai`
- `ai_never_precedes_durable_acceptance`
- `summarize_filter_assist_and_explain_switch_independently`
- `filter_assist_never_applies_a_rule_without_human_acceptance`
- `explain_output_is_never_delivered_to_a_destination`
- `ai_failure_never_causes_a_notification_not_to_be_sent`
- `provider_is_swappable_behind_a_fake_in_tests`
- `disabling_all_ai_is_a_runtime_flag_not_a_redeploy`

**Deps** — F169, F091, F222, F252. **Authorised by** — nothing yet; see the file header.

---

## F244 — The hard rule: model output is never a source fact

**Priority** P0 (of Part A) · **Status** not started

**Story** As a customer, I want to know precisely which parts of a notification came from GitHub
and which parts a machine wrote, so that I never act on an invention.

**Acceptance** — this is the feature that makes `AGENTS.md`'s prohibition testable. It defines
the **provenance class** attached to every field of every rendered message.

- [ ] ⭐ Every string in a rendered message carries a provenance class, and the renderer
      **cannot** emit an unclassified string:

```ts
type Provenance =
  | { class: 'source_field';  field: string;      source: 'github_payload' }  // verbatim, escaped
  | { class: 'derived';       from: string[] }    // computed by us from source fields only
  | { class: 'link';          to: 'canonical_url' }  // always the source's own URL
  | { class: 'ai_generated';  task: AiCapability; model_id: string; prompt_version: string;
                              disposition: 'labelled_line' | 'dashboard_only' }
  | { class: 'fallback';      because: AiErrorCode };                          // F248
```

- [ ] **Hard rule, enforced in code not convention:** a field of class `ai_generated` is
      structurally incapable of occupying a slot that a `source_field` occupies. It cannot be
      the message title, the actor, the outcome chip, the repository, the branch, the link, a
      button URL, or anything a capability (`canUpdate`, `supportsInteractive`) consumes.
- [ ] **The AI line is additive and last.** It renders after the deterministic content, is
      visually separated, and is **removed entirely** by any destination that cannot render it
      safely — never squeezed in place of real content.
- [ ] ⭐ **Missing data is never inferred.** If the payload lacks an actor we render `—` and say
      nothing. `AGENTS.md`: *"If a payload is missing a field, render '—' and say so; do not
      invent a title or an actor."* No capability, including summarize, may fill a gap. This is
      a **negative** acceptance test with a named fixture (a commit with no author, a workflow
      run with no conclusion).
- [ ] Every `ai_generated` string is stored with its provenance on the delivery row, so the
      message the user received can be reconstructed exactly, months later, with its class
      visible.
- [ ] A **provenance assertion test** runs over every destination adapter's output: for each
      rendered message, the multiset of `source_field` strings is a subset of the canonical
      envelope's strings. A test that fails when the renderer hallucinates a field is worth more
      than any prompt instruction.
- [ ] ⭐ **No summarisation of a single field.** A summary may describe a field's *relationship*
      (*"3 failures on the same workflow"*) only where every constituent is present in the
      envelope. It may not paraphrase a value into something not literally derivable.
- [ ] Copy review: every user-facing string in the AI surface is reviewed by a non-author, with
      the specific question *"could a reader take this as a GitHub fact?"* — the same
      copy-test discipline as F220.

**Design** — "Never silently fabricate" is usually implemented as a prompt instruction and a
review checklist. Both fail. A prompt is advisory, and a checklist is enforced by whoever
happens to be reviewing. This feature makes it **structural**: the renderer has a typed slot for
AI text and it is not the slot the title goes in. A bug that mislabels an AI line as a source
field is caught by the provenance assertion test, not by a customer screenshotting a CI failure
we invented.

The refusal to fill gaps is the part that will feel wrong to build. A summary that says
*"a build failed"* is more useful than one that says *"a workflow run completed with conclusion
failure (actor unknown)"*. We accept the less pleasant output, because a notification product
that invents an actor will, exactly once, tell someone the wrong person broke the release.

**Schema**

```ts
// Every string in a rendered message is one of these. There is no third option:
// a bare string cannot reach the renderer, so a field cannot be left unclassified.
type RenderedField =
  | { provenance: Extract<Provenance, {class:'source_field'}>; value: string }
  | { provenance: Extract<Provenance, {class:'derived'}>;      value: string }
  | { provenance: Extract<Provenance, {class:'link'}>;         value: string }
  | { provenance: Extract<Provenance, {class:'ai_generated'}>; value: string }
  | { provenance: Extract<Provenance, {class:'fallback'}>;     value: null };

// Compile-time invariants:
//  1. renderMessage(): RenderedField[] - never string[]
//  2. slotFor(field): 'title'|'actor'|'outcome'|'repo'|'link'|'button'
//     accepts SourceField|Derived|Link only. AiGenerated cannot typecheck there.
//  3. aiSourceStrings(m: RenderedMessage): string[] - asserted subset of the envelope.
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| AI text would occupy a source slot | Build-time type error; impossible at runtime |
| AI text exceeds destination cap | AI line dropped, deterministic message delivered intact, recorded as `truncated_ai` |
| Canonical field missing | Render `—`. Summarize does not fill it |
| Provenance lost on a stored delivery | Delivery detail shows the message with its class map; missing class renders as `unknown`, never as `source_field` |

**Security** — AI text is **rendered as text**, escaped with the same per-destination escaping as
any other string (F094). It never reaches a URL, a mention context, an interactive payload or an
`allowed_mentions` decision. A PR titled `@here fix login` summarised by a model must still not
ping anyone — the summariser does not launder F094's protection.

**Tests**
- `ai_text_cannot_occupy_a_source_field_slot`
- `rendered_source_strings_are_a_subset_of_the_canonical_envelope`
- `missing_canonical_fields_render_as_placeholder_and_are_never_inferred`
- `ai_line_is_rendered_after_deterministic_content_and_is_removable`
- `ai_line_is_dropped_on_overflow_without_touching_the_real_message`
- `delivery_detail_reconstructs_the_exact_message_with_its_provenance`
- `ai_text_is_escaped_per_destination_and_cannot_trigger_mentions`
- `copy_test_rejects_strings_readable_as_source_facts`

**Deps** — F041, F043, F094, F095, F244 (self), F220.

---

## F245 — Provenance display in the delivered message

**Priority** P1 (of Part A) · **Status** not started

**Story** As a customer, I want AI-written text to be visibly AI-written, so that I can weigh it
differently from the facts beside it.

**Acceptance**

- [ ] The AI line renders with a **persistent, non-dismissible** marker: a label reading
      `Written by AI` (localised, F224) plus a visual separator. The label is **text, not an
      icon and not colour** — it must be legible to a screen reader and in a printed screenshot
      in a channel (1.4.1, F221).
- [ ] ⭐ **The label travels with the message, not with the product.** It appears in the Slack
      block, the Lark card, the Teams Adaptive Card and the dashboard event detail. If a
      destination cannot render the label as text, **the AI line is dropped** — an unlabelled AI
      sentence in a customer channel is exactly the failure this feature exists to prevent.
- [ ] Destination-specific presentation, capability-gated (F092/F093), never silent:
      | Destination | Presentation |
      |---|---|
      | Slack | `_Written by AI:_ <line>` inside the block, with the label inside the **top-level `text`** so screen readers reach it |
      | Lark | A divider element and a labelled note element in the card |
      | Teams | A `TextBlock` with `isSubtle` **and** the literal label string |
      | Plain-text fallbacks | A bracketed prefix — `[AI summary] <line>` |
- [ ] The label names the **capability**, not the model: `AI summary`, `AI explanation`. Naming a
      model version in customer-facing copy creates a support surface we would then have to keep
      accurate; the model id lives in the delivery detail and the audit trail.
- [ ] The dashboard's **event detail** shows the provenance map: which fields came from GitHub,
      which were derived, which were AI-written, and which capability produced them. The delivery
      detail shows the same map for the rendered message.
- [ ] ⭐ **A fallback is labelled as a fallback, or not shown at all.** When F248's deterministic
      path runs, the message carries **no** AI label (nothing was written) and the event detail
      records `disposition: 'fallback'` with the reason. A "no AI summary" line on every message
      when the provider is down is noise; silence with a recorded reason is correct.
- [ ] Users can **turn the AI line off per destination** without turning AI off everywhere, and
      without affecting filter-assist.
- [ ] The label is part of the message **payload**, so it is stored with the delivery and
      reproduced exactly on replay (F182). A replayed message must not lose its label, or it
      becomes an unlabelled AI sentence in the channel.

**Design** — The screen-reader consequence is why this is its own feature rather than a detail of
F244. Slack's own documentation states that *"screen readers will default to the top-level text
field of your post, and will not read the content of any interior blocks"*
(`docs/DESTINATION_API_REFERENCE.md` §1.6). If the label lives in an interior block it is
**invisible to the screen-reader user** — the very user least able to spot that a sentence is
machine-written is the one who never gets told. Hence the label must be in the top-level `text`
alongside the summary, which is the same requirement F221 and F143 already impose.

Second decision: **the label is text, never an icon.** An icon is invisible to a screen reader,
to a monochrome print, and in a channel screenshot forwarded to someone who will act on it.

**Schema**

```ts
type ProvenancePresentation = {
  label: string;                 // localised: 'AI summary' | 'AI explanation'
  placement: 'inline_suffix' | 'divided_section' | 'bracketed_prefix';
  in_top_level_text: boolean;    // MUST be true for Slack; drives the F221 test
  delivered: boolean;            // false when the destination cannot render the label
  dropped_reason?: 'destination_cannot_render_label' | 'over_body_cap' | 'user_disabled';
};
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Destination cannot render the label as text | AI line **not delivered**; recorded as dropped; event detail still shows it |
| Label would exceed the top-level `text` cap | Shorten the AI line, keep the label; if impossible, drop the line |
| User disabled AI text for this destination | Line not generated at all — we do not generate and discard |
| Replay | Label restored from the stored provenance |

**Security** — The label is a fixed localised string with **no interpolation of user data**, so
it cannot carry injected content. AI text inside it remains escaped (F244).

**Tests**
- `ai_label_is_text_not_an_icon_and_is_present_in_slack_top_level_text`
- `ai_line_is_dropped_rather_than_delivered_unlabelled`
- `fallback_runs_show_no_label_and_are_recorded_in_the_event_detail`
- `label_can_be_disabled_per_destination`
- `replayed_message_retains_its_provenance_label`
- `destination_presentation_matrix_is_tested_for_every_adapter`

**Deps** — F244, F092, F093, F182, F214, F221, F224.

---

## F246 — Explicit, scoped, per-integration opt-in

**Priority** P0 (of Part A) · **Status** not started

**Story** As a customer, I want to choose exactly where AI runs, so that my private repository
content is never sent anywhere I did not choose.

**Acceptance**

- [ ] ⚠️ **Consent is per integration, per destination, per capability, and revocable.** A
      workspace-level default does not exist. There is no "all integrations" switch, because the
      consent that matters is *"this repository's content"* and an aggregate switch cannot
      express it.
- [ ] Before enabling, the UI states in plain language what leaves the workspace:

> Summaries for `acme/api` will be sent to our AI provider (provider name). What is sent:
> the event type, repository name, issue or pull request number, title, and the comment or
> commit message. What is **not** sent: the event body in full, file contents, diffs, code, any
> destination credential, any user email address, any internal identifier. Private repository
> content is included.

      and the user must tick **two** boxes — *"I understand private repository content will be
      sent to a third party"* and *"I have authority to do this"* — before the control enables.
- [ ] **Nothing is sent before consent.** There is no sampling, no evaluation-mode traffic, no
      "we improve the model with your data" default. Absent a recorded consent row, the AI
      stage does not run and the provider sees nothing.
- [ ] ⭐ **The consent is scoped to a data allow-list, not to "the event".** F249's prompt
      builder has an explicit field list. A field added to the canonical envelope later does not
      automatically enter the prompt — the allow-list is versioned and a change to it **requires
      re-consent**. This is the single most important privacy control in Part A and it is the
      one most likely to be skipped: an "everything except secrets" policy is an
      unbounded-content policy.
- [ ] Consent records: who consented, when, which fields, which provider, which prompt version,
      and the exact disclosure text shown. `AGENTS.md` requires auditability and F222 renders it.
- [ ] **Revocation stops new sends immediately** and states what already happened: *"Summaries
      for `acme/api` are off. 1,284 summaries were generated before you turned this off; they
      remain in your delivery history."*
- [ ] **Destructive-adjacent behaviour is explicit:** turning a capability on is **per
      integration**, so a workspace with 40 integrations has 40 independent decisions, and the
      Integrations list shows the AI state of each. There is no bulk enable.
- [ ] ⚠️ **Sub-processor changes re-open consent.** If the provider or the model changes, every
      consent for that provider is marked `needs_renewal`, AI stops for that integration, and the
      user is asked again. A consent is consent to a named processor, not to a category.
- [ ] The customer-facing privacy statement says all of this in one place, and the disclosure
      text shown in-product is the **same text** as the public statement (one source, versioned).
- [ ] ⭐ **The consent gate is checked in the same transaction that would send.** There is no
      ordering in which a message reaches the provider without a committed consent row for that
      `(org_id, integration_id, capability, prompt_version)`.

**Design** — Two decisions worth defending.

**Why two checkboxes and not one.** A single "I understand" is a speed bump; it is clicked at
the same rate regardless of content. Splitting it into *what is being sent* and *whether you have
authority* catches two different failure modes: the user who did not read, and the user who
delegated the setup to someone without authority to send private repository content to a third
party. `docs/PRODUCT.md`'s audience #4 is explicitly an agency/operator serving many customer
workspaces — authority is a real, recurring concern in exactly that shape.

**Why the allow-list is versioned with re-consent.** This is the control that would otherwise be
skipped forever, because it looks like over-engineering until the day someone adds `diff` to the
envelope and every customer's private source code starts going to a model provider with no new
consent. A consent that silently widens is not consent.

**Schema**

```ts
// A closed union: adding a field is a compile-time change that ALSO bumps
// fields_version, which invalidates every existing consent (F246's core control).
type AllowlistedField =
  | 'event_type' | 'repository_full_name' | 'subject_kind'   // 'issue'|'pull_request'|'workflow_run'
  | 'subject_number' | 'title' | 'actor_login' | 'outcome'
  | 'branch' | 'comment_body' | 'commit_message' | 'canonical_url';

type AiConsent = {
  org_id: string; integration_id: string; destination_id: string | null;
  capability: 'summarize'|'filter_assist'|'explain';
  fields_version: number;            // bumped -> consent needs_renewal
  prompt_version: string;            // bumped -> consent needs_renewal
  provider: string; model_id: string;
  disclosure_text_version: string;   // the exact wording the user was shown
  granted_by: string; granted_at: string; revoked_at: string | null;
};
// Hard deny-list, enforced in addition to the allow-list:
//   destination credentials, webhook URLs, user emails, session material,
//   internal ids, diffs, file contents, raw payload bytes.
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| No consent row for `(integration, capability, prompt_version)` | Stage does not run. No egress |
| Consent exists for an older prompt/field version | `needs_renewal`; AI paused; user re-consents |
| Provider changed | All consents for the old provider `needs_renewal` |
| Revoked | Immediate stop; history retained and stated |

**Security** — Consent is **tenant-scoped on read and write** (F026) and is an append-only row,
so a revoked consent is never deleted (F222/F030). The AI prompt builder is a **whitelist
serialiser**: it physically cannot serialise a field not on the allow-list, so a future
developer adding a field to the envelope cannot leak it by forgetting the prompt. Destination
credentials, user emails, session material, internal ids, tokens, webhook URLs and raw payload
bytes are on a hard deny-list in addition to the allow-list.

**Tests**
- `no_event_content_is_sent_before_a_consent_row_exists`
- `consent_is_required_per_integration_destination_and_capability`
- `no_bulk_enable_exists`
- `prompt_serialiser_cannot_emit_a_field_outside_the_allow_list`
- `changing_the_allow_list_marks_consents_for_renewal_and_stops_ai`
- `changing_the_provider_marks_consents_for_renewal_and_stops_ai`
- `revocation_stops_new_sends_and_reports_history_retained`
- `credentials_and_identifiers_are_on_the_deny_list_and_never_serialised`
- `consent_is_checked_in_the_same_commit_as_the_send`

**Deps** — F244, F222, F026, F030, F249.

---

## F247 — Budget controls and hard spend caps

**Priority** P0 (of Part A) · **Status** not started

**Story** As a customer paying for this, I want a hard ceiling on what AI can cost me, so that a
noisy repository cannot produce an unexpected bill.

**Acceptance**

- [ ] **Three independent ceilings**, all mandatory and all defaulting to a non-zero, finite
      value the customer must acknowledge:

| Control | Scope | Default | Behaviour at the ceiling |
| --- | --- | --- | --- |
| **Monthly spend cap (USD)** | Workspace | $X ⚠️ *set as a product decision; the default is not zero and is not asserted here* | AI **disabled** for the workspace until reset or a raise; surfaced |
| **Monthly request cap** | Workspace | finite integer | Same |
| **Per-event request cap** | Integration | 1 (one summarize per delivered message) | Silent for the remainder of the month, **counted and surfaced** |

- [ ] ⚠️ **The spend cap is enforced by reservation, not by after-the-fact accounting.** Before
      each call, the estimated cost is reserved against the workspace's remaining budget in D1;
      the call is made; the actual cost is reconciled after. Without a reservation, N concurrent
      queue consumers all read "budget available" and all proceed — a classic TOCTOU, and the
      cap becomes advisory exactly when volume is high.
- [ ] **The cap cannot be exceeded by configuration**: raising a cap requires an explicit,
      audited, owner-only action, and the UI states the new ceiling and the prorated cost.
  Lowering it takes effect immediately and may strand in-flight requests — stated, not hidden.
- [ ] **Zero is a legal value and the UI offers it.** *"No AI"* is the cap. A customer who wants
  none must be able to say so explicitly and get a hard guarantee of zero spend.
- [ ] Exhaustion is **visible and non-alarming**: *"AI reached its £/$X limit for October. It
      turns back on on 1 November, or you can raise the limit."* Notification, dashboard banner,
      and the AI panel. **Never** silent degradation.
- [ ] ⭐ **Exhaustion degrades to F248's deterministic behaviour and never to a delivery
      failure.** The budget gate is checked *before* the AI stage is enqueued, so a
      budget-exhausted workspace does not even pay queue throughput.
- [ ] **A hostile or accidental flood cannot run up a bill.** An attacker with commit access to
      a connected repository can push thousands of commits; an integration with 50 repositories
      can produce 50 requests per minute. So: per-integration, per-destination and per-workspace
      **rate limits** on the AI stage exist independently of the monthly caps, and the
      rate-limited subset is **not billed** to the customer — it is our cost, and treating an
      attack as a customer cost is a denial-of-wallet-service bug. This is OWASP
      **LLM10:2025 Unbounded Consumption** (<https://genai.owasp.org/llm-top-10/>).
- [ ] Cost is metered **per capability per model**, stored with the response, and visible on the
      AI panel as a monthly figure. ⚠️ Model prices are read from the provider at implementation
      time; **no price is asserted in this file** and the meter stores provider-reported usage
      alongside our computed cost so a price change is reconcilable.
- [ ] **AI spend is never folded into the subscription price of messages** (F253). They are
      different meters with different consequences and merging them recreates exactly the
      punishment-of-suppression problem F253 exists to avoid.
- [ ] A **dry-run/estimate** mode shows projected monthly cost from the last 7 days of real
      event volume before the customer enables anything, labelled as a projection with its window
      stated (same honesty rule as F210's volume estimate).

**Design** — Reservation-before-call is the difference between a cap and an estimate, and it is
the detail most implementations skip. The failure is invisible in testing and dramatic in
production: one slow month, several hundred concurrent queue consumers, every one of them
reading the same `budget_remaining` value before any of them writes.

The second decision — **an attacker's volume is not the customer's bill** — is worth stating
out loud because the naive implementation (charge per request, refund nothing) means anyone who
can push to a connected repo can spend a customer's money. That is a financial denial-of-service
against a paying tenant and it must be designed out, not documented.

**Schema**

```sql
CREATE TABLE ai_budgets (
  org_id                TEXT PRIMARY KEY,
  monthly_cap_cents     INTEGER NOT NULL,        -- 0 == AI disabled for the workspace
  monthly_request_cap   INTEGER NOT NULL,
  spent_cents_reserved  INTEGER NOT NULL DEFAULT 0,
  spent_cents_actual    INTEGER NOT NULL DEFAULT 0,
  requests_reserved     INTEGER NOT NULL DEFAULT 0,
  requests_actual       INTEGER NOT NULL DEFAULT 0,
  period_start          INTEGER NOT NULL,        -- UTC month boundary
  exhausted             INTEGER NOT NULL DEFAULT 0,
  updated_at            INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE ai_cost_ledger (                    -- append-only
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  capability   TEXT NOT NULL,
  provider     TEXT NOT NULL, model_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
  cost_cents   INTEGER NOT NULL,
  billed_to_customer INTEGER NOT NULL,           -- 0 for rate-limited/attack volume
  occurred_at  INTEGER NOT NULL
);
CREATE INDEX ix_ai_cost_org_period ON ai_cost_ledger(org_id, occurred_at);
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Reservation fails (concurrent contention) | Retry; on retry exhaustion, skip the AI stage this time. Delivery unaffected |
| Cap reached | AI disabled for the workspace; surfaced; deterministic fallback applies |
| Provider reports usage above our estimate | Reconcile on the next request; raise a metric. Never silently exceed the cap |
| Rate limit hit (not the cap) | Request dropped, **not billed**, metric raised as suspected volume abuse |
| Month rolls over | Budget resets; `needs_renewal` consents still block AI |

**Security** — The cap is enforced in **D1, transactionally**, so it cannot be bypassed by a
crash, a retry or a second consumer. Cost rows are tenant-scoped (F026) and append-only. The
cap state is visible to **workspace admins only** and is itself audited when changed (F222).
The customer-facing figure is computed from `billed_to_customer = 1` rows only, so our own
absorbed cost never appears as their spend.

**Tests**
- `cap_is_enforced_by_reservation_before_the_call`
- `concurrent_consumers_cannot_collectively_exceed_the_cap`
- `zero_cap_produces_zero_spend_and_is_an_offered_value`
- `exhaustion_surfaces_and_does_not_fail_a_delivery`
- `rate_limited_volume_is_not_billed_to_the_customer`
- `ai_spend_is_metered_separately_from_messages`
- `raising_the_cap_is_owner_only_and_audited`
- `cost_projection_states_its_window_and_is_labelled_a_projection`
- `budget_reads_and_writes_are_tenant_scoped`

**Deps** — F246, F248, F253, F222, F191, F026.

---

## F248 — Deterministic fallback

**Priority** P0 (of Part A) · **Status** not started · **This must always work**

**Story** As a customer, I want notifications to behave normally when the AI provider is down,
so that an outage at someone else's company does not become an outage of my alerts.

**Acceptance**

- [ ] ⭐ **The deterministic path is not a fallback — it is the path.** Fallback is defined as
      "the AI stage produced nothing", and that is the **default and overwhelmingly common
      state**. There is no code path in which a notification waits for a model before being
      decided.
- [ ] The message delivered when AI is unavailable is **byte-identical** to the message delivered
      when AI was never enabled (F243's test). The only difference is a recorded
      `disposition: 'fallback'` with the reason, visible in the event detail and not on the
      message (F245).
- [ ] ⭐ **Summary fallback is a fixed, non-generated string or nothing at all.** Options, in
      order: (a) nothing; (b) a deterministic one-line rendering that already existed
      (e.g. the collapsed-group summary from F143/F145, which is built from source fields).
      **Never** a template filled by a degraded model, and never a generic apology in the
      customer's channel.
- [ ] **Filter-assist fallback is trivially safe: do nothing.** No suggestion, no rule, no
      suppression. The deterministic filters (F161/F163) are unaffected and were never
      model-dependent.
- [ ] **Explain fallback is "unavailable"**, in the dashboard, with a retry affordance. It is a
      read-only surface, so its failure costs nothing.
- [ ] **Triggered conditions, all of which must resolve to fallback**: provider timeout ·
      provider 5xx · provider rate limit · provider content policy refusal · malformed response ·
      schema validation failure (F250) · budget exhausted (F247) · consent revoked (F246) ·
      feature flag off (F252) · `requests` capability absent · cost/region unavailable for the
      account.
- [ ] ⭐ **The AI queue is separate and lower priority.** A saturated AI queue delays summaries,
      not messages. Its consumer has a **separate concurrency limit** and its messages are
      processed with `max_retries` bounded such that exhaustion drops the summary silently —
      **the delivery is already `sent` by then**, so there is nothing to retry.
- [ ] **Provider health is monitored and the state is user-visible**: a provider status line
      (*"AI summaries are temporarily unavailable — notifications are unaffected"*) on the AI
      panel. Provider error rate, latency and fallback rate are metrics (F191) with an alert.
- [ ] **A provider outage cannot fail a delivery**, and the test for that is explicit:
      an integration test with a provider that always times out, asserting 100% of deliveries
      reach `delivered` and 0% are retried because of AI.
- [ ] ⚠️ **Cold start works.** No consent, no budget row, no provider credentials configured, no
      network — the deterministic path must function in a fresh development environment. A test
      suite that passes with AI stubbed out *is* the cold-start test.

**Design** — "Deterministic fallback" is usually written as a `catch` block, which makes it the
weakest link rather than the strongest. The correct construction is the inverse: make the
**non-AI path the only path that can produce a delivered message**, and treat the AI stage as a
consumer that may or may not exist. Then there is no fallback code to get wrong — there is
simply nothing to fail.

The one place this is easy to get wrong is the summary string. A team under time pressure will
reach for *"AI summary unavailable"* on the card, because it feels better than silence. It is
worse: it is a message about our infrastructure occupying the customer's channel, it is not a
notification, and it will be there on every single message for the duration of the outage. The
default is silence, and the cost of the outage is a missing convenience.

**Schema**

```ts
type AiDisposition = 'labelled_line' | 'dashboard_only' | 'fallback' | 'not_attempted';
type AiStageOutcome =
  | { disposition: 'labelled_line';      provenance: Provenance; cost_cents: number }
  | { disposition: 'dashboard_only';    provenance: Provenance; cost_cents: number }
  | { disposition: 'fallback';          because: AiErrorCode; detail_redacted: string }
  | { disposition: 'not_attempted';     because: 'disabled'|'no_consent'|'budget_exhausted'
                                          | 'kill_switch'|'rate_limited'|'ai_test_message' };
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Provider timeout | `fallback`, `ai_unavailable`, metric, no user-visible message change |
| Schema validation failure | `fallback`, `ai_invalid_output`, metric |
| Budget exhausted | `not_attempted`, deterministic path only |
| Test delivery (F098) | ⚠️ ⭐ **`not_attempted` — AI never runs on a test delivery.** A test message is how the customer verifies the setup; spending money and latency on it is wrong, and its preview would then not match production output, which is worse |
| Replay of a delivery with a stored AI line | The **stored** line is replayed verbatim; no new model call, no new charge |

**Security** — Fallback carries **no** partial or truncated model output: a validation failure
discards the response entirely rather than shipping a fragment. Provider errors are redacted
(F012) before storage and never rendered to the user (F220).

**Tests**
- `delivery_with_provider_always_timing_out_still_reaches_delivered`
- `no_delivery_is_retried_because_of_ai`
- `deterministic_path_runs_with_no_ai_configuration_at_all`
- `fallback_produces_no_user_visible_ai_placeholder`
- `ai_queue_saturation_does_not_delay_the_delivery_queue`
- `test_deliveries_never_invoke_the_provider`
- `replay_of_an_ai_annotated_delivery_makes_no_new_provider_call`
- `provider_outage_is_surfaced_and_never_silently_absorbed`

**Deps** — F243, F247, F252, F098, F191, F012.

---

## F249 — Prompt-injection defence

**Priority** P0 (of Part A) · **Status** not started

**Story** As a customer whose repositories accept pull requests from strangers, I want to be
sure that a malicious pull request cannot manipulate my notifications, so that my alerting cannot
be hijacked by someone submitting code.

**Acceptance** — OWASP **LLM01:2025 Prompt Injection**
(<https://genai.owasp.org/llm-top-10/>, read 2026-10-13) is the governing taxonomy. The threat is
concrete and specific to this product: **an event payload is attacker-controlled text that we
deliberately place inside a model prompt.**

- [ ] ⚠️ **Threat statement, written before the mitigation, because it is what the mitigations
      are checked against.** An attacker with write access to a connected repository (an
      open-source project is the extreme case: anyone can open a PR) can place text in: a pull
      request title or body, an issue title or body, a comment, a commit message, a branch name,
      a label, a review comment, a workflow run name, a check-run name, a username, an org name.
      All of it reaches the model. The attacker's goals, in order of plausibility: make the
      summary fabricate a fact (F244), make the summary exfiltrate other content via the
      message, make the filter-assist write a rule that suppresses a real event, make the model
      emit a URL or a mention that fires (F094), or drive unbounded consumption (F247).
- [ ] **The model has no capabilities.** No tools, no function calling, no retrieval, no HTTP, no
      filesystem, no ability to call our API or any destination. Its entire output surface is a
      validated string we already control (F250). This is the primary control, because it is the
      only one that does not depend on the model behaving.
- [ ] **The untrusted payload never occupies the instruction position.** The prompt is
      `[system instructions]` + `[delimited data block]` + `[fixed task]`. The data block uses a
      **per-request random nonce delimiter** (128 bits) that is checked against the payload; if
      the payload contains it, the request is **re-nested** with a fresh nonce or dropped, never
      sent ambiguously.
- [ ] **Field-level separation.** Each untrusted field is serialized with its field name as a
      labelled key, so the model can distinguish `title` from `comment`. A payload cannot forge a
      structural delimiter because the serialiser escapes the delimiter characters.
- [ ] **The system instruction states the rule** — that the data block is untrusted content, that
      instructions inside it must be ignored, and that the only permitted output shape is the
      validated schema. This is **defence in depth and explicitly not the primary control**;
      prompt-level filtering alone is a known-weak mitigation and saying otherwise in a spec is
      how it ends up being the only control.
- [ ] ⭐ **Content filtering of the prompt is not relied upon.** No classifier decides "this
      looks like an injection and gets stripped". Stripping destroys legitimate content (a PR
      genuinely titled *"Fix prompt injection in our parser"* is the canonical false positive)
      and produces a different message for the same event depending on a classifier, which
      breaks the deterministic-rendering guarantee in a subtle way.
- [ ] **Output is data, always.** No `eval`, no template compilation, no markdown-to-HTML
      pipeline with execution, no shell, no SQL string built from model output, no URL built from
      model output, no mention context derived from model output. The output is parsed against a
      schema and rendered as escaped text (F244/F250).
- [ ] **Per-source privilege separation:** only the fields on F246's versioned allow-list are
      serialized. Credentials, user emails, internal ids and full payloads are structurally
      unreachable (F246).
- [ ] **Cost control is part of the defence.** A hostile commit flood cannot run up a bill
      (F247), and an over-long payload is truncated to the allow-listed field caps **before**
      serialization, so an attacker cannot inflate token cost with a 1 MB comment.
- [ ] ⭐ **A committed injection test corpus**, not a demo:
      - `tests/ai/fixtures/injection/*.json` — pull request titles, issue bodies, comments, branch
        names, commit messages and workflow names containing injection attempts that attempt:
        instruction override, system-prompt exfiltration, fabrication of an actor/status, rule
        injection through a proposed filter, mention escalation (`@here`, `<@&123>`), URL
        substitution, and delimiter forgery.
      - Each fixture asserts: the rendered message contains **no** fabricated source field; the
        provenance class of every field is unchanged; no rule was written; no mention fires; no
        URL is emitted from output; the deterministic message is intact.
      - The corpus is **replayed on every provider or prompt-version change** and on every
        adapter change, because a renderer change can reintroduce an escalation path.
- [ ] **External content is quoted, never fetched.** A model that is asked about a URL is given
      the URL as text; we never fetch a URL the payload supplied. (No SSRF via a model.)
- [ ] Prompt and system-prompt versions are **immutable and recorded per request** on the cost
      ledger (F247) so an incident can be reproduced exactly.

**Design** — The design principle here is that **the model is not a security boundary**. Every
control in the list above either removes a capability from the model or makes the output
structurally harmless. The controls that *rely on the model obeying an instruction* are marked as
defence in depth and are never the only control for a property — and the spec says so explicitly,
because "we told the model not to" is the most common and most confidently wrong claim in
AI-assisted products.

The nonce delimiter deserves its own justification: it is the cheapest control that eliminates
structure forgery, costs nothing, and has no false positives. It is not a substitute for the
capability removal; it is the thing that makes the data block unambiguous.

**Schema**

```ts
type AiRequestEnvelope = {
  request_id: string;
  prompt_version: string;         // immutable, recorded per request
  system_instructions_digest: string;
  nonce: string;                  // 128-bit, per request
  fields: Array<{ name: AllowlistedField; bytes: number; escaped: string }>;
  total_input_bytes: number;      // hard cap before serialisation
};
// AllowlistedField is F246's versioned union. It is a closed type: adding a field is a
// compile-time change that also bumps prompt_version and re-opens consent.
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Payload contains the nonce | Re-nest with a fresh nonce (once), then drop with `ai_injection_suspected`, metric raised, deterministic message delivered |
| Input exceeds the cap | Truncate to the cap **with an elision notice**, then proceed. Never send an unbounded payload |
| Provider reports a content-policy refusal | `fallback` (F248), metric; **not** shown to the user as a policy warning |
| A fixture in the injection corpus produces a fabricated field | **Build fails** |

**Security** — This feature *is* the security feature. It is listed under `AGENTS.md`'s
"explicit schemas at trust boundaries" applied to the model's input and output. Field-level
escaping reuses F094's per-destination escaping for output, and the prompt serialiser is a
whitelist, not a blacklist. No user content is ever concatenated into an instruction string.
Provider responses are redacted before storage (F012).

**Tests**
- `injection_corpus_never_produces_a_fabricated_source_field`
- `injection_corpus_never_writes_a_rule_without_acceptance`
- `injection_corpus_never_triggers_a_mention_or_escapement`
- `injection_corpus_never_emits_a_url_or_button`
- `model_receives_no_tools_and_no_network_capability`
- `payload_cannot_forge_the_data_block_delimiter`
- `only_allowlisted_fields_are_serialised`
- `prompt_and_system_prompt_are_immutable_and_recorded_per_request`
- `oversized_payload_is_truncated_before_serialisation`
- `injection_corpus_runs_on_every_prompt_version_and_adapter_change`

**Deps** — F246, F094, F250, F247, F012, F244.

---

## F250 — Model output validation

**Priority** P0 (of Part A) · **Status** not started

**Story** As a customer, I want a broken or hostile model response to be discarded, so that a bad
model answer can never reach my chat channel.

**Acceptance** — OWASP **LLM05:2025 Improper Output Handling** and **LLM09:2025
Misinformation** (<https://genai.owasp.org/llm-top-10/>).

- [ ] Every task has a **closed output schema**, validated before the value exists in the
      system. Free-text is the only flexible field and it is length-capped.
- [ ] ⭐ **Validation is not the model's self-report.** A response that claims to satisfy the
      schema is checked *by us*, with a real parser, against a real schema. "Trust but verify"
      and "the model returned well-formed JSON so it must be correct" are both wrong: the model
      can emit valid JSON whose content is fabricated, and only the F244 provenance assertion
      test catches that.
- [ ] Validation rules per field:

| Field type | Rule |
| --- | --- |
| Verdict enum | Must be a member of the closed set. Anything else → discard |
| Text | Length-capped, control characters stripped, NFC-normalised, escaped per destination |
| URL | ⚠️ **Only the canonical URL from the envelope is ever used.** Any URL the model returns is discarded, not sanitised — a model-proposed URL is never trusted, because a sanitised attacker-chosen URL is still an attacker-chosen URL |
| Numbers | Bounded range; non-numeric discarded |
| Mentions | ⭐ **The model cannot produce a mention.** No mention syntax is ever passed through (F094's `allowed_mentions` policy is applied identically to AI text) |
| Identifiers | Never accepted from the model. Correlation, dedup key and delivery id are ours |

- [ ] **Credential-shaped output is discarded.** A value matching a token/URL pattern
      (`hooks.slack.com/`, `open.larksuite.com/.../hook/`, `Bearer `, a 32+ char high-entropy
      string in a context expecting prose) is rejected outright and the request is logged as
      `ai_suspicious_output` for human review. This catches an exfiltration attempt that passed
      the injection controls.
- [ ] **Discard is total.** A validation failure does **not** attempt to repair, truncate or
      partially salvage the output. The deterministic message is delivered (F248) and the
      response is discarded. A partially-valid AI line is worse than none: it is unlabelled
      half-truth.
- [ ] Validation failures are **metrics with a rate and a threshold**, not silent drops. A rising
      invalid-output rate means a prompt, a model or a schema changed — and the customer's
      messages are quietly losing their summaries.
- [ ] **Schema changes are breaking changes.** A schema version is recorded on every output; a
      response carrying an unknown schema version is discarded, not best-guessed.
- [ ] ⚠️ **Structured-output support is a capability, not an assumption.** If the provider does
      not support enforced structured output, the task falls back to a **tool/function-shaped
      call** validated by our parser, or the capability is **not enabled**. F243's provider
      interface exposes `supports_structured_output` precisely so this is a configuration
      decision with a safe default, not a runtime surprise.
- [ ] Validation runs **before** the provenance record is written, and a failed validation never
      produces a `labelled_line`.

**Design** — The decisive rule is that **a valid response is not a correct response**. The
question "did the model obey the schema?" and the question "is any of this true?" have different
answers, and only the second one is answered by F244's provenance assertion. Teams ship the
schema check; F244 ships the truth check. A feature that only ships the first gives the
appearance of safety while the actual risk — a fabricated CI status in a Slack channel — walks
straight through.

The second decision is discarding rather than repairing. Repair is tempting because the summary
is 90% fine. It is also how a partial fabrication reaches production: the repaired output
carries a `labelled_line` provenance class, which asserts that a validated AI line was attached,
and the un-repaired 10% is exactly where the fabrication sits.

**Schema**

```ts
type AiOutputEnvelope<T> =
  | { ok: true;  schema_version: string; value: T; model_id: string }
  | { ok: false; schema_version: string | null;
      reason: 'not_json'|'schema_mismatch'|'unknown_schema_version'|'field_out_of_range'
            | 'credential_shaped_output'|'url_proposed'|'mention_attempted'
            | 'too_long'|'empty'; detail_redacted: string };
// T is a closed union per capability. There is no `string` escape hatch.
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Invalid JSON / wrong shape | Discard → F248 fallback; metric |
| Unknown schema version | Discard; metric `ai_schema_drift` — raised loudly because it means a deploy mismatch |
| Credential-shaped output | Discard; metric `ai_suspicious_output`; alert if rate > 0 |
| Over-long text | Discard (not truncate) — a truncated sentence can misrepresent the event |
| Provider lacks structured output | Capability disabled; not degraded silently |

**Security** — The validator runs on the **Worker**, before any downstream consumer. No
model-derived value reaches a URL, a mention, a destination credential, an action payload or a
routing expression — the fields that could do damage are simply not in the schema (deny by
absence, not by check). Validation failure detail is redacted before storage (F012) and never
rendered to the user (F220).

**Tests**
- `valid_json_with_fabricated_content_is_still_rejected_by_the_provenance_assertion`
- `every_output_field_is_schema_validated_before_use`
- `model_proposed_urls_are_discarded_never_sanitised`
- `model_output_cannot_produce_a_mention`
- `credential_shaped_output_is_discarded_and_alerts`
- `no_partial_salvage_of_an_invalid_response`
- `unknown_schema_version_is_discarded_and_raises_a_drift_metric`
- `capability_is_disabled_when_the_provider_lacks_structured_output`

**Deps** — F244, F245, F249, F248, F191, F012.

---

## F251 — AI is never on the critical delivery path

**Priority** P0 (of Part A) · **Status** not started

**Story** As a customer, I want notifications to be as reliable whether AI is switched on or
off, so that an experimental feature cannot degrade the product it sits inside.

**Acceptance**

- [ ] ⭐ **The ordering invariant is a type, not a comment** (F243's `DeliveryFlow`): `verify →
      normalize → render → durable_accept → [ai_summarize] → send`. The `send` stage has no
      dependency edge on any AI stage, and a build fails if one is introduced.
- [ ] **Separate queue, separate consumer, separate concurrency.** The AI stage runs on
      `noti-ai-enrich` with its own `max_batch_size`, `max_retries` and concurrency limit. It
      consumes delivery ids from a table that already contains a `sent` delivery. **There is no
      queue message whose payload implies a message has not been sent.**
- [ ] **The delivery is acknowledged to the destination before the AI stage is enqueued.** GitHub
      is acknowledged after durable acceptance (F064/F169) regardless of AI. An AI provider
      slowdown can never extend a webhook request's `waitUntil` budget or hold an inbound
      Worker invocation open (Cloudflare's wall-clock and CPU limits are per-invocation and
      non-negotiable).
- [ ] **Resource isolation**: the AI consumer has a **CPU and wall-clock budget** separate from
      the delivery consumer, and a pathological AI batch can be abandoned without affecting
      deliveries.
- [ ] **A regression suite runs both worlds.** Every delivery test in `12` and `07` runs twice —
      once with the provider stubbed to a valid response, once with it stubbed to fail, hang and
      return garbage — and the assertions on delivery outcomes must be **identical**. Any
      difference is a P0 bug.
- [ ] **No shared mutable state.** The AI stage writes only to `ai_*` tables and the delivery
      row's provenance columns; it cannot alter routing, suppression, retry state or the
      destination configuration.
- [ ] **The deterministic renderer is the single renderer.** There is no AI-aware renderer
      variant, no "AI summary" rendering mode inside the renderer, and no per-capability branch
      in `DestinationAdapter.render`. Rendering stays pure and synchronous per F091; enrichment is
      a separate stage with a separate payload.
- [ ] **Documented blast radius**: a table in this file's design section listing what AI can and
      cannot affect. It can: add a labelled line to a delivered message; populate a dashboard
      explanation; propose a rule. It cannot: suppress, delay, reroute, retry, reorder, modify,
      encrypt, sign or fail a delivery.
- [ ] ⚠️ **Load-shedding test**: a sustained synthetic flood of AI-stage messages with a slow
      provider, asserting delivery latency and error rate are **flat**. This is a correctness test
      of the architecture, not a benchmark, and no performance figure is claimed from it.

**Design** — Isolation by queue is the whole design. The tempting alternative — an inline `await`
in the render path — is simpler, has no ordering to get wrong, and converts every provider
outage into a delivery outage with a 30-second Worker CPU ceiling attached. Every one of the
controls above exists to make the AI stage **unable** to be in the way rather than to detect it
when it is.

The regression suite running both worlds is what keeps this honest over time. The architecture is
correct on the day it is written; the failure mode is a later PR adding `await summarize(...)`
to a convenient place because it was faster to implement, and no test catching it. Running the
entire delivery suite with a failing provider makes that PR fail.

**Schema**

```ts
type DeliveryStage = 'verify'|'normalize'|'render'|'durable_accept'|'ai_enrich'|'send';
// Compile-time guarantee:
//   type SendDeps = Exclude<DeliveryStage,'send'>;   // send depends on all but ai_enrich
// assert (SendDeps extends Exclude<DeliveryStage,'send'|'ai_enrich'> ? false : true)
// plus a graph test over the declared stage edges in F243's DeliveryFlow.
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| AI queue backlog exceeds N | Shedding: summaries skipped, deliveries unaffected, metric `ai_shed` |
| AI consumer OOM/timeout | Queue message retried on the AI queue only; delivery already `sent` |
| AI consumer crashes mid-batch | Idempotent by `delivery_id`; no double-charge (cost ledger unique on `(delivery_id, capability)`) |
| Deployment regression introduces a send→ai edge | Build fails on the graph assertion |

**Security** — The AI stage runs **after** the message has left, so it holds no destination
credential and has no capability to send anything. Its only write path is provenance columns on
an existing row plus `ai_*` tables. Tenant scoping applies to every one of them (F026).

**Tests**
- `send_stage_has_no_dependency_edge_on_any_ai_stage`
- `ai_runs_in_a_separate_queue_with_its_own_consumer`
- `delivery_is_acknowledged_to_github_before_ai_enqueue`
- `delivery_suite_passes_identically_with_a_failing_slow_and_garbage_provider`
- `ai_stage_cannot_alter_routing_retry_or_destination_state`
- `ai_cosid_ledger_is_idempotent_per_delivery_and_capability`
- `load_shedding_leaves_delivery_latency_flat`
- `build_fails_if_a_send_to_ai_dependency_is_added`

**Deps** — F243, F064, F169, F091, F247.

---

## F252 — Workspace kill switch and AI disclosure

**Priority** P0 (of Part A) · **Status** not started

**Story** As a customer, I want one switch that turns every AI feature off instantly, so that I
can react to a concern without waiting for us.

**Acceptance**

- [ ] **One control, in Settings, that disables every AI capability for the workspace
      immediately.** It is not behind a plan, a role or a confirmation dialog — a kill switch
      with friction is not a kill switch. It **is** audited and it **is** reversible.
- [ ] ⭐ **A global operator switch exists that we can throw** — a feature flag that disables all
      AI across all workspaces, takes effect on the next AI request, and requires no deploy. It
      is documented in the runbook and exercised at least once before V1, because an untested
      kill switch is a hypothesis.
- [ ] Effect is **immediate and complete**: no further egress to the AI provider, no further
      cost accrual, and no in-flight request is allowed to complete into a delivered message
      (F248's fallback applies to anything already in flight).
- [ ] The switch is **not** `delete`: consents, spend history and the provenance of past
      messages remain, so the delivery log stays truthful about what was sent. Turning AI back
      on **requires re-consent** if any allow-list or prompt version changed while off (F246).
- [ ] ⚠️ **A capability-level view exists per integration** — which capabilities are on, for
      which destinations, under which consent, and how much they have cost — because "is AI on?"
      must be answerable per integration, not just globally.
- [ ] **Disclosure is present wherever AI can be used**: the AI panel, the integration settings,
      and — once per workspace, dismissible — a line in the settings summary stating that AI is
      available, off by default, and what it would send. A customer should not discover the
      capability by reading a changelog.
- [ ] Every enable/disable is an `audit_events` row (F222): actor, capability scope, reason
      (optional free text), and the resulting state.
- [ ] **No AI state is presented without its disclosure.** A destination that received AI-labelled
      messages shows that fact in the integration's health summary for the retention window, so
      a user auditing "what did this channel receive" finds it.
- [ ] A customer **data-export includes the AI disclosure records** (F030): what was consented
      to, what was sent, what was generated, what it cost, and when.

**Design** — Two different switches for two different jobs, and conflating them is a real
mistake. The **workspace switch** is a customer's exercise of control and must be instant and
unconditional. The **operator switch** is our incident response and must be reachable when we
are the ones who noticed the problem — typically after a provider compromise or a discovered
egress bug — and must not require a deploy, because a deploy is the thing that is hardest to do
under pressure.

The rule that no in-flight request can complete into a delivered message is the subtle one. If
the switch only prevents *new* requests, a summary already being generated when the customer
pressed the button will land in their Slack channel with an AI label — after they asked for
nothing. Checking the flag again at delivery time, not only at enqueue time, closes that window.

**Schema**

```ts
type AiWorkspaceState = {
  kill_switch: boolean;          // org-level, immediate, audited
  capabilities: Record<AiCapability, { enabled: boolean;
    integrations: Array<{ integration_id: string; destinations: string[];
                          consent_prompt_version: string | null;
                          consent_fields_version: number | null;
                          spent_cents: number }> }>;
};
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Kill switch on, AI enqueued in flight | Checked again at delivery; deterministic message only |
| Kill switch on, provider call in flight | Response discarded; cost recorded as **not billed** |
| Re-enable after a prompt/field version change | Consents marked `needs_renewal`; AI stays off until renewed |
| Operator switch on | All workspaces off; each affected workspace's AI panel states why |

**Security** — The workspace switch is owner/admin-only (F024) and audited; the operator switch is
behind a Worker flag with change audit. Neither can be triggered by a member. Neither deletes
data, so neither is a data-deletion path and both leave the delivery log intact (F030).

**Tests**
- `kill_switch_disables_every_capability_immediately`
- `kill_switch_has_no_confirmation_dialog`
- `in_flight_ai_completes_into_no_delivered_message_after_the_switch`
- `operator_switch_takes_effect_without_a_deploy`
- `kill_switch_does_not_delete_consents_or_history`
- `re_enable_after_a_field_version_change_requires_re_consent`
- `every_ai_toggle_writes_an_audit_row`
- `export_includes_ai_consent_generation_and_cost_records`

**Deps** — F246, F247, F248, F222, F030, F024.

---

# PART B — The rest of the roadmap

## The billing finding, stated once, because it constrains everything

`docs/specs/COMPETITIVE-FEATURE-SET.md` records the research; `11-grouping-and-noise.md` restates
the conclusion; this file makes it binding:

> Knock and Courier bill on **notifications sent**. Knock states suppressed sends cost nothing
> (<https://knock.app/pricing>). **Novu bills on workflow *runs***, which means a digest that
> collapses 200 events into one message bills the customer for 200.

> Billing on triggers directly punishes exactly the deduplication and digest behaviour this
> domain exists to provide.

The same file records the general form of the mistake in Zapier: *"a Code by Zapier step using
extended runtime or an **AI by Zapier** step with tools may count as more than 1 task per run"*
(<https://help.zapier.com/hc/en-us/articles/8496291148685-View-and-manage-your-Zap-history>), and
that per-step billing is the **top pricing complaint** in that category
(<https://blog.n8n.io/free-zapier-alternatives> ⚠️ vendor blog). Zapier's own pricing complaint
is therefore a *warning about how AI steps get billed*, and it applies to F247 as much as it
does to a workflow engine.

**Therefore: we bill on messages sent. Always. There is no plan, tier or discount that bills on
events received, rules evaluated, or steps executed.**

---

## F253 — Usage metering on messages sent

**Priority** P2 · **Status** not started · **Mandated by `11-grouping-and-noise.md` as F233**

**Story** As a customer, I want to be charged for notifications I actually receive, so that
reducing my own noise reduces my bill instead of increasing it.

**Acceptance**

- [ ] ⭐ **The billable unit is exactly one delivered message.** The precise definition, fixed
      now and not renegotiable per plan:

```ts
// A billable message is a UNIQUE (dedup_key, destination_id) pair that was transmitted
// to its destination at least once and reached a terminal-or-better state.
type BillableUnit = {
  dedup_key: string;
  destination_id: string;
  counted_at: string;            // first successful transmission
};
```

- [ ] **Explicitly not billable**, each with a reason:

| Not billable | Why |
| --- | --- |
| Events received | Punishes high-traffic repos |
| Rules evaluated / matches found | Punishes broad filters |
| Retries of the same delivery | Punishes our own retry ladder (F177) and destination outages |
| Suppressed duplicates (F186) | Knock's position; suppressing *is* the product |
| Grouped events beyond the first (F141/F143) | The digest's entire value |
| Quiet-hours holds (F146) | A deferral, not a send |
| `dead_lettered` and `failed` deliveries | We did not deliver them; billing for them is billing for our failure |
| **Test deliveries** (F098) | Free, always, so setup costs nothing |
| **AI requests** (F247) | A separate meter; never folded in |

- [ ] ⭐ **Retries count once, ever.** A delivery that failed five times and succeeded on the
      fifth is **one** billable message. Charging per attempt would make our own reliability work
      a billable event and would create a perverse incentive to give up early.
- [ ] **Metering is derived from the delivery ledger** (F184), which is the only trustworthy
      source, and is computed by a **scheduled reconciliation job** plus a real-time counter for
      display. The counter is a cache; **the ledger is the truth**, and the two reconcile with an
      alert on divergence (the same "a job that silently stops looks exactly like a job with
      nothing to do" rule as F190).
- [ ] **Free and overage tiers are expressed in messages**, never in events or requests.
- [ ] The customer-facing usage view shows **messages sent, suppressed, and failed — with the
      suppressed count stated as a saving**, because in this product suppression is the feature
      and a bill that hides it teaches the wrong lesson.
- [ ] **Rate limits and quotas** (F022/F189) are also denominated in messages sent, with the
      distinction stated: a quota protects us, a bill pays for value.
- [ ] ⚠️ **Plan-gating core reliability features is forbidden.** Delivery log, dead letters,
      replay, test deliveries and retention are not behind a paywall. Plan-gating core features
      is a documented complaint theme in this category
      (<https://novu.co/comparison/courier> ⚠️ competitor-authored) and F255 is where enterprise
      gating is legitimate.
- [ ] **Disputes are answerable**: from any usage number, the customer can see the deliveries
      that compose it (F213) and export them (F257).
- [ ] **AI cost is a separate, opt-in line** with its own caps (F247), never an invisible
      multiplier on a message price.

**Design** — This feature is the commercial expression of the product's thesis, and getting it
wrong would make the product actively harmful to its own users: under trigger-based billing, a
customer who adopts our digest and grouping presets — the behaviour `docs/PRODUCT.md` and `11`
put at the centre of the product — watches their bill rise for sending fewer messages. That is
not a pricing detail; it is a design constraint on the billing model.

The second-order consequence is that **suppression becomes a visible, celebrated number**. If
the customer can see "14,200 events, 380 messages sent, 96% suppressed", the product's value is
demonstrated rather than asserted — and it is the most honest possible answer to "why do I pay
you".

**Schema**

```sql
CREATE TABLE usage_counters (                    -- derived cache; ledger is truth (F184)
  org_id        TEXT NOT NULL,
  period_start  INTEGER NOT NULL,
  messages_sent INTEGER NOT NULL DEFAULT 0,
  events_received INTEGER NOT NULL DEFAULT 0,   -- DISPLAY ONLY, never billed
  suppressed    INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  tests         INTEGER NOT NULL DEFAULT 0,
  reconciled_at INTEGER,
  PRIMARY KEY (org_id, period_start)
) WITHOUT ROWID;
-- billable invariant, asserted per period:
--   billable = COUNT(DISTINCT dedup_key, destination_id)
--              FROM deliveries
--              WHERE state IN ('delivered','accepted') AND test = 0;
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Counter and ledger diverge | Alert; reconcile from the ledger; never bill the counter |
| Reconciliation job stale | Surface staleness in the usage view; alert (F190) |
| Period boundary crossed mid-delivery | Billed in the period of `counted_at` (first successful transmission) |
| Negative adjustment / correction | An explicit `usage_adjustments` row, visible on the invoice, never a silent overwrite |

**Security** — Metering queries are tenant-scoped (F026). **Cross-tenant aggregation for our own
analytics is forbidden** on event content; only counts are ever aggregated, and only in an
explicitly internal, access-controlled store. Raw payloads are not part of metering and never
leave D1.

**Tests**
- `billable_unit_is_distinct_dedup_key_and_destination`
- `retries_of_one_delivery_count_once`
- `suppressed_duplicates_are_never_billed`
- `grouped_and_digest_items_are_billed_once_not_n_times`
- `failed_and_dead_lettered_deliveries_are_not_billed`
- `test_deliveries_are_free`
- `events_received_and_rules_evaluated_are_never_billed`
- `counter_and_ledger_reconciliation_alerts_on_divergence`
- `ai_spend_never_appears_in_the_message_meter`
- `delivery_log_features_are_not_plan_gated`

**Deps** — F184, F186, F141, F144, F146, F098, F190, F022.

---

## F254 — Billing and plans

**Priority** P2 · **Status** not started

**Story** As a customer, I want plans whose limits I can predict, so that I can choose without
talking to sales.

**Acceptance**

- [ ] ⚠️ **Gated on validated demand**, per `docs/PRODUCT.md`'s non-goals: *"marketplace, billing
      before validated demand."* This feature is **not authorised** until F226 has run, F262's
      gates have passed, and a specific demand signal exists. Designing the tiers before then
      optimises for a business that may not exist.
- [ ] **Every plan limit is in messages sent per month** (F253). No plan is priced in events,
      requests, seats × destinations, or "workflow runs".
- [ ] Plans gate **scale and governance**, never **reliability**: the delivery log, dead letters,
      replay, test deliveries and the honest duplicate surface are in every plan including free.
      A customer whose alerts silently stop because they did not upgrade is a support incident
      and a lost trust; Sentry's alert ceilings are documented as biting users hard
      (<https://docs.sentry.io/product/monitors-and-alerts/alerts/create-alerts/>).
- [ ] Candidate plan shape, ⚠️ **a proposal for the ADR, not a decision**:
      | Plan | Shape | Rationale |
      |---|---|---|
      | Free | Fixed message allowance, 1 workspace, GitHub → Slack/Lark/Teams | Enough to finish setup and prove value; setup must never be paywalled |
      | Pro | Higher allowance, more workspaces, grouping/digest/quiet hours, preferences | The features a team adopts once real traffic arrives |
      | Enterprise | SSO/SCIM, RBAC, audit export, data residency, support (F255–F258) | Governance, matching the documented enterprise gate in this category (<https://novu.co/comparison/courier> ⚠️ competitor-authored) |
- [ ] **Overage is opt-in and visible**, never a surprise: a hard cap by default, an explicit
      toggle for overage, and an alert at 80% and 100% of the allowance.
- [ ] **Self-serve, including downgrade and cancellation**, with data export first
      (F030). Cancel does not delete; it stops billing and tells the user exactly what they lose
      and for how long.
- [ ] **No dark patterns.** No pre-selected add-ons, no countdown timers, no "you will lose your
      history" pressure — because F185's honesty standard applies to billing copy too. The
      downgrade path shows the user what *breaks* (which limits revert, which features become
      unavailable) before they confirm.
- [ ] **Invoices show the same numbers the customer sees in the usage view**, line-item
      derived from the same ledger query. An invoice that cannot be reconciled against the
      dashboard is the fastest route to a dispute.
- [ ] Billing data is stored separately from event data, is tenant-scoped, and **never joins to
      raw event payloads** — billing needs counts, and a schema that makes a payload join
      possible is a liability (F030).
- [ ] ⚠️ **Payment provider choice is an ADR.** No provider is named in this file.

**Design** — The plans are a consequence of the reliability contract, not a revenue exercise.
Freezing the delivery log behind a paywall would mean a free-tier customer's notifications fail
silently and they have no way to find out — the precise scenario `AGENTS.md`'s dead-letter
requirements exist to prevent, and the reason those requirements are written as customer-visible
features rather than internal tooling.

The second decision, self-serve downgrade with a stated breakage list, is a direct consequence of
`docs/PRODUCT.md`'s audience #4: an agency/operator serving many customer workspaces will churn
accounts, and a cancellation flow that requires a phone call is a cancellation flow that does not
happen politely.

**Schema**

```ts
type PlanLimits = {
  messages_per_month: number;       // the ONLY metered quantity
  workspaces: number;
  seats: number;
  integrations: number;
  destinations_per_integration: number;
  event_retention_days: number;
  features: { grouping: boolean; digest: boolean; quiet_hours: boolean;
              ai: boolean; sso: boolean; scim: boolean; audit_export: boolean;
              data_residency: boolean };
  // reliability features are intentionally absent: never gated
};
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Limit reached | Cap enforced by F253's metering; overage only if explicitly enabled |
| Payment fails | A defined grace period stated up front; notifications **never stop silently** — the user is told, with the date |
| Downgrade would break a configuration | Blocked with a list of what must be removed first, or accepted with the breakage shown and confirmed |
| Cancellation | Stops billing; preserves data for a stated period; export offered |

**Security** — Billing identity, plan state and invoices are tenant-scoped and stored separately
from event data (F030). Plan enforcement is **server-side on every metered action**, never a
client-side flag. Billing webhooks are signature-verified against raw bytes, and an
unrecognised plan transition is refused rather than applied optimistically.

**Tests**
- `every_plan_limit_is_denominated_in_messages_sent`
- `reliability_features_are_absent_from_plan_gating`
- `downgrade_lists_what_breaks_before_it_is_confirmed`
- `cancellation_is_self_serve_and_preserves_data`
- `plan_enforcement_is_server_side_only`
- `invoice_reconciles_against_the_usage_view_query`
- `billing_webhook_signatures_are_verified_and_unknown_transitions_refused`
- `ai_cost_never_appears_as_a_message_multiplier`

**Deps** — F253, F030, F180, F185. **Authorised by** — demand evidence; see F262.

---

## F255 — Enterprise SSO and SCIM

**Priority** P2 · **Status** not started

**Story** As an IT administrator, I want my team to sign in with our identity provider and be
provisioned automatically, so that access is governed centrally.

**Acceptance**

- [ ] ⚠️ **Identity provider integration**: OIDC and/or SAML 2.0, at least two providers
      verified against real tenants before any claim. ⚠️ Better Auth ships an organisation/SSO
      plugin surface, but **its exact capabilities against the installed version `1.7.7` are
      unverified here** — same caveat the repo already records for `organizationLimit`
      (`00-current-state.md:N2`). Read the installed version's documentation before committing to
      a build-vs-buy here, and record it in an ADR.
- [ ] ⭐ **SSO must not weaken tenant isolation.** The IdP assertion resolves to a
      `(provider, issuer, subject)` tuple that maps to **one** membership. An assertion whose
      email matches an existing account does **not** silently grant access — email matching is a
      takeover vector, and a SAML assertion is only as trustworthy as its signature validation and
      audience/issuer checks.
- [ ] ⚠️ **Enforce SSO for the whole workspace**, so an IT admin can disable password sign-in
      once SSO is verified. A workspace with both password and SSO is two attack surfaces and the
      admin cannot turn the first one off — that is a governance failure, not a missing feature.
- [ ] **SCIM 2.0**: user create/update/deactivate and group push, with **deactivation removing
      access within a defined window** and, by default, **suspend rather than delete** — so a
      audit trail and delivery history survive a person leaving (F030/F222).
- [ ] ⭐ **Just-in-time provisioning is the default**: a new employee authenticated by the IdP
      gets a membership on first sign-in, subject to domain rules and seat limits. The
      alternative — admin-invite-only — is the friction this feature exists to remove.
- [ ] SCIM provisioning tokens are **secrets**: created once, stored hashed, scoped to one
      workspace, rotatable, and never displayed again. SCIM endpoints are tenant-scoped on every
      request and rate-limited.
- [ ] **Session behaviour follows the IdP**: sign-out at the IdP ends our session; session
      lifetime is IdP-configurable. This is the behaviour enterprise users expect and its absence
      is a common SSO complaint.
- [ ] Role mapping from IdP groups to `owner` / `admin` / `member` is declarative and auditable,
      and a mapping change is an `audit_events` row (F222).
- [ ] **The last-admin invariant still holds** under SCIM deprovisioning: a workspace cannot be
      left with zero admins, and SCIM deactivation that would do so is refused with an
      explanation rather than applied.
- [ ] ⚠️ **Enterprise features are gated, not hidden** — a workspace without SSO shows it as an
      available plan feature, not as a mystery.

**Design** — The design risk is not authentication, it is **account linking**. Every
enterprise-identity bug we would plausibly ship comes from trusting an email address to mean the
same person across two systems. Hence the rule: an IdP subject tuple maps to a membership by
*identity provider linkage*, established once by an admin action; email is a display attribute.
Everything else — silent auto-linking on matching email — is a takeover vector regardless of how
good the IdP's signature is.

Second decision: **enforced SSO, not optional SSO.** A workspace that can be configured for both
is one where the strongest control is always the optional one.

**Schema**

```ts
type IdpLink = {
  org_id: string;
  provider: 'oidc' | 'saml';
  issuer: string;                 // exact match, not a suffix match
  subject: string;                // (issuer, subject) is the immutable identity key
  user_id: string;                // our user, linked by an explicit admin action
  linked_at: string; linked_by: string;
};
// An incoming assertion resolves ONLY via this table. Email is never the join key.
type ScimProvision = {
  external_id: string; org_id: string;
  active: boolean;                // deactivation -> suspend, not delete
  group_map: Record<string, WorkspaceRole>;
  last_seen_at: string;
};
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Assertion with unknown `(issuer, subject)` | JIT-provision if domain rules allow; otherwise refuse with a named message |
| Assertion whose email matches an existing password account | ⚠️ **Never auto-links.** Prompt the user to link, and require an authenticated existing session |
| IdP unavailable | Existing sessions continue; new sign-ins fail with *"Your identity provider is not responding."* — never a fallback to password |
| SCIM deactivation would remove the last admin | Refused, with the conflicting member named |
| SCIM push fails | Retained and reported to the IdP; access is not revoked on a partial failure |

**Security** — SAML assertions are signature-validated against the IdP's certificate with
explicit issuer, audience, `NotBefore`/`NotOnOrAfter` and replay-window checks, and XML is
parsed **without** entity expansion (XXE). OIDC uses PKCE and state/nonce. SCIM bearer tokens are
hashed at rest, single-workspace, and every SCIM request is tenant-scoped and audited. **Email
is never an identity key** (F024/F025).

**Tests**
- `email_matching_never_auto_links_an_idp_assertion`
- `identity_resolves_only_through_issuer_and_subject`
- `sso_can_be_enforced_and_password_sign_in_can_be_disabled`
- `saml_assertions_reject_bad_signature_audience_and_expired_notonordafter`
- `saml_xml_is_parsed_without_entity_expansion`
- `scim_deactivation_suspends_and_does_not_delete`
- `scim_tokens_are_hashed_scoped_and_never_re_displayed`
- `last_admin_invariant_holds_under_scim_deprovisioning`
- `idp_outage_never_falls_back_to_password`

**Deps** — F024, F025, F030, F222, F205, F254.

---

## F256 — Advanced RBAC

**Priority** P2 · **Status** not started

**Story** As an IT administrator, I want fine-grained roles, so that a person can send
notifications without being able to read everyone's or delete a workspace.

**Acceptance**

- [ ] **V1's `owner` / `admin` / `member` (F024) is the floor, not the ceiling.** F182 already
      requires a `replay` capability distinct from membership, which is the seed of the real
      model: a **capability** set, not a role hierarchy.
- [ ] Capabilities are declared, not implied:

```ts
type Capability =
  | 'integration:create' | 'integration:update' | 'integration:delete' | 'integration:read'
  | 'credential:write'          // replacing a destination secret — highest-risk mutation
  | 'replay'                    // F182: re-sends content the user may have retracted
  | 'dead_letter:read'
  | 'export:generate'           // F257: leaves the tenant boundary
  | 'audit:read'                // F222: sees who did what
  | 'member:invite' | 'member:remove' | 'role:change'
  | 'workspace:delete'          // F030
  | 'ai:enable' | 'ai:budget'   // F246/F247
  | 'billing:manage' | 'plan:change';
```

- [ ] ⭐ **`credential:write` and `export:generate` are separated from `integration:update`** by
      default. Someone who can route notifications into a Slack channel can exfiltrate repository
      content into a channel they control; that is a privilege, not a convenience, and the role
      model should say so.
- [ ] Roles map to capability sets in **data**, versioned and additive, so a new capability
      defaults to **not granted** rather than to granted (F155's additivity rule applied to
      permissions — the same failure mode: a shipped preset silently changing under a customer).
- [ ] **Custom roles** for enterprise, with a guardrail set that cannot be edited: a role can
      never hold both `member:remove` and no `integration:read`; the `owner` capability set
      cannot be reduced below the last-admin invariant.
- [ ] **Deny wins**: an explicit deny is never overridden by a role grant.
- [ ] Every capability check is **server-side, on every request**, at the data-access layer and
      not only in the route (F026). A missing check in one query is a cross-tenant read, and
      F222's existence is the audit that this did not happen.
- [ ] The **UI mirrors capabilities exactly**: a control the user cannot perform is hidden or
      disabled **with the reason** (F211/F217), so "why can't I do this?" is answerable without
      a support ticket.
- [ ] **Every privileged mutation is audited** (F222) with the actor and the capability used.
- [ ] "Access as another user" / impersonation is **not offered**. If it is ever offered, it is
      time-boxed, bannered, recorded in the audit trail, and visible to the impersonated user —
      and until it can do all of that, it is not built.
- [ ] ⚠️ **No capability implies access to another tenant.** RBAC is *within* a workspace; tenant
      scoping is a separate, non-optional predicate (D2). A role can never grant cross-workspace
      access, and a test asserts that no capability value can express it.

**Design** — The capability-over-role decision is what makes this forward-compatible, and it
comes straight from F182: *"Requires `replay` capability — not available to every member."*
Once one feature needs a capability finer than "member", the model is already a capability model,
and pretending otherwise means migrating later under customer pressure.

The default-deny-on-new-capability rule is the same discipline as F155's additive presets, for
the same reason: a permission that appears in a new release and is granted by default is a
security regression shipped as a convenience.

**Schema**

```ts
type Capability =                        // closed; a new value defaults to NOT granted
  | 'integration:create' | 'integration:update' | 'integration:delete' | 'integration:read'
  | 'credential:write' | 'replay' | 'dead_letter:read' | 'export:generate' | 'audit:read'
  | 'member:invite' | 'member:remove' | 'role:change'
  | 'workspace:delete' | 'ai:enable' | 'ai:budget' | 'billing:manage';

// Roles are DATA, versioned and additive (F155's rule applied to permissions).
type Role = {
  version: number;
  grants: Capability[];
  denies:  Capability[];                // deny always wins
  system: boolean;                      // owner/admin/member - guardrails not editable
  guardrails: readonly Guardrail[];     // cannot be removed from a system role
};
type Guardrail =
  | 'owner_cannot_lose_workspace_delete'
  | 'last_admin_must_retain_member_manage'
  | 'no_capability_crosses_workspace_boundary';   // D2, non-negotiable
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Capability check missing at the data layer | A test enumerates capabilities × tables and fails on an unscoped query |
| New capability added without a role mapping | Defaults to not granted; a build check requires an explicit decision |
| Role edit would violate a guardrail | Rejected with the guardrail named |
| User lacks capability | 403 with `error_code`; the UI hides the control |

**Security** — Capability checks are enforced in the query layer, tenant-scoped first and
capability second, so a missing capability check can never become a cross-tenant read (D2).
Capability evaluation is server-side only; the client is not trusted to hide a control.
`credential:write` is separated from `integration:update`; `export:generate` is audited as a
boundary crossing.

**Tests**
- `capability_is_checked_on_every_mutation_server_side`
- `new_capabilities_default_to_not_granted`
- `credential_write_is_separate_from_integration_update`
- `deny_overrides_grant`
- `no_capability_can_express_cross_workspace_access`
- `role_edits_cannot_violate_the_guardrail_set`
- `last_admin_invariant_is_preserved_by_every_role_set`
- `every_privileged_mutation_is_audited_with_the_capability_used`
- `ui_visibility_matches_server_capability_checks`

**Deps** — F024, F026, F155, F182, F222, F217, F254.

---

## F257 — Audit export

**Priority** P2 · **Status** not started

**Story** As an IT administrator, I want to send our audit log to our compliance system, so that
I don't have to check a browser tab to prove who changed what.

**Acceptance**

- [ ] **The export is the audit trail** (F222), not a re-invention of it. Formats: **JSONL**
      (streaming, stable schema, best for SIEM ingest) and **CSV** (human and spreadsheet).
      Both from the same query.
- [ ] A **stable, versioned schema** with a documented `schema_version` per record, so a SIEM
      parser does not break on a release. Additive-only within a major version (F155's rule).
- [ ] ⭐ **Secrets are structurally absent, not filtered at render time.** The export queries a
      projection that has no secret column — the writer already replaces them with `"changed"`
      (F222), and the export selects only the audit columns. A redactor in the export path is a
      leak waiting for a new column.
- [ ] Filters mirror the UI exactly (actor, action, target, time range), so what an admin exports
      is what they were looking at.
- [ ] **Streaming and bounded.** Large exports run as a scheduled job with a **signed, expiring
      URL** and a declared expiry, not as an in-request download. An audit export is a bulk data
      egress path and must be treated as one.
- [ ] `export:generate` is a **separate capability** (F256), audited, rate-limited, and
      notification-generating: an export is sent to the workspace's security contacts.
- [ ] **The export contains no event payloads.** It is a log of configuration and access actions.
      A customer who wants event data exports events (F030), on a separate path, with its own
      capability — mixing them would make an audit export a data-exfiltration primitive.
- [ ] Retention of the export artefact follows the shorter of the signed-URL TTL and the
      workspace retention policy; deletion is verified by a test (F030).
- [ ] ⚠️ **A public status/SLI surface is a different feature** and is not bundled here. A
      public delivery-rate page is a trust signal
      (`docs/specs/COMPETITIVE-FEATURE-SET.md`, Courier provider metrics) but it exposes
      **aggregate** data only and needs its own spec.

**Design** — Two structural decisions, both about keeping an audit path from becoming an
exfiltration path. First, the export reads a projection with no secret column, so "we redact on
the way out" is never a line of code someone can forget. Second, the audit export and the data
export are **separate features with separate capabilities**: an audit log is about
configuration and access, an event export is about repository content, and a system that merges
them lets anyone with "export the logs" read everyone's issue history.

**Schema**

```ts
type AuditExportRecord = {
  schema_version: '1';
  id: string; org_id: string;
  actor_type: 'user'|'system'|'installation'|'api_key';
  actor_label: string; actor_id: string | null;
  action: string; target_type: string; target_id: string | null; target_label: string | null;
  diff: Record<string, { from: string | null; to: string | null } | 'changed'> | null;
  correlation_id: string | null; occurred_at: string;
};
// 'changed' is a union member, not a filtered string: secrets are unrepresentable in diff values.
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Export too large | Async job; signed URL with stated expiry; user notified |
| Signed URL expired | Clear message; re-run the export |
| Export without the capability | 403; the UI never offered it |
| SIEM rejects the schema | `schema_version` bump; a documented migration note |

**Security** — Capability-gated (F256), audited, rate-limited. The signed URL is scoped to one
artefact, short-lived, single-tenant. Artefacts are stored encrypted and deleted on expiry with a
test. The projection contains no secret and no event payload.

**Tests**
- `audit_export_schema_is_versioned_and_stable`
- `export_contains_no_secret_value_and_no_event_payload`
- `export_reads_a_projection_with_no_secret_column`
- `large_exports_are_async_with_an_expiring_signed_url`
- `export_requires_the_export_capability_and_is_audited`
- `signed_url_is_single_artefact_scoped_and_short_lived`
- `artefact_deletion_on_expiry_is_verified_by_a_test`

**Deps** — F222, F256, F030, F026.

---

## F258 — Data residency

**Priority** P2 · **Status** not started

**Story** As a customer with a data-residency obligation, I want to know where my data is and
whether I can choose, so that I can answer my own compliance questions.

**Acceptance** — the honest position first: **this is not a checkbox feature.** Residency is a
deployment-topology decision, and the decision must be made before the product claims it.

- [ ] ⚠️ **State the actual constraint today.** The product runs on Workers + D1 + Queues.
      ⚠️ D1 supports regional placement options and I have **not verified the current list or
      semantics of those locations against Cloudflare's documentation in this pass** — treat the
      specifics as unknown and read them before this feature is designed. The architectural point
      stands regardless: a D1 database is created in a region, and **a data-residency claim means
      every store holding customer content lives in that region** — D1, Queues (including
      dead-letter retention, F180), Durable Objects if used, and any log sink.
- [ ] Two honest options, and the recommendation is **defer**:

| Option | Shape | Cost |
| --- | --- |---|
| **A — Defer and be honest** | Do not offer residency. State plainly where data is stored, disclose the sub-processors, and let customers with an obligation self-host or decline | Zero. Honest. Leaves an enterprise segment unserved |
| **B — Regional deployments** | Separate D1 database + Queue + Worker per region, with an explicit workspace→region binding at creation and a real routing layer | Every migration, every feature, every incident response, every CI run is multiplied by region count. A cross-region support question becomes an architecture project |

- [ ] ⭐ **F261/roadmap discipline: while this is not built, the UI says so honestly** — the
      setting exists and reads *"Your workspace is stored in <named region>. Region selection is
      not available; contact us if you have a residency requirement."* It is **not** a
      disabled dropdown with no explanation (F206's rule: a dead affordance is a broken promise).
- [ ] **Every sub-processor is disclosed**, with what data and in what region: providers for
      destinations, email, error tracking, and — if enabled — **the AI provider** (F246). This is
      necessary regardless of which option is chosen, and it is the thing enterprise buyers
      actually ask for first.
- [ ] **Backups and exports inherit the region.** A data export (F030) leaves the region when the
      customer downloads it, and the UI says so. Retention purges (F051/F192) run **per region**
      and are verifiable.
- [ ] **If B is chosen**, an additional hard rule: **a workspace's region is immutable after
      creation**, and migration between regions is a deliberate, audited, customer-initiated
      operation with a stated downtime — never an automatic side effect of a load balancer.
- [ ] Residency is listed as **enterprise-gated** (F254/F255) in this category
      (<https://novu.co/comparison/courier> ⚠️ competitor-authored), which is evidence that
      customers will pay for it — and also that it is a procurement checkbox, not a product
      differentiator.

**Design** — The honest recommendation is Option A: defer, disclose, and do not build a
multi-region estate for a product whose V1 thesis is a non-technical user completing setup in
five minutes. Multi-region is not a switch; it is a permanent multiplication of every operational
and engineering task, taken on by a two-person team with a Workers/D1/Queues stack that is not
yet multi-tenant (D2).

The disclosure half of this feature — naming the region and the sub-processors — should ship
**regardless of the decision**, because it is free, it is the first question enterprise security
teams ask, and shipping it early is a trust signal that costs one page.

**Schema**

```ts
type ResidencyDisclosure = {
  primary_region: string;              // named, not a flag
  stores: Array<{ name: string; region: string; contents: string[] }>;
  sub_processors: Array<{ name: string; purpose: string; region: string | null;
                          data: string[] }>;   // includes the AI provider when enabled
  selectable: false;                    // explicit, so the UI never fakes a dropdown
  export_leaves_region: true;
};
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| A new sub-processor is added | ⭐ **Fails a build/CI check** unless the disclosure record is updated. An undisclosed processor is a compliance incident, not a config change |
| Region of a store is unknown | Disclosure is incomplete and the feature is flagged as not-met; no "unknown" reaches a customer page |
| Export generated | UI states that the downloaded file left the region |

**Security** — Residency claims are **verified, not asserted**: a test asserts every store that
writes customer content appears in the disclosure with a region, and a change to the binding set
fails CI. A residency badge in a sales deck without that test is a marketing claim with no
engineering behind it — `AGENTS.md` bans exactly this.

**Tests**
- `every_store_writing_customer_content_is_in_the_disclosure_with_a_region`
- `adding_a_sub_processor_without_disclosure_fails_ci`
- `ui_states_region_and_does_not_render_a_disabled_selector`
- `exports_are_disclosed_as_leaving_the_region`
- `retention_purge_runs_and_is_verifiable_per_region`
- `no_residency_claim_is_published_without_the_verification_test`

**Deps** — F030, F051, F246, F254, F255. **Blocked by** — a verified read of Cloudflare's
current D1/Queues regional capabilities.

---

## F259 — Connector marketplace

**Priority** P2 · **Status** not started · **Explicitly forbidden in V1**

**Story** As a customer, I want to add a source or destination that someone else has already
built, so that I am not limited to the official catalogue.

**Acceptance** — `docs/PRODUCT.md` lists **marketplace** under **Non-goals**, and
`00-current-state.md` §5 states the rule that governs it: *"Do not add a second source before
tenancy exists. Every new source multiplies D2."* This feature records the position so it cannot
be entered accidentally.

- [ ] ⭐ **V1 prohibition, stated as a product constraint not an omission:** there is no
      third-party connector, no community source, and no self-published destination. The
      Integrations catalogue shows only connectors **we** ship and verify (F206).
- [ ] �️ **Community connectors would be third-party code on our delivery path**, which
      `AGENTS.md` forbids in the strongest available terms ("no arbitrary code execution") and
      which the competitive research independently identifies as the category's most
      complained-about surface: Zapier's Code steps have no first-party troubleshooting
      (<https://help.zapier.com/hc/en-us/articles/8496037690637-How-to-troubleshoot-errors-in-Zap-workflows>)
      and n8n's self-hosted Code nodes with npm and filesystem access are named as the ops burden
      reviewers describe (<https://zapier.com/blog/n8n-vs-zapier> ⚠️ vendor blog).
- [ ] **If a future version permits it**, the non-negotiable preconditions, all of which must
      exist first:
      1. Tenant isolation closed and audited — **D2** (currently the largest gap in the repo).
      2. A **connector contract conformance suite** (F071) that a third party can run without
         reading our internals.
      3. An outbound-network policy per connector, because a connector that can fetch anything is
         an SSRF primitive (F102).
      4. Credential storage and rotation owned by us, never by the connector (F097).
      5. A review and publishing process with a named reviewer, because *"definition of done for
         a connector"* (`AGENTS.md`: real-provider acceptance evidence, fixture tests, redaction)
         is a **process**, and it is the process — not the code — that makes a connector
         trustworthy.
      6. **No model-supplied connectors, ever.** Nothing in F243–F252 may create, generate or
         install a connector. A marketplace plus a model is an unreviewed code-execution
         pipeline wearing a product feature.
- [ ] **What we do instead**, and it is the actual answer to the demand: a **documented,
      versioned export of a workspace's routing configuration** plus a **generic signed inbound
      webhook source** (the `ROADMAP.md` P2 item), so a customer who needs an unsupported system
      can connect it **without** trusting anyone's code. That is the non-code-extension path, and
      it is preferable to a marketplace on every axis: no third-party code, full logging, one
      security model.
- [ ] A marketplace is **not** on the roadmap ahead of F255–F258. `docs/ROADMAP.md` P3 orders it
      after the expansion connectors, and this file keeps it there.

**Design** — The marketplace is the standard way this category grows, and it is the standard way
this category ends up with unreviewed code executing against customer credentials. Our answer is
that the demand behind a marketplace is *"connect a system we have not built yet"* — and that
demand is better served by a generic signed webhook with a documented mapping contract, which
gives the customer a first-party path with our logging, our retries and our dead-letter
inspection intact.

**Schema** — none. There is no marketplace table, no `connector_version` registry and no
third-party sandbox. Naming these here is deliberate: an unused schema is an invitation.

**Errors**

| Condition | Behaviour |
| --- | --- |
| A request to publish a third-party connector | Refused with the reasoning and the generic-webhook alternative. Not queued for "later" |
| A model proposes a connector | Rejected at F249/F250's output layer — the capability does not exist to express it |

**Security** — The prohibition is the control. A connector executes with access to decrypted
destination credentials and tenant event data; running unreviewed third-party code there
contradicts `AGENTS.md` and `docs/SECURITY.md`'s threat model directly.

**Tests**
- `no_third_party_connector_type_exists_in_the_schema_or_registry`
- `no_code_execution_surface_exists_for_connectors`
- `ai_cannot_generate_or_install_a_connector`
- `catalog_lists_only_verified_first_party_connectors`
- `refusal_of_a_marketplace_request_names_the_generic_webhook_alternative`

**Deps** — F071, F097, F102, F243. **Blocked by** — D2 (tenant isolation).

---

## F260 — Public API

**Priority** P2 · **Status** not started

**Story** As a developer at a customer company, I want to manage notifications through an API,
so that I can automate what the dashboard does.

**Acceptance**

- [ ] ⚠️ **Not in V1**, and gated on F226 and F262 like F254. V1's setup flow is manual and
      wizard-driven by design (`docs/PRODUCT.md`'s non-technical wedge); an API is a convenience
      for users who are explicitly *not* the target audience. It ships when the wizard is proven,
      not before.
- [ ] **Scoped API keys**, never user passwords. A key is: hashed at rest, scoped to an explicit
      capability list (F256), bound to **one workspace**, rotatable, revocable, with an expiry.
      A leaked key is a bounded problem; a leaked password is not.
- [ ] ⭐ **Every key action is audited** (F222) with the key's identity as the actor — so an
      integration's behaviour is always attributable to a named credential, not to "the system".
- [ ] **Rate limits per key**, with published limits, `429` with `Retry-After` (RFC 9110 §10.3),
      and headers that let a client self-throttle. Limits are enforced in the same
      reservation discipline as F247's budget — a limit that can be exceeded by concurrency is a
      limit that does not exist.
- [ ] **Versioned from day one** (`Accept-Version` or path segment), with a documented
      deprecation policy and a minimum supported window. A breaking change on release day is not a
      version.
- [ ] The API is a **projection of the same domain model** the dashboard uses. There is no
      "API mode" configuration: the API cannot create a state the UI cannot, and vice versa.
- [ ] **Inbound is where the product already is**: `POST /v1/webhooks/github` is documented, and
      signature verification is documented for anyone self-hosting a receiver. This is the honest
      "public API" for a product whose source is webhooks, and it ships with the product.
- [ ] ⚠️ **Explicit non-features**, matching `AGENTS.md`: no arbitrary code execution, no
      bidirectional sync, no unrestricted workflow graphs (F167), no user-authored routing DSL.
      The API exposes a closed event catalog (F042), a closed filter grammar (F161), and a
      closed destination list — **the same constraints the UI has**. An API that can express more
      than the UI is how a product grows a support burden it cannot serve.
- [ ] **Documented, tested, and generated from the implementation** — the OpenAPI document is
      produced from the same types the router uses, so it cannot drift. Doc examples are executed
      as tests.
- [ ] Error responses use F013's taxonomy with F220's plain-language messages, so an API client
      and a UI user get the same explanation.
- [ ] No rate-limit or error response ever contains a credential or a webhook URL (F012).

**Design** — The scope question is "is the API for the target user?" The answer is no, which is
why it is post-V1: our non-technical user will never call this API, and building it early means
building and supporting a surface for someone else while the wizard is still being fixed.

The one API-shaped thing that **does** ship with V1 is the inbound webhook endpoint, because that
is the product's input contract and documenting it is part of `AGENTS.md`'s "use official API
documentation". The split is deliberate: we publish the interface we must keep stable (ingress)
and defer the interface we would use to automate ourselves (control).

**Schema**

```ts
type ApiKey = {
  id: string; org_id: string;
  key_hash: string;              // never stored or returned in plaintext
  prefix: string;                // display prefix only: 'ln_live_a1b2…'
  capabilities: Capability[];    // F256
  expires_at: string | null; last_used_at: string | null;
};
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Expired or revoked key | 401 with the plain-language message; never a 500 |
| Capability not granted to the key | 403 naming the missing capability |
| Rate limit exceeded | 429 with `Retry-After` (RFC 9110 §10.3) |
| Unknown API version | 400 naming the supported versions |
| Request exceeding the ingress cap (D15) | 413 with the documented cap, not a silent truncation |

**Security** — Keys are hashed at rest, shown once at creation, scoped to one workspace and an
explicit capability list. Every request is tenant-scoped first (D2) and capability-checked
second. Ingress retains signature verification against raw bytes (F058) and a documented content
cap. No error body, log line or rate-limit header contains a secret (F012).

**Tests**
- `api_keys_are_hashed_scoped_expired_and_rotatable`
- `every_key_action_is_audited_with_the_key_as_actor`
- `rate_limits_are_enforced_under_concurrency_with_retry_after`
- `api_and_ui_cannot_express_different_configurations`
- `openapi_document_is_generated_from_router_types_and_drift_fails_ci`
- `doc_examples_are_executed_as_tests`
- `api_cannot_express_a_capability_the_ui_cannot`
- `no_response_contains_a_credential_or_webhook_url`

**Deps** — F256, F222, F013, F220, F058, F012, F042. **Authorised by** — F226 + F262.

---

## F261 — Connector expansion evidence gate

**Priority** P2 · **Status** not started

**Story** As a maintainer, I want each new connector justified by evidence, so that the
catalogue grows only where it is wanted.

**Acceptance**

- [ ] `docs/ROADMAP.md` P3 names the order: **GitLab, Sentry, Stripe, Cloudflare; then
      Discord/Telegram/email.** This feature defines the gate each one must pass, and states
      which of them is expected to be demanded by whom.
- [ ] ⭐ **No second source before tenant isolation is closed and audited** — `00-current-state.md`
      §5, verbatim in intent: *"Do not add a second source before tenancy exists. Every new
      source multiplies D2."* **D2 is currently open.** Every new source multiplies the surface
      of: signature verification, tenant binding, per-source credential lookup, repository
      selection, payload normalisation, rate limits, reconciliation and the delivery path. That
      is not a cost estimate; it is a list.
- [ ] ⭐ **The stop/continue gate applies to the catalogue too**, not only to V1 (F262): if the
      F226 study misses 8/10, `docs/ROADMAP.md` says to *"improve onboarding/reliability instead
      of expanding catalog."* **That is binding on this feature.** A missed gate does not get
      re-litigated by adding an integration.
- [ ] **Evidence threshold per connector**, all required:
      | Evidence | Form |
      |---|---|
      | Demand | ≥5 workspaces asking, or one contractually committed account. Recorded with names and dates |
      | Provider verification | Official API documentation read and cited, with the date. No memory, no blogs |
      | Fixture suite | Real captured payloads per event type (F072), including edge and malformed cases |
      | Real-tenant acceptance | A real provider account, a real event, a real delivery — with evidence, per `AGENTS.md`'s "definition of done for a connector" |
      | Failures understood | The provider's documented error surface mapped onto F013, including the permanent-failure cases |
      | Rollback rehearsal | Documented, because `AGENTS.md` requires it before a "production-ready" label |
- [ ] **Ordering rationale, recorded so it is not re-litigated**: GitLab first (same mental
      model as GitHub, same CI/MR vocabulary, cheapest after GitHub); Sentry next (demand-
      validated incident alerting, and it is a **second-class event source** — issues and alerts
      are genuinely different, which tests the F041 envelope); Stripe next (high business
      consequence, high volume, and it forces the volume/retention story); Cloudflare last in
      the first wave (it is adjacent to our own runtime and its event semantics are the least
      conventional). **Destinations follow sources**, per `AGENTS.md`'s wedge, and Discord/Telegram/
      email only on demonstrated demand — Telegram is last, because
      `docs/DESTINATION_API_REFERENCE.md` §5 records it as the worst multi-tenant case (a bot
      token belongs to one bot owner; SaaS delivery requires a **Bot API Enterprise**
      relationship, not a per-customer token).
- [ ] **One connector at a time**, reviewed end-to-end, before the next begins. `AGENTS.md`:
      *"Make changes in coherent small units."*
- [ ] Each connector ships with **setup instructions verified against the real provider UI**
      (F212's capture contract), or it ships with an honest gap that says so.
- [ ] ⚠️ **"Planned" is never shown as selectable** (F206). Until a connector passes the gate it
      does not appear in the catalogue — not as a card, not as a badge.

**Design** — The competitor research is explicit that breadth is not the moat: on Zapier, *"the
'easy thing to code up'… I don't think it does even have a moat"*
(<https://news.ycombinator.com/item?id=21743609> — ⚠️ HN comment, opinion), and the same file
records that the complaints about the big platforms are about **onboarding friction and
trust**, not about connector count. The category's differentiators are setups that work and
failures that are honest — both of which are harder than a 40th integration.

The per-connector cost is also higher than it looks, because `AGENTS.md`'s definition of done
includes real-provider acceptance evidence. A connector without a real tenant is not 80% done;
it is 50% done and shipping the remaining 50% is what produces "integrations that look supported
and aren't".

**Schema** — none. This feature is a gate, not a capability. Naming a `connector_registry` here
would be premature: the registry exists once a connector passes, and the only thing this file
authorises is the checklist.

**Errors**

| Condition | Behaviour |
| --- | --- |
| Connector requested without demand evidence | Deferred with the evidence requirement stated |
| D2 still open | **Blocked.** No second source |
| Study gate missed | Catalog expansion does not begin (F262) |
| Connector lacks a real-tenant run | Shipped behind honest labelling at most; **never** claimed as supported |
| Provider API changes under a shipped connector | F071's fixture suite fails; the connector is flagged for re-verification |

**Security** — Each connector re-opens the full trust boundary: an unverified signature, a
tenant-binding gap or a routing decision taken from a body field is a cross-tenant event. The
gate requires fixture tests and a real tenant **before** the connector is listed, because the
catalogue is the product's trust surface and a broken entry is worse than a missing one.

**Tests**
- `no_second_source_is_built_while_tenant_isolation_is_open`
- `catalog_gate_rejects_a_connector_without_demand_evidence`
- `connector_is_not_listed_without_fixture_tests_and_a_real_tenant_run`
- `each_connector_maps_its_provider_error_surface_onto_the_taxonomy`
- `catalog_shows_only_connectors_that_passed_the_gate`
- `one_connector_is_in_flight_at_a_time`

**Deps** — F071, F072, F058, F061, F067, F226, F262, **D2**.

---

## F262 — Stop and continue gates

**Priority** P0 · **Status** not started · **This feature governs the roadmap it sits in**

**Story** As a maintainer, I want the roadmap decided by evidence rather than by enthusiasm, so
that we do not build the wrong thing confidently.

**Acceptance**

- [ ] ⭐ **`docs/ROADMAP.md`'s gate is quoted, and is binding:**

  > Proceed from P1 only if a real signed webhook reliably reaches a real destination and at
  > least **8/10** target users can set it up without engineering help. Otherwise improve
  > onboarding/reliability instead of expanding catalog.

  **Two conditions, both required.** Condition 1 is an engineering fact and is verified in
  staging with a real signed webhook and a real destination. Condition 2 is F226.
- [ ] Gate outcomes are exactly three, and **there is no "proceed with caveats"**:

| Outcome | Condition | Consequence |
| --- | --- | --- |
| **Continue** | Both conditions met | P2 begins; the catalog gate (F261) opens |
| **Improve** | Either condition unmet | Work returns to onboarding (14) and reliability (12). **No new connectors** |
| **Stop** | The product is not achieving value for its target user after two Improve cycles | The honest option, and it is written down in advance so that taking it is not a defeat |

- [ ] ⚠️ **The gate is decided on evidence recorded in the repository**, not on a calendar date
      and not on a launch announcement. The decision is a `docs/adr/` entry naming the evidence,
      the date and the people who checked it. There is no "P2 is starting" without one.
- [ ] **Additional gates** this file defines, each with its evidence:

| Gate | Evidence required | Blocks |
| --- | --- | --- |
| **G1 — Tenant isolation** | `workspace_id` on every table, every query tenant-scoped, D2 and D3 closed and reviewed | Public signups, any second source, any API key, any marketplace |
| **G2 — Honest delivery** | F184 ledger complete, F180 DLQ with a live consumer, terminal states, F185's duplicate surface shipped | Any "reliable" claim in marketing |
| **G3 — Customer-visible failure** | F181 inspection + F182 replay usable by a non-admin | Enterprise conversations (F255+) |
| **G4 — Onboarding proven** | F226 run, ≥8/10, friction log acted on | Catalog expansion, billing |
| **G5 — Connector honesty** | F212 captures verified; no fake screenshots; no `Planned` affordances | Any public catalogue listing |
| **G6 — AI precondition** | F243–F252 fully implemented, injection corpus green, kill switch exercised, budget tested | Enabling AI for any customer |
| **G7 — Billing correctness** | F253's billable invariant tested; invoice reconciles against the usage view | Charging anyone |

- [ ] ⭐ **G6 is deliberately placed *before* the AI feature is enabled for a customer**, and the
      precondition includes the two hardest items: the injection corpus (F249) and the kill
      switch having been **exercised at least once** (F252). An untested kill switch is not a
      control.
- [ ] **Every gate is a checklist with a named verifier and a date**, stored in `docs/adr/`.
  "Believed to be done" is not a gate state.
- [ ] ⭐ **The gates constrain this file too.** F254 (billing), F255–F258 (enterprise), F259
      (marketplace), F260 (API) and F261 (connectors) are all **behind** G1/G4 and none may be
      started early because they are interesting. "Post-V1" in this file means *after the
      gates*, not *when we get to it*.
- [ ] **A gate cannot be waived by an author of this repository.** If a gate must be bypassed,
      that decision is a `docs/adr/` entry signed by a named person, stating what risk is being
      accepted and what the rollback is. `AGENTS.md`'s release rule is the model: don't describe
      a feature as production-ready until it has passed real-provider end-to-end validation,
      tenant isolation and secret-handling review, and a rollback rehearsal.
- [ ] **Blocked work is visible**, not silently paused: an open gate names who is working on it
      and what evidence is outstanding.

**Design** — Gates exist because the failure mode of an evidence-led roadmap is that "evidence"
gets defined after the decision has already been made by momentum. Writing the outcome options
down in advance — including **stop** — is the only part with real force. An "Improve" outcome
that silently means "carry on next quarter" is not a gate.

The placement of G1 is the important structural choice. Every feature in Part B depends on tenant
isolation, which `00-current-state.md` identifies as *"the single largest distance between the
code and a shippable product"* and which Better Auth did **not** close (it scoped its own tables;
`integrations`, `deliveries` and `notification_outbox` still have no tenancy column). Gating the
entire back half on it is the cheapest possible protection, and it costs nothing while G1 is open
because that work has to happen anyway.

**Schema**

```ts
type GateState = {
  gate: 'G1'|'G2'|'G3'|'G4'|'G5'|'G6'|'G7';
  state: 'open' | 'met' | 'waived' | 'blocked';
  evidence: string[];            // links to docs/adr entries, test names, staging runs
  verified_by: string; verified_at: string;
  waiver?: { by: string; accepted_risk: string; rollback: string };
};
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Work starts on a gated feature while its gate is open | Blocked in review; no exception for urgency |
| Gate evidence missing | Gate is `open`. Never inferred from a passing CI run |
| Waiver attempted without a rollback | Refused. `AGENTS.md` requires a rollback rehearsal |
| Two Improve cycles exhausted | The `stop` option is on the table explicitly |

**Security** — G1 is the security gate and is not negotiable by feature pressure. Gates G2/G3
protect the honesty claims; G7 protects customers from being mis-billed. A waived gate is a
recorded, named acceptance of risk with a rollback — not an undocumented shortcut, which is the
form `AGENTS.md`'s release rule exists to prevent.

**Tests**
- `each_gate_has_evidence_a_named_verifier_and_a_date`
- `gate_state_is_never_inferred_from_ci`
- `back_half_features_cannot_start_while_their_gate_is_open`
- `waiver_requires_a_named_owner_and_a_rollback`
- `ai_cannot_be_enabled_for_a_customer_before_g6_is_met`
- `kill_switch_is_exercised_before_g6_is_met`
- `open_gates_name_an_owner_and_outstanding_evidence`

**Deps** — F226, F249, F252, F253, F180, F181, F182, **D2**.