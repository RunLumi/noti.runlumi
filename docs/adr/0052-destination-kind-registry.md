# ADR 0052: Destination kind registry, generated capability page and save-time feature checks

Status: Accepted · Date: 2026-10-15 · Builds part of F105 and F120 (spec 09), the registry-held limits of F119 (spec 09)
and the save-time check of F93 (spec 07); the parts of REMAINING slice 2.6 that need no migration

## Context

Destination kinds were a hand-edited union in `types.ts`, a second copy of it in `web/src/lib/api.ts`, an
`if (value !== 'lark' && …)` chain in the integrations API, two exhaustive `switch`es in
`src/connectors/destinations/index.ts`, and per-kind facts written out three times: the capability constants,
the dashboard's `abilities.ts` (kept honest only by a comparison test) and the `gated` and signing-secret flags in
`web/src/integrations/destinations.ts`. Provider limits were numbers in code comments, with no pointer that a test
could follow back to `docs/DESTINATION_API_REFERENCE.md`. There was no capability page (F120). A `format` or
`features` field in a create request was silently ignored, which is the silent degradation F93 forbids.

The full F105 schema (per-configured-destination capability resolution, a `destination_id` column, rollout stages,
limiter keys) needs a migration or features that do not exist. This ADR takes the part that does not.

## Decision

### 1. One data registry, one adapter table

`src/connectors/destinations/kind-registry.ts` holds `DESTINATION_KINDS` and `DESTINATION_REGISTRY`, a mapped type
over the kinds, so a kind added to the list without an entry does not compile. Each entry has: `kind`, `nameKey`
(the dashboard message id), `label` (English, for server messages and the docs), `capabilities` (the constants
moved verbatim from `capabilities.ts`), `limits`, `openQuestions`, `availability` (the enabled flag: `none` or a
named deployment flag), `signingSecret` (`none`, `customer_optional`, `noti_generated`) and `confirmation`. The file
is pure data so the dashboard can import it without bundling renderers or signing code.

`src/connectors/destinations/adapters.ts` binds each kind to its adapter, also as a mapped type.
`prepareDelivery` and `classifyDeliveryResponse` look the adapter up there instead of switching on the kind.

Readers moved onto the registry, each a mechanical change with unchanged behaviour: `capabilitiesFor`;
`destinationAvailable` and through it the consumer's gate; the consumer's signing-secret choice; the API's kind
parsing (`isDestinationKind`, and the "choose one of" message now lists the registry labels), signing-secret
acceptance and generation; `web/src/lib/api.ts` (`DestinationKind`, `isDestinationKind`);
`web/src/integrations/destinations.ts` (kind list and order, name key, `gated`, both signing-secret flags);
`web/src/setup/abilities.ts` (derived from the capabilities instead of restated).

Left as they are: the per-kind config construction `switch` in `config.ts` and the `HOST_RULES` table in
`url-policy.ts` (both exhaustive and compiler-checked, and each case builds a different typed value), the host
allowlist in `provider-registry.ts` (F229, a separate registry with its own review rule), and the custom-webhook
branches in `src/api/integrations.ts` (workspace cap, one-time secret, host re-verification), which are that
kind's policy rather than dispatch.

### 2. Limits are data with a citation

A `DestinationLimit` has a value, a unit, an optional `enforcedAs` capability field and a `basis`: `provider`,
`derived`, `ours` or `not_stated`. Provider and derived limits carry `{ section, excerpt }`;
`tests/destinations/kind-registry.test.ts` finds the numbered section of the reference and requires the excerpt
verbatim in it, and requires every body, title and text cap to have exactly one limit whose value equals the
capability. Where the reference is silent the entry says so: Slack's 150-character header title is `not_stated`
(the reference does not give it), and the Teams and Lark title and text caps are `ours`. No number was added that
the reference does not state.

### 3. `docs/CAPABILITIES.md` is generated

`src/connectors/destinations/render-capabilities.ts` renders the page (matrix, limits with sources, what is not
known, the save-time feature table, the not-offered list with Telegram, Office 365 Connectors, email and the unbuilt
API modes). `npm run docs:capabilities` writes it through Vite's SSR loader, as `docs:retention` does
(`scripts/render-capabilities.mjs`); the test fails when the committed file differs. The renderer refuses a provider
limit without a source. The page says it is documentation, not real-provider acceptance evidence.

### 4. Save-time feature validation without a migration

`requestedFeatureIssues(kind, { format, features })` checks a request against the kind's capabilities. Create
(repository and source integrations) and `PATCH` run it when `format` or `features` is present, and answer 422 with
the field error:

- an unknown format or feature, or a malformed list: refused, without echoing the value;
- a format or feature the kind's capability says it does not have: refused, naming the kind
  (`Slack in Noti does not support updating a message in place.`);
- a format or feature the kind supports but that cannot be chosen: refused as "not available yet". No column stores
  a choice, so accepting it would be the silent downgrade this exists to prevent. Only the default (richest) format
  is accepted, as a no-op.

Every feature is `false` for every built mode today, so every feature request is refused. Nothing new is stored.

## Consequences

- Adding a kind is one registry entry, one adapter binding, its config case and URL rule, and copy. The API, picker,
  availability gate and docs follow from the entry, and the type checker names whatever is missing.
- The capability matrix and the dashboard summary can no longer drift: both read the same constants. The existing
  `setup.test.ts` comparison now checks the derivation rather than a second copy.
- A client that sent `format` or `features` and had them ignored now gets a 422. No current client sends them.
- The generated page and the registry must change together; CI catches a stale page.

## Not done

- Capabilities per configured destination (F92, F105): one entry per kind, because each kind has one built mode.
- A `destination_id` column, rollout stages, limiter and budget keys, egress policy and setup docs on the registration
  (F105): each needs a migration or a feature that does not exist.
- Storing a chosen format or feature, the chosen rung on the delivery row, `truncated_fields` and elision recorded
  (F93 to F95): need a migration.
- A capability matrix in the wizard (F120); the wizard shows the per-kind summary, which reads the same data.
- The CI grep for destination-specific branches outside the registry (F105).
- Real-provider evidence for any limit.

## Revisit when

- A second mode of one kind ships (Slack Web API, Lark app): capabilities must then resolve per configured
  destination, and the registry gains a mode level.
- A migration window opens for the integrations table: store the format choice and the rung used, then relax the
  "not available yet" refusals.
- The reference is re-researched: update the excerpts, and the test will show which citations moved.
