# Lumi Noti frontend

> Design authority: [`DESIGN.md`](../DESIGN.md). Rationale and acceptance:
> [`adr/0002-noti-design-system.md`](adr/0002-noti-design-system.md).

## Stack

Vite 8 + React 19 + TypeScript, Tailwind 4, Base UI headless Dialog, TanStack Router / Query /
Table. **Tabler Outline** icons (`@tabler/icons-react`). Geist self-hosted via
`@fontsource-variable/geist`.

## Design system

The shared Lumi identity applies here. The landing-page composition in `DESIGN.md` §9 is
marketing-specific and does **not** override this product's workflows or feature availability.

| Rule | Implementation |
| --- | --- |
| Warm Paper White canvas | `--color-paper-white: #f4f0e8` on `body` |
| Opaque white work sheets | `.card` / `.panel`, 1px archival border, `--shadow-card` |
| Civic Navy headings, Ink body | `#102a43` / `#172033` — never pure black |
| Lumi Blue is authority | `--color-lumi-blue: #006093`; primary actions and selection only |
| Radius scale | 2 / 4 / 8 / 12 / 14 / 16 / chip — never a giant rounded panel |
| Navy-tinted elevation only | `--shadow-card`, `--shadow-button`; no black shadows |
| Tabler Outline | 24×24 grid, 2px stroke, `currentColor`, round caps |
| Original logo assets | `brand/lumi-logo.svg` imported into the bundle, fingerprinted by Vite |

**Glass** is reserved for navigation surfaces, with an opaque background declared first, a
`@supports`-gated `backdrop-filter`, and `prefers-reduced-transparency: reduce`,
`prefers-contrast: more` and `forced-colors: active` fallbacks. Reading surfaces stay opaque.

**Accessibility** (DESIGN.md §16): body ≥16px, metadata ≥12px, controls ≥44px tall, 2px focus
ring, 320px reflow without horizontal scroll, `prefers-reduced-motion` honoured. Geist's
**Vietnamese subset is bundled** and ships with `font-display: swap`; the font family in CSS is
`"Geist Variable"` — a bare `geist` silently misses it.

## Run

1. `npm install`; copy `.dev.vars.example` to `.dev.vars` (its `APP_ORIGIN` is `http://localhost:5173`)
2. `npx wrangler d1 migrations apply DB --local` (once, and after each new migration)
3. `npm run dev` — one `vite dev` process on **:5173** serves the dashboard *and* the API Worker
   (`/api`, `/webhooks`, `/github`, `/health`, cron and queue handlers) on a single origin, so
   cookies and the same-origin CSRF check behave as in production. There is no proxy. The cron
   handler can be fired with `curl 'localhost:5173/cdn-cgi/handler/scheduled?cron=*+*+*+*+*'`.
4. `npm run typecheck:web`, `npm run build:web` and `npm run preview` (the production build in
   the Workers runtime; set `APP_ORIGIN` in `web/dist/server/.dev.vars` to the preview origin)

The scripts `cd web` first: TanStack Start resolves its output directory from the working
directory, so running `vite` from the repository root writes the shell to the wrong place.

## Quality gates

`npm run check` runs, in order: `format:check` → `lint` → `typecheck` → `typecheck:web` →
`test` → `build:web` → `verify:worker-bundle`. CI runs the same set with `npm ci`.

The web tests run inside the same `vitest run`. Pure-logic files run in Node; component and
page tests opt into jsdom with a `// @vitest-environment jsdom` docblock and import
`web/src/a11y/testing/environment.ts` first (it stubs the few browser APIs jsdom lacks and
installs the `fetch` hook that the Better Auth client captures at import time).

ESLint is **type-aware**. The web rules set `no-unsafe-*` to `warn` because dashboard APIs that
do not exist yet still return loosely-typed shapes; the Worker rules set them to `error`,
because a webhook body is untrusted input and `JSON.parse` returning `any` is the defect class
that produced `00-current-state.md` D3.

## Accessibility and localization (`web/src/a11y/`, `web/src/i18n/`)

Decisions and verification: [ADR 0013](adr/0013-accessibility-localization.md).

| Path | Role |
| --- | --- |
| `a11y/RouteA11y.tsx`, `route-titles.ts` | After a path change: `document.title`, a polite `role="status"` announcement, focus to the page `<h1>` |
| `a11y/SkipLink.tsx` | First tab stop on the shell and sign-in screens; focuses `<main id="main-content">` |
| `a11y/a11y.css` | `.visually-hidden`, programmatic-focus outline rule, 1.4.10 reflow fixes for the wizard |
| `a11y/contrast.ts`, `contrast.test.ts` | WCAG ratios for the DESIGN.md palette pairs; known gaps pinned to exact ratios |
| `a11y/css.ts`, `stylesheet.test.ts` | Reads the stylesheets: glass / reduced motion / transparency / forced colours / focus ring / target size / Vietnamese type / bundled font coverage |
| `a11y/testing/` | jsdom environment, mock API, fixtures, the real route table, the axe adapter |
| `a11y/pages.a11y.test.tsx`, `dialogs.a11y.test.tsx` | axe-core on every route, wizard step, dialog and error state, in `en` and `vi` |
| `a11y/keyboard.test.tsx` | Skip link, tab order, no trap, route-change focus and announcement, language switch |
| `i18n/locale.ts`, `LocaleProvider.tsx`, `LocaleSwitcher.tsx` | Active locale (saved choice, `navigator.languages`, English), `<html lang>`, the `<select>` |
| `i18n/format.ts` | `Intl` dates and relative times in the active locale (numbers: `formatNumber` in `i18n/index.ts`) |
| `i18n/messages.en.ts`, `messages.app.en.ts` | English source catalogue (two files, merged in `i18n/index.ts`) |
| `i18n/messages.vi.ts`, `messages.app.vi.ts`, `messages.filters.vi.ts`, `messages.sources.vi.ts` | Vietnamese catalogue, typed against English (one file per English file) |
| `i18n/catalogue*.ts`, `hardcoded-strings.test.ts`, `literal-scan.ts` | Completeness, placeholder, plural and literal-string checks |

Rules for new UI:

- **No literal user-visible text in a component.** Add an id to `messages.en.ts` (or
  `messages.app.en.ts`) *and* a Vietnamese string to the matching `messages.vi.ts` file;
  `npm test` fails on a missing id, a changed `{placeholder}`, or JSX text, a rendered string
  literal or a `placeholder` / `aria-label` / `title` / `alt` that is not a `t()` call. Brand
  names and symbols are exempt; anything else needs an entry in the allow-list in
  `hardcoded-strings.test.ts` with a reason (it is empty today).
- **Dates, relative times and numbers go through `i18n/format.ts` / `formatNumber`**, never a
  hard-coded locale or `toLocaleDateString()`.
- **A new route** is a file in `web/src/routes/` (`createFileRoute`, component imported from the
  feature folder; `routeTree.gen.ts` is regenerated by `vite dev` / `build:web` and committed) *and*
  an entry in `ROUTE_PATHS` / the router in `a11y/testing/render.tsx` plus an axe scenario in
  `pages.a11y.test.tsx`; a route test fails until all three agree. It also needs a title in `a11y/route-titles.ts`.
- **A new dialog** needs an axe scan with it open and the focus contract: focus on the safe
  control, Tab cannot leave, Escape closes, focus returns to the trigger (see
  `dialogs.a11y.test.tsx`).
- **Text-field edges use `--color-control-border`** (Soft Slate, 3:1); the archival border is
  for sheets and rows.
- **Every component calls `useLocale()` first** (`i18n/LocaleProvider`), so a language switch
  re-renders in place and keeps focus, open dialogs and typed values; `locale-reactivity.test.ts`
  fails for a component that forgets.

## Pages

`/signup` `/signin` `/forgot-password` `/verify` `/reset` ·
`/` (overview) `/integrations` `/integrations/new` `/integrations/:id` `/sources` `/sources/:sourceId` `/activity`
`/activity/:deliveryId` `/destinations` `/team` `/audit` (admins) `/settings` `/onboarding` `/invite`

## Delivery log and workspace data (`web/src/deliveries/`, `web/src/workspace/`)

Decisions and verification: [ADR 0009](adr/0009-delivery-log-ux.md).

| Path | Role |
| --- | --- |
| `deliveries/DeliveryLogPage.tsx` | `/activity`: filters, table, load more, empty/error/loading states |
| `deliveries/DeliveryTable.tsx` | TanStack Table; rows stack into labelled cards at narrow widths |
| `deliveries/DeliveryPage.tsx` | `/activity/:deliveryId` (ADR 0056): the dialog's body at its own address, from `GET /api/deliveries/:id` alone; a 404 (unknown or another workspace's id) is the shell 404 |
| `deliveries/DeliveryDetail.tsx`, `RedeliverPanel.tsx` | Detail dialog (with an "Open as a page" link) and the shared `DeliveryDetailBody`, plain-language cause, admin-only confirmed redelivery, duplicate disclosure; "Details for support" holds the delivery ID, the error code and the request ID (monospace, copyable, linked to the log filtered by it; ADR 0050) |
| `deliveries/AttemptTimeline.tsx` | Per-attempt history in the detail dialog: one line per try or wait, oldest first, outcome in words, status class and a minted code, never what the destination answered (ADR 0023) |
| `deliveries/BulkRedeliver.tsx` | "Redeliver all failed" on the Failed view: count from the server first, then confirm; the number is typed above 20; a stale plan is refused and re-counted; not optimistic |
| `integrations/HealthNotice.tsx` | The circuit breaker and rate-limit hold on an integration card and its settings: shown in words, never enforced (ADR 0023) |
| `deliveries/DeliveryStats.tsx` | Overview figures from `GET /api/deliveries/summary` (last 24 hours, counted not estimated) |
| `deliveries/search.ts`, `api.ts`, `copy.ts` | URL-backed filters (outcome, integration, dates, request ID), strict response parsing, state and error copy |
| `workspace/` | Settings: credential-free export download and two-phase workspace deletion |

Delivery ledger depth (ADR 0023): the detail dialog says, in this order, what happened, then (when it
applies) "This may have arrived more than once" for a possible duplicate, or "Not sent again" with the reason
and a link to the first delivery for a suppressed repeat, then the facts, then "Every attempt". A waiting
delivery paused by the breaker or by the destination's own rate limit says so and says nothing was lost or
turned off. The copy lives in `i18n/messages.ledger.en.ts` and `.vi.ts` (`useLocale()` in every component, both
catalogues in lock-step). Each attempt's outcome is a word as well as a rail colour (WCAG 1.4.1), the list is a
labelled `<ol>`, and the bulk panel is a labelled group with a labelled number field. Verified by axe in
`a11y/dialogs.a11y.test.tsx` (attempts, possible duplicate, suppressed, bulk preview and result, each in English
and the key ones in Vietnamese) and by the integrations and settings page scenarios, which now include an open
breaker. **Not verified:** a real browser at 320 px and with a screen reader for these new surfaces; the
Vietnamese copy has not been reviewed by a native speaker. A run of identical waits is one line ("Waited, and then 41 more times"), a delivery held back for more than a day reads "Stopped waiting", a repeat of a failed original says to redeliver the original, and after the bulk confirm button unmounts focus moves to the result or stale notice (the loading line is a status region).

Request ID and consequence counts ([ADR 0050](adr/0050-request-id-in-detail-and-pause-delete-impact.md)): the request
ID sits in the collapsed "Details for support" block, as spec 14 F220 places it, in Geist Mono (`.mono-wrap`), with the
shared `CopyButton` and a real link to `/activity?correlationId=…`. Following the link closes the dialog and moves focus
to the page heading, because the reloading list may briefly remove the row that opened it. A delivery without an id says
"Not recorded" and offers no link. The activity filters gained a request-ID field, the audit log's text filter moved to
`components/TextFilter.tsx` and validated with the Worker's own `sanitiseCorrelationId`. Pausing an integration now opens
an alert dialog (focus on "Keep sending"), and the delete dialog gained the same impact block: an opaque Paper White sheet
with a hairline border, one `role="status"` region that stays mounted, one plain sentence per non-empty group. The counts
are the server's (`GET /api/integrations/:id/impact`); a failed count is said as unknown, never as zero. Pause is never
blocked by a slow or failed count; the typed delete stays inert while counting and is allowed once the count fails.
Resuming applies at once. Copy is in `i18n/messages.ledger.en.ts` and `.vi.ts`.

## Workspace switcher and audit log (`web/src/workspace/`, `web/src/audit/`)

Decisions and verification: [ADR 0019](adr/0019-workspace-switcher-audit-log.md). The "workspace
switcher was explicitly not built" note from slice Fix F is closed by this.

| Path | Role |
| --- | --- |
| `workspace/WorkspaceSwitcher.tsx`, `switcher.css` | Sidebar control: Base UI menu (radio list plus Create workspace) for several workspaces, a static label with a create link for one, nothing for none; own live region |
| `workspace/switching.ts` | `useSwitchWorkspace` (persists via `POST /api/workspace/active`, updates `me`, then `dropOtherWorkspaces`) |
| `audit/AuditPage.tsx`, `AuditFilters.tsx`, `AuditTable.tsx` | `/audit`, admin only: filters in the URL, table that stacks into cards, load more, empty/error/forbidden states, retention note, CSV of the loaded events |
| `audit/api.ts`, `hooks.ts`, `search.ts`, `copy.ts`, `csv.ts` | Strict parsing, query keys `['audit', orgId, ...]`, URL validation, plain-language labels (`audit.action.<id>`, `audit.detail.<key>`), formula-safe CSV |

**Read side (ADR 0028).** Filters in the URL: action, result, **actor** (a select of current members, from `GET /api/workspace/team`, plus
"Noti (automatic)"), **target** (`target` and `targetType`), **request id** (`correlationId`) and dates. The two text fields apply on Enter
or when left, not per keystroke; an id that cannot be valid shows an error in words (`aria-invalid`) and is not sent; `validateAuditSearch`
drops anything that does not match the server's shapes. The first page shows a total ("N events match", "More than N events match" past
10,000). Each row has two text actions that replace the filters in one click ("Show events about this", "Show events from this request",
both 44 px tall) and a "What changed" block: `from X to Y` lines for `enabled`, `repo` and the subscribed updates (added and removed),
built from the server's `changes`, never from a secret. Words, not an arrow: the bundled Geist subset has no U+2192, which the
Vietnamese glyph test would reject. A failed read is the existing error panel (the server answers 503 and fails closed), never an empty
log. Verification: `web/src/audit/audit.test.tsx` (URL search, diff lines, Enter-to-apply, invalid id, one-click filters, member list
names only, CSV) and axe on the filtered and diff states in English and Vietnamese (`web/src/a11y/pages.a11y.test.tsx`). Not verified: a
screen reader, a real 320 px device, and the Vietnamese copy by a native speaker.

**Audited reads (ADR 0039).** Each page the dashboard loads is recorded as an "Audit log read" row, so the log lists its own reads.
Its labels are `audit.action.audit.read` and `audit.detail.continued` in `messages.audit.{en,vi}.ts`. No control changed.

| `workspace/bound.tsx` | `useBoundWorkspace`: a form, wizard or dialog keeps the workspace it was opened for; `StaleWorkspaceNotice` |
| `workspace/drift.tsx` | `WorkspaceDriftBanner`: detects an active-workspace change made in another tab (`BroadcastChannel('noti-workspace')`, focus), drops caches, alerts |

**Write rule:** every dashboard mutation names its workspace with `?org=` (the server requires it for
people in several workspaces); `workspace/org-param.test.ts` scans for a mutation that does not.

**Query-key rule:** every workspace-scoped key is `[area, orgId, ...]`. On a switch every cached
query that is not `me`, `passkeys` or the new workspace's is removed, so a new feature must follow
the rule or its data is dropped (never leaked).

## Integrations feature (`web/src/integrations/`)

Decisions and verification: [ADR 0007](adr/0007-integrations-ux.md).

| Path | Role |
| --- | --- |
| `IntegrationsPage.tsx`, `IntegrationCard.tsx`, `EnabledSwitch.tsx` | List, card, pause (after a confirmation that states its consequence) and resume (at once), both optimistic with rollback |
| `ImpactSummary.tsx` | What a pause or a delete affects, from `GET /api/integrations/:id/impact` (ADR 0050): one sentence per non-empty group, "More than 10,000" at the cap, an unknown count said as such, never a zero it did not measure |
| `github/` | Connection panel, `?github=` return messages, repository picker, coverage rules |
| `wizard/` | Six-step create flow (filters are optional) plus the optional "Test it" step shown after saving (`TestStep.tsx`); `draft.ts` holds the pure step logic |
| `test/` | "Send a test notification" ([ADR 0018](adr/0018-test-send.md)): `TestSend.tsx` (settings section, list row and wizard step), `useTestSend.ts`, `poll.ts` (bounded wait, pure and unit-tested), `api.ts`, `test-send.css` |
| `filters/` | Routing filters ([ADR 0010](adr/0010-routing-filters.md)): `model.ts` (lines to API shape, error mapping, "Try it"), `FiltersEditor`, `FilterTester`, `RoutingLog` |
| `noise/` | Quiet hours and summaries ([ADR 0016](adr/0016-noise-control.md)): `model.ts` (draft, validation with the server parser, the preview sentences from the server's `decideNoise`, time-zone list), `NoiseEditor`, `NoiseSection`, `hooks.ts` (waiting count), `noise.css` |
| `settings/` | Per-integration screen: details form, filters, quiet hours and summaries, credential section (state, fingerprint, replacement, `RevokeDialog`), delete dialog |
| `destinations.ts` | One entry per destination: copy ids, numbered setup steps, docs link. The kind list and order, name key, `gated`, `supportsSigningSecret` (Lark: a pasted secret) and `issuesSigningSecret` (custom webhook: server-generated, shown once) are read from the server's kind registry (`src/connectors/destinations/kind-registry.ts`, [ADR 0052](adr/0052-destination-kind-registry.md)), as are `DestinationKind` and `isDestinationKind` in `lib/api.ts` |
| `IssuedSecret.tsx` | The custom webhook's one-time signing secret (create wizard and credential rotation); same behaviour as `sources/SecretReveal.tsx` |
| `validation.ts` | Client checks mirroring `src/api/integration-input.ts` (imports the Worker allowlist) |
| `events.ts` | Plain-language label map keyed by `src/connectors/sources/github/catalog.ts` |
| `../i18n/` | Message catalogue and `t()`/`tp()`; new screens add ids, not literals. Filter copy is in `messages.filters.en.ts`, merged into `en` |
| `../components/form.tsx` | `Field` (label, hint, linked error), `SecretInput`, `focusFirstInvalid` |

Destinations (ADR 0014): the picker offers Lark, Slack, Teams, Discord and **Custom webhook**.
Discord's steps and notes say that mentions cannot notify anyone and that a deleted webhook
pauses the integration after the first failure. The custom webhook's steps are the receiver's
contract (POST JSON, verify `webhook-signature`, answer 2xx within 10 s, deduplicate on
`webhook-id`), and its notes say plainly that the hostname is checked when saved and not on every
delivery, and that a 2xx is the only evidence Noti has. Its signing secret is generated by the
server and revealed once after the save (the wizard stays on the reveal until the person
confirms; the secret lives in component state only and is never written to the query cache); a
credential replacement issues a new one and says the old one stopped working. The custom
webhook is hidden until the server reports it available (`capabilities.genericWebhook` on the
list response; an unloaded list counts as off), so the screen never offers what the API would
refuse. The chat picker on
a source does not offer the custom webhook yet (no reveal step in that flow). Copy is in
`i18n/messages.destinations.en.ts`, merged into `en` like the filters catalogue. Client URL
checks import the Worker's `url-policy.ts`, so they accept exactly what the server accepts, and
a test compares the two for every new case; the server's DNS check is not (and cannot be) run in
the browser, so a host that resolves privately is reported by the server after submit.

Rules this feature follows: webhook URLs and signing secrets are write-only (masked input with
a show toggle, never pre-filled, never echoed); a failed query is an error state, not an
empty list; field errors sit next to the field and the first invalid control takes focus;
destructive confirmation focuses the cancel button.

Filters: one entry per line in labelled textareas inside fieldsets with legends; each error is
attached to its control and line and announced. The form imports the Worker's own filter parser
and evaluator, so it accepts exactly what the API accepts and "Try it" answers as ingress would;
it sends nothing and says so. Bot handling is three radio choices; a deleted account is never
skipped, and the copy says why. "Recent decisions" shows event type and reason, never content.
Each filter group says which updates it applies to; an "only" list that cannot be enforced on a
selected update is refused with the same rule the API uses (and a "never" rule is flagged as
not covering them). Unknown details hold an update back, and the copy says so. When the stored
filters cannot be read, a blocking notice explains that updates are being held back, and the
editor stays hidden until the person chooses **Replace invalid filters**, so unreadable rules are
never overwritten by an empty form. `npm test` runs
`web/src/integrations/integrations.test.ts` with the Worker tests.

Quiet hours and summaries (settings section, slice 8): four fieldsets or fields (quiet hours with
two `<input type="time">` controls, "Combine updates for" as a select of Off / 1 / 5 / 15 / 60
minutes, a summary choice of right away / hourly / daily with a daily time, and resolved
notices) plus a time-zone select (the viewer's zone by default, `Intl.supportedValuesOf` where
the browser has it). Design decisions, so they are reviewable:

- **The preview is computed, not templated.** The sentences under the form (for example "During
  quiet hours Noti will hold updates and send one summary at 08:00.") come from the Worker's own
  `decideNoise`, evaluated for an update arriving just after quiet hours begin, so the form can
  never promise something ingress will not do (a later daily summary changes the time shown).
- **"Saved", not "held".** The filters copy already uses "held back" for an update that is NOT
  sent, so a delayed update is "saved" and "waiting to be sent". A status block says how many are
  waiting and when the next send is due, so a held update is never a black hole.
- **Everything is off until chosen**, including resolved notices (spec 11 F152 asks for default
  on; a missing setting must not change an existing integration, ADR 0016). Resolved notices are
  hidden for a source integration and disabled, with the reason, when no failing run is selected.
- Errors sit next to the control in our own catalogue copy (never the server's wording) and the
  first invalid control takes focus. An unreadable stored document is a warning, not a block:
  updates are being sent normally, and saving replaces it.
- The delete confirmation says how many saved updates are deleted with the integration (ADR 0050
  moved that count into the impact block, with the rest of what a delete removes and keeps). A hint says that a window that ends at midnight uses 00:00. The preview takes the
  instant as an argument (pure), and the time-zone list falls back to a built-in set of common zones
  when the browser cannot list them.
- The recent-decisions list shows a saved update as "Saved for later" with a sentence, and an
  urgent bypass as such.
- **"Send at least every"** (maximum wait, [ADR 0043](adr/0043-noise-max-wait-and-summary-rendering.md),
  "Dashboard control"): a select of Off / 15 minutes / 1 hour / 4 hours built from the server's
  closed list, inside "Combine bursts" and shown only while a combine window is chosen. One hint
  sentence says that each new update restarts the wait but the message is sent anyway that long
  after the first one; the preview adds one sentence ("… at the latest. Quiet hours can still hold
  it longer."). Turning combining off saves it as off; the draft keeps the choice meanwhile. A
  server refusal lands on the control. Covered by the section and model tests and the `int_6` axe
  page scenario in both languages; no browser pass.
- Every component calls `useLocale()`; every English id in `messages.noise.en.ts` has a
  Vietnamese string in `messages.noise.vi.ts` (the catalogue tests enforce both).
- **Verification:** jsdom tests for the model and the section (what a save sends, validation,
  server refusal, keyboard, Vietnamese), axe scenarios in English and Vietnamese for the populated
  section and for a validation error (`pages.a11y.test.tsx`, `dialogs.a11y.test.tsx`, following
  the process notes in ADR 0013). **Not verified:** a real-browser pass (320 px reflow, contrast of
  the new fieldsets and read-outs, native time-picker behaviour on phones, Vietnamese
  diacritics) and a screen-reader pass.

## Setup flow, shell and state components (`web/src/setup/`, `web/src/shell/`, `web/src/components/`)

Decisions: [ADR 0025](adr/0025-setup-and-shell-ux.md) (supersedes the setup part of ADR 0018).

- **`/setup` and `/setup/:step`** (`github`, `repository`, `destination`, `events`, `test`, `done`). `SetupResume` asks
  `GET /api/setup/progress` where the workspace left off and replaces its history entry with that step; `SetupFlow`
  renders the page with the step list (`aria-current="step"`, each state spelled in words, hidden below 900px where
  the heading says "Step n of 6"). Done-ness is never remembered in the browser. The one thing held client-side is the
  draft of the step in progress (repository, destination, webhook address), in memory, guarded by a leave
  confirmation only when it leaves `/setup`. Pages reuse the wizard's `SourceStep`, `DestinationStep`, `WebhookStep`,
  `EventPicker`, `TestSend` and `EnabledSwitch`; the integration is created by the normal `POST /api/integrations`.
- **Blocked states** come from the server's `blockedBy` (`blocked.ts`): a server without a GitHub App says so, says
  whose move it is, and offers the signed-webhook source instead of a button that cannot work.
- **Overview card** (`SetupProgressCard`): the six steps with their states, blocked reasons, and one button into the
  next step; one honest line once setup is complete but no real event has arrived; nothing when all is done.
- **GitHub return.** GitHub always returns to `/integrations?github=<status>`; a trip started in setup sets a
  `sessionStorage` hint (a hint to resume, never state) and `GithubReturnStatus` forwards to `/setup/github`.
- **Shell.** `shell/route-guard.ts` lists routes as rows (`public`, `authenticated`, `admin`); an address with no row
  gets the 404 page inside the shell when signed in (`RootNotFound`, also the router's `notFoundComponent`). Sign-in
  `returnTo` goes through `safeReturnTo` (relative, same origin only). Breadcrumbs (`Breadcrumbs`, `crumbs.ts`) on
  integration settings, the create wizard, setup steps, a delivery's page and a source's page (ADR 0056; the source
  crumb fills in the name, the delivery crumb stays "Delivery"). A failed-deliveries link appears under Activity when
  the server counts failed deliveries.
- **Destination abilities** (`CapabilitySummary`, `abilities.ts`): derived by `abilitiesOf` from the kind registry's
  capabilities (ADR 0052), the same constants `docs/CAPABILITIES.md` is generated from, so the summary and that page
  cannot disagree; `setup.test.ts` checks the derivation field by field. No visual change: the rendered rows,
  markup, copy and styles are the same, so no new layout, focus, contrast or 320 px check was needed.
- **Integration settings order**: status (+ repair panel), source and updates, filters, destination, test, quiet
  hours, credentials, health, history, delete. Health and the repair panel read `/api/deliveries?integration=`.
- **Shared states**: `Skeleton`, `EmptyState`, `ErrorPanel` (what happened, why, what to do, how to get help). The
  Integrations, Sources, Activity and Audit lists draw their loading, empty and filtered-empty states with the first
  two (ADR 0038; `web/src/components/state.test.tsx`). The ErrorPanel is chosen by the kind of failure, never by server text. `error-copy.test.ts` bans filler phrases in both
  catalogues. No support address exists in the product yet, so help says "tell your workspace admin" plus the
  reference.
- The result of a test is announced through a polite `role="status"` region that exists before the click; focus stays
  on the button. Test rows in the delivery log carry a "Test" badge.

## Sources feature (`web/src/sources/`)

Decisions and verification: [ADR 0012](adr/0012-generic-source.md). It reuses the integrations
sheet, switch, field, destination-choice and dialog styles and the `validation.ts` URL policy.

| Path | Role |
| --- | --- |
| `SourcesPage.tsx` | `/sources`: create form, one-time secret reveal, list, empty / error / loading states |
| `SourceDetailPage.tsx` | `/sources/:sourceId` (ADR 0056): the same card in `standalone` mode under a page heading with the name; rotate reveals once as on the list (`useSourceOutcome`); delete goes back to the list; a 404 is the shell 404 |
| `SourceCard.tsx` | "Open page" link to the source's own address (hidden on that page), endpoint URL with copy, last event, connected chats, credential fingerprint and revoked state, pause switch, actions (rotate, revoke, delete) |
| `SecretReveal.tsx`, `CopyButton.tsx` | One-time secret (persistent warning, focus moves in, explicit dismiss); copy with a stated outcome and a manual-copy fallback |
| `SourceDialogs.tsx` | Rotate (states the cutover, or after a revoke that it turns the source back on) and delete (typed name, states the chats deleted with it); focus starts on the safe choice. Revoke uses the shared `RevokeDialog` (ADR 0049) |
| `ConnectChat.tsx`, `connect.ts` | Connect a Lark, Slack or Teams chat to a source; pure validation mirrors `src/api/integration-input.ts` |
| `Guidance.tsx`, `snippets.ts` | Event format and signing explanation; shell and Node examples that read the secret from `NOTI_SIGNING_SECRET` |
| `api.ts`, `hooks.ts` | Strict response parsing; mutations that return a secret use `gcTime: 0` and never write the query cache |
| `providers.ts` | Source kinds, the pasted-credential checks (a parity test asserts they agree with the Worker's `parseSecret`), the event catalogues imported from `src/connectors/sources/*/catalog.ts`, the create body |
| `ProviderGuidance.tsx` | GitLab and Stripe setup steps: what to paste where, GitLab.com only, auto-disable and push limits, secret-token weakness (shown only in that mode), Stripe test/live and privacy notes |

Provider sources (ADR 0015): the create form starts with a kind picker (your own system, GitLab,
Stripe). GitLab asks which credential will be pasted (signing token, recommended, or secret
token, labelled weaker) and Stripe asks test or live; the credential goes in a masked field with
a statement that it is stored encrypted and never shown again. A provider create or replace shows
a plain success notice, never a secret reveal; only the generic source reveals a generated secret
once. The card shows the kind, how GitLab is verified or which Stripe mode it is, and the
provider guidance instead of the shell and Node examples. "Send these events to a chat" lists the
kind's event catalogue as checkboxes (none ticked means all). Replace credential (admin) asks for
the new pasted value. Copy lives in `web/src/i18n/messages.providers.en.ts`, merged into `en`
like the filters catalogue; every catalogue event type has a label (tested). Not verified: a
browser, 320 px, keyboard or screen-reader pass of these screens.

Rules this feature adds: the signing secret lives only in component state and is gone on
dismissal or navigation (no storage, URL, cache or console; a test greps for this); it is never
placed in a copyable example; status is always text, not colour alone. Rotate and delete are shown to workspace admins only (the server enforces it); a card shows "N events were rejected because their id was reused" when a sender reuses webhook-ids. Integrations bound to a
source show "Events from your own system" instead of a repository, and their settings page
explains that updates cannot be chosen. `web/src/sources/sources.test.ts` runs the shell and
Node examples and checks their output with the Worker's verifier. **Not verified:** a browser
pass at desktop and 320 px, keyboard and screen-reader walkthrough, contrast and Vietnamese
rendering of the new screens; they were checked only through types, lint and unit tests.

## Detail routes and Destinations health (ADR 0056, `web/src/destinations/`)

Decisions and verification: [ADR 0056](adr/0056-detail-routes-and-destinations-health.md).

- **Deep links.** `/activity/:deliveryId` and `/sources/:sourceId` render the same content as the Activity dialog
  (`DeliveryDetailBody`) and the Sources card (`SourceCard standalone`). The dialog is kept as the quick look from the
  list (it keeps the loaded pages, filters and focus return) and links to the page; each source card links to its page.
  Both pages read only their own endpoint, so a reload works; both are `prefix` rows of the route guard; a 404 from the
  API (the same answer for a deleted id and another workspace's) renders `RootNotFound` inside the shell and never
  echoes the id. Section headings are `h2` on the page and `h3` in the dialog. The two list routes are index routes
  (`activity.index.tsx`, `sources.index.tsx`), so `DeliveryLogPage` reads its search from `/activity/`.
- **Destinations health** (`DestinationsHealthPage.tsx`, `health.ts`, nav item after Activity, Tabler `heartbeat`): one
  table row per integration with the destination kind and host, the switch, the breaker and pacing state, failures in a
  row and the webhook URL state, exactly as `GET /api/integrations` reports them. No `health` object means "Not
  reported" in words (never `0`), explained in a note under the table. Each row links to the integration. The table
  reuses `.delivery-table` (explicit roles, rows stack into labelled cards below 760px); the integration link is a 44px
  target; states are words with icons, colour only a rail. Copy in `i18n/messages.shell.en.ts` and `.vi.ts`.
- **Verified** by `shell/detail-routes.test.tsx` (cold load, guard redirect with `returnTo`, 404 for a foreign id,
  breadcrumbs, dialog link, delete back to the list, the health rows and "Not reported"), `shell/shell.test.ts`, seven
  axe scenarios in English and Vietnamese in `a11y/pages.a11y.test.tsx`, `a11y/keyboard.test.tsx` (tab order with the
  new item) and `a11y/reflow.test.ts` (the new stylesheet). **Not verified:** a real browser at desktop or 320px, a
  screen reader, forced colours, and a native-speaker review of the Vietnamese. The admin navigation now has eight
  items; F205's six-item cap is not met.

## Sessions panel (`web/src/account/`, ADR 0030)

Settings shows "Where you are signed in" between the passkeys and the workspace-data panels: `SessionsPanel.tsx` over
`GET /api/workspace/me/sessions`, one row per session with a device name made from the user agent (`device.ts`, a label to
help a person recognise their own device, never a fact; an unrecognised agent is "Unknown device"), "This device" on the
session in use, the sign-in and last-active times, and a shortened address. Each other session has a "Sign out {device}"
button; "Sign out all other devices" ends the rest and is disabled when there are none. There is no confirmation step: the
worst outcome is signing in again. Results are announced (`role="status"`), errors assertively. The text states both limits
(30 days idle, 90 days absolute) from the server's own constants (`src/auth/session-policy.ts`), so it cannot drift. Strings
are `web/src/i18n/messages.sessions.{en,vi}.ts`; audit labels for the new actions are in `messages.audit.*`. Controls use
`.btn` (44 px); metadata is 13 px; below 480 px the button drops under the text. Verified: jsdom with axe in English and
Vietnamese (`sessions.test.tsx`), the stylesheet and hard-coded-string tests. **Not verified:** a real browser at 320 px, a
screen reader, and a native-speaker review of the Vietnamese.

## Pending invitations on the Team page (ADR 0045, `web/src/team/`)

Admins see "Pending invitations" between Members and Membership. `PendingInvitations.tsx` lists `GET /api/workspace/invitations?org=`
and is rendered only for an admin, so a member never calls it (the server would answer 403 anyway). Each row shows the address, the
recorded role ("Role not recorded" when there is none, never a guessed one), "Sent {date}" and "Expires {date}", or "Expired {date}"
with an Expired badge when the server says the expiry has passed. An expired invitation stays listed and can be cancelled, so an admin
can clear it. Nothing is computed in the browser except the date formatting.

States: nothing pending is the shared `EmptyState` (level 3, under the page heading); loading is the shared `Skeleton`; a list that
cannot load is the shared four-part `ErrorPanel` with "Try again" when the failure kind allows a retry.

Cancel is an alert dialog in the pattern of `RevokeDialog`: focus starts on "Keep invitation", Escape closes it, and only the confirm
button sends `POST …/cancel?org=`. On success a status line names the address and says the link no longer works, and focus moves to the
section heading, because the row that had focus has gone. A 404 (already finished, or not in this workspace) refreshes the list and
shows the error panel; any other failure shows the error panel and keeps the list as it was. The Team page's "Remove" control used
`window.confirm` until ADR 0048 (next section).

Controls use `.btn` (44 px). The address is 16 px, metadata 13 px, and rows wrap under the text at narrow widths (the `.team-entry`
pattern). Strings are `team.invitations.*` in `web/src/i18n/messages.app.{en,vi}.ts`.

Verified: jsdom component tests (`web/src/team/pending-invitations.test.tsx`: contents with no invented data, admin-only rendering, empty,
error and retry, cancel with focus, the 404 refresh, axe in English and Vietnamese), the route-wide axe scenarios
(`pages.a11y.test.tsx`: nothing pending, list unavailable), the workspace-parameter test, and the server tests in `tests/api/invitations.test.ts`.
**Not verified:** a real browser at 320 px, a screen reader, and a native-speaker review of the Vietnamese strings, which were written
by the engineer and need that review before they are relied on.

## Sign-up mode notice and remove-member confirmation (ADR 0048)

**Sign-up notice.** `AuthPage` in sign-up mode reads `GET /api/public/signup-mode` (`fetchSignupMode` in `web/src/lib/api.ts`,
React Query key `['signup-mode']`, one-minute `staleTime`, no retry). `invite_only` shows an info `Notice` ("Sign-up is by
invitation": an invited person opens the link in their invitation email; without one no account is created and no email is sent)
and keeps the form usable; after submitting, the message is conditional ("If this address has an invitation…"). `closed` shows a
warning `Notice` ("New accounts are not being created") and disables every field and the submit button; the submit handler refuses as
well. An unknown or unreadable answer shows no notice and leaves the decision to the server. The notice sits between the description
and the form, at 16 px with a 20 px Tabler Outline icon (`IconMailForward`, `IconLock`), opaque, the warning in Signal Amber soft
(`.signup-mode-notice` in `styles.css`).

**Invitation flow.** The signed-out invitation page links to `/signup?invite=<id>`. With a valid id (`invitationIdFrom`: URL-safe,
at most 128 characters, otherwise ignored), an invite-only page shows "You're signing up from an invitation" instead, the "Sign in"
link carries `returnTo=/invite?id=<id>`, and the verification callback is `/signin?verified=1&returnTo=…`, re-validated by
`safeReturnTo` on sign-in. `closed` disables the form with or without an invitation.

**Remove member.** `web/src/team/RemoveMemberDialog.tsx` replaces `window.confirm` with the alert-dialog pattern of `RevokeDialog`:
focus starts on "Keep member", Tab is trapped, Escape closes and returns focus to the trigger, and only "Remove member" sends. The
description has one paragraph per part of the four-part message (who and from which workspace in the title; what they lose; what
is kept; how to undo, and that it is audited), at 16 px (`.remove-member-body`). A refusal stays in the dialog as an error `Notice`;
success closes it with focus on the Members heading (`finalFocus`, since the row is removed) and a status line names the address.
"Leave organization" still uses `window.confirm` (not in scope). Strings: `auth.signup.*` and `team.members.*` in
`web/src/i18n/messages.app.{en,vi}.ts`.

Verified: jsdom with axe in English and Vietnamese (`web/src/signup-mode.test.tsx`, `web/src/team/remove-member.test.tsx`, three
sign-up states in `pages.a11y.test.tsx`, the remove dialog's focus contract in `dialogs.a11y.test.tsx`), the hard-coded-string and
stylesheet tests. **Not verified:** a real browser at 320 px, a screen reader, a real verification email returning to the invitation,
and a native-speaker review of the Vietnamese.

## Installation actor and export before delete (ADR 0055)

**GitHub App installation as the actor.** `AuditActor` (`web/src/audit/api.ts`) has a fifth kind, `{kind: 'installation', account}`,
for the lifecycle rows GitHub caused (uninstalled, suspended, repositories changed). The Who cell shows the account login as
`cell-main` with "GitHub App installation" as `cell-sub` under it, the same pair the subject cell uses, so it reads as a name and a
role and stacks the same way in the 320 px card layout; with no known login it shows "GitHub App installation" alone. It is never
blank, never the row id and no longer "Noti (automatic)". The CSV uses one string, "acme (GitHub App installation)" (`actorLabel`).
The Who filter has a third fixed option, "GitHub App installation" (`~github-installation`, validated by `isNamedActor` in
`search.ts`), after "Noti (automatic)"; the hint says what each fixed option means. No new colour, icon or control size.

**Export before delete.** `DeleteWorkspaceDialog` opens with an opaque block, "Keep a copy first (optional)", between the description
and the confirmation form: one sentence (what the export holds, no credentials, and that the deletion can be scheduled without it) and
an outline "Download export" button (Tabler `IconDownload`, 44 px) that calls the same `downloadExport` as the Settings panel for the
workspace the dialog is bound to. The block is a labelled `section` (a region named by its title) styled with the `.impact` block of
ADR 0050 (Paper White, hairline, Civic Navy title), not a new pattern. Its success or error `Notice` appears inside the block; the
dialog stays open. It is a choice, not a step: initial focus stays on "Keep workspace", the confirm button does not depend on it, and a
failed export leaves scheduling available. The button uses `aria-disabled` while the file is prepared, so it stays reachable.
Strings: `workspace.danger.dialog.export.{title,body,button}` in `messages.{en,vi}.ts`; the progress, done and error lines reuse
`workspace.export.*`.

Verified: `web/src/audit/audit.test.tsx` (parsing, the two-line cell, Vietnamese labels, the CSV label, the filter in the URL and the
request), a new audit scenario with installation rows in `web/src/a11y/pages.a11y.test.tsx` (axe in English and Vietnamese), and in
`web/src/a11y/dialogs.a11y.test.tsx` the dialog with the block (axe in both languages, focus still on Keep workspace, an export that
schedules nothing, a deletion scheduled without an export, a failed export). **Not verified:** a real browser download, a real 320 px
device, a screen reader, and a native-speaker review of the Vietnamese.

## GitHub disconnect (ADR 0058, `web/src/integrations/github/`)

**Where.** On the Integrations page, each installation in `GithubPanel` that is not stopped has an outline "Disconnect"
button for admins. It sits on its own row under the scope line (`.installation-actions`), with a Tabler Outline
`IconPlugConnectedX` at 18 px, and its accessible name is "Disconnect <account>". Members get no control and a hint
instead ("Only a workspace admin can disconnect…"). The server answers 403 to a member in any case, and so does the
a11y mock server. The setup flow's `GithubStep` reuses `Installation` without the control.

**Confirmation.** `DisconnectDialog.tsx` uses the alert-dialog pattern of `RemoveMemberDialog`:

- focus starts on "Keep connected", Tab is trapped, and Escape closes and returns focus to the trigger;
- only the danger "Disconnect" button sends `POST /api/github/installations/:id/disconnect?org=…`;
- the description has four 16 px paragraphs (`.disconnect-body`): what stops (at once; integrations paused, the
  reason in the audit log), what is kept (destinations and their webhook settings), what this does not do
  (uninstall the App on GitHub), and how to connect again (uninstall, then install);
- below it is a link to GitHub's installation settings for the account, built by `githubAccessUrl` from
  `RepoPicker.tsx`, the URL pattern the picker already uses. It opens in a new tab with `noopener`;
- a refusal stays in the dialog as an error `Notice`.

**After.** The dialog closes with focus on the panel heading (`tabIndex=-1`, through `finalFocus`), because the
trigger is gone. A success `Notice` names the account and how many integrations were paused (plural-aware), and
the connection, integration and setup queries are read again. The installation's badge reads "Disconnected"
(`github.status.uninstalled`, which was "Uninstalled"). The schema cannot tell a disconnect from an uninstall on
GitHub, so its note names both causes and says how to connect again, with the same GitHub settings link. The
audit log shows the new `github.installation.disconnect` action. The paused integrations' `integration.update`
rows show "Reason: GitHub was disconnected".

**Glass and surfaces.** None: the control and the dialog are on opaque reading surfaces (the panel card and the
modal), as `DESIGN.md` requires.

**Copy.** `github.disconnect.*`, `github.uninstalled.again`, `github.settingsLink` and
`github.return.installation_disconnected` are in `messages.{en,vi}.ts`. `audit.action.github.installation.disconnect`,
`audit.detail.{previousStatus,pausedIntegrations,overflow}` and `audit.value.github_disconnected` are in
`messages.audit.{en,vi}.ts`.

Verified: jsdom with axe in English and Vietnamese (`dialogs.a11y.test.tsx`, "disconnect GitHub"): the dialog's
focus contract, the four parts and the link target, the request path, the stopped state after it, focus on the
heading, and a member's view. The catalogue, hard-coded-string and stylesheet tests also pass. **Not verified:** a
real browser at 320 px or desktop, a screen reader, a native-speaker review of the Vietnamese, and a real GitHub
App.

## Current truth

Signup, sign-in, verify, forgot/reset, sign-out, `/me`, onboarding, invitations and team
membership are wired to the Better Auth API. Email delivery is configured but unverified
against real providers.

Integrations (list, create, edit, pause, credential replacement, delete) and the GitHub
connection panel are wired to the real API and were exercised against a local Worker; see
ADR 0007 for what that does and does not prove.

The delivery log (`/activity`), manual redelivery, workspace export and two-phase deletion are
wired to the real API (ADR 0009). Microsoft Teams, Discord and a custom webhook can be chosen in
the create wizard (ADR 0014); the two newest have **not** had a browser pass.

Routing filters (settings section, create-wizard step, "Try it", recent decisions) are wired to
the real API. They have **not** had a browser pass: reflow at 320 px, keyboard order, contrast
and Vietnamese diacritics are open.

Quiet hours and summaries (settings section) are wired to the real API and are covered by jsdom
and axe tests only: no browser pass yet.

Accessibility and Vietnamese (slice 6c, ADR 0013): every route, wizard step, dialog and error
state is scanned by axe-core in the tests and in a real browser; the shell announces route
changes and manages focus; the interface can be switched between English and Vietnamese. No
screen reader has been run and no conformance level is claimed.

Test send and setup progress (slice 6d, ADR 0018) are wired to the real API; see "Not verified" for what the browser pass did not cover.

The workspace switcher and the admin-only audit log (`/audit`) are wired to the real API (ADR 0019)
and had a browser pass in Chrome at 1280 and 320 px in Vietnamese against a local Worker and D1 with
two workspaces; no screen reader, Firefox or Safari.

**Not implemented:** scheduled re-tests, a payload preview or provider status in the test result, per-attempt history and bulk replay.
Passkeys register and authenticate but have not been acceptance-tested for counter
regression.

Nothing on any screen claims a connector is production-ready, and no metric is invented to
make a screen look complete. `docs/PRODUCT.md`'s "median setup under 5 minutes" and
"80% of 10 users" remain **unmeasured hypotheses**, not results.

## Routing and deployment (TanStack Start, ADR 0017)

The dashboard is a **TanStack Start app in SPA mode**: the build prerenders one document,
`web/dist/client/_shell.html` (an empty paper-coloured screen plus the bootstrap scripts), and
the browser renders every route. Start's React server rendering, server functions, server routes
and middleware are **not used**, and in production nothing renders React on the server.

One Worker (`src/worker.ts`) serves everything:

| Request | Handled by |
| --- | --- |
| `/api/*`, `/webhooks/*`, `/github/*`, `/health` | the Hono app (`src/index.ts`), middleware unchanged |
| `/assets/*` and other files | the static assets layer, with `web/public/_headers` |
| any other `GET`/`HEAD` (including dotted paths that are not a known static extension) | the shell, via `src/web/shell.ts`, with the SPA headers |
| `scheduled`, `queue` | the handlers exported by `src/index.ts` |

**Content-Security-Policy.** Start emits two small inline bootstrap scripts into the shell. The
policy stays free of `'unsafe-inline'`: the Worker hashes each inline script in the document it
serves (as the browser will parse it) and adds `'sha256-…'` to `script-src` for that response only
(`tests/web/shell.test.ts`). `style-src` needs nothing inline.

**The rule for new server-side work.** State-changing work goes through the Hono API, where the
central same-origin check (`src/security/csrf.ts`) and tenant authorisation apply. Do not add Start
server functions, server routes or middleware: they would bypass both. `tests/web/start-boundary.test.ts`
fails if `web/src` imports `@tanstack/react-start`. In a deployment Start's handler is unreachable:
the Worker calls it only for `vite dev` and for the build's prerender request (header
`X-TSS_SHELL: true`, loopback host, no built shell yet), proven by `tests/web/worker.test.ts`.

Deploy with `npm run deploy` (`build:web`, then `wrangler deploy --config web/dist/server/wrangler.json`).
Set the custom domain, origin policy, secure cookies, D1, Queue and outbound transactional email
before public use. Rollback: see ADR 0017.

## Revoke and fingerprint (ADR 0036, `web/src/integrations/settings/`)

The credentials section of an integration shows the webhook's **fingerprint** (monospace, keyed and tenant-scoped, with a line saying it is
not the URL, or why there is none), a `Revoked` badge, and for a revoked integration whether the encrypted copy is destroyed or being
destroyed. `RevokeDialog` is an alert dialog like the delete one (focus starts on Cancel; Escape and Tab are tested) with the destination
radio cards reused for three fixed reasons (`compromised`, `no_longer_used`, `other`), no typed phrase (a new URL restores everything but
the burned one), and a plain consequence sentence. On success the replace form opens and a status region says what happened. `CredentialsNotice`
has a revoked variant; the delivery detail shows the integration's current fingerprint; `redeliver.integration.revoked` explains why no
redelivery is offered. Controls are 44 px, the dialog uses the existing opaque modal surface, strings are in `messages.en.ts` and `messages.vi.ts`
(including the audit labels `key_destroyed`). Role: the button is shown to admins only (`useCanRevoke`); the server still answers 403
for a member.

Sources ([ADR 0049](adr/0049-source-revoke-and-fingerprint-in-the-dashboard.md)): `RevokeDialog` takes the mutation and its copy as
props, so the integration (`IntegrationRevokeDialog`) and the source card share one dialog and its focus and Enter rules. Every source card
shows its fingerprint (or why there is none). A revoked source shows a `Revoked` badge, what happened to the encrypted copy (destroyed,
being destroyed, or kept until an operator destroys it when there is no fingerprint), a red-rail notice naming the way back, and a receiving
switch that is off, `aria-disabled` and says why. The revoke control is admin-only beside Rotate and Delete and is gone while revoked; after a
revoke a status notice says what happened and focus moves to Rotate, whose dialog then says the source is turned back on. GitLab and Stripe
sources are worded for a pasted credential. Strings in `messages.en.ts` and `messages.sources.vi.ts`.

## Design-token drift and no fabricated numbers (ADR 0038, `web/src/design/`)

- **Drift.** `tokens.drift.test.ts` reads the fenced ```css blocks under DESIGN.md §5 (colour), §6.1 (type stacks),
  §7 (spacing), §8.1 (radii), §8.3 and §8.4 (elevation and glass), and the §8.2 and §13 sentences, and asserts that
  the top-level `:root` of `web/src/styles.css` resolves to the same values. A token may be declared once only. The
  two exceptions are named in the test: the bundled family `Geist Variable` leads the sans stack, and
  `--color-control-border` aliases Soft Slate. Edit a value in one place and the other must follow in the same change.
- **No fabricated numbers.** `no-fake-numbers.test.ts` scans `web/src` TSX (not tests or `a11y/testing`) for digits in
  rendered text, numeric literals rendered as children, and `?? 0` or `|| 0` fallbacks. A finding must be allow-listed
  with a reason, and a stale entry fails. The Overview's "last 24 hours" labels are the server's fixed summary window
  and are checked against `SUMMARY_WINDOW_MS`. A new figure comes from a query; while that query is loading or has
  failed, the screen shows a dash (`DeliveryStats.tsx`, `IntegrationsStat.tsx`).
- **Empty sections.** The empty state's body copy is 16px (`.empty p`), the minimum for body text.
- **No logging of the address (ADR 0053, spec 02 F16).** `web/src/lib/no-email-logging.test.tsx` reads every
  non-test source file in `web/src` (not `a11y/testing`) as a TypeScript syntax tree and fails on any reference to
  `console`, any `sendBeacon`, a call on a known analytics or error-reporting global, or an import of a known
  analytics or logging package. There is no allowlist: the client has no logging call. It also types an address into
  the sign-in (refused and accepted), sign-up and forgot-password forms with every console method spied, and fails if
  the address reaches the console, a beacon or any request URL. No screen changed; this is a test-only rule.

## Not yet verified

- GitHub disconnect (ADR 0058): jsdom, axe (en and vi) and unit tests only. No browser pass at 320 px or desktop (the installation row gains one button; its wrap at 320 px is unverified), no screen-reader pass, no screenshot, no real GitHub App.

- Request ID in the detail dialog and the activity filter, and the pause and delete impact counts (ADR 0050): jsdom, axe (en and vi) and unit tests only. No browser pass at 320 px or desktop, no screen-reader pass, no screenshot, and the counts' cost was not measured on a real D1.

- Shared loading and empty states on the four lists, the 16px empty-state body and the drift and number checks (ADR 0038): jsdom, axe (en and vi) and unit tests only. No browser pass at 320 px or desktop, no screen-reader pass.

- Revoke dialog and fingerprint (ADR 0036): jsdom, axe (en and vi) and unit tests only. No browser pass at 320 px or desktop, no real-contrast check of the new radio list, no screen-reader pass, no screenshot.

- Source revoke and fingerprint (ADR 0049): jsdom, axe (en and vi) and unit tests only. No browser pass at 320 px or desktop (a revoked card adds two facts and a notice; its reflow is unverified), no screen-reader pass, no screenshot.

- Slice 6f (setup flow, shell, settings sections): see the browser record in `docs/adr/0025-setup-and-shell-ux.md`. Not exercised anywhere: the GitHub connect round trip with a real App, a real provider accepting a test from the setup flow, screen readers, Safari and Firefox, a real 320px run in CI.

- Slice 6d (test send, setup progress): no screenshot was taken and no real provider accepted a test; the success, accepted and failed panels, the wizard's "Test it" step, keyboard order and contrast have only jsdom and axe coverage. See `docs/PROGRESS.md`, "Slice 6d: browser verification".

The integrations, delivery log and workspace screens were checked in a real browser at 320, 375
and 1280 px (ADR 0007, 0009). Slice 6c re-ran axe-core in a real browser (colour contrast
included) on the shell, wizard, settings, activity, team and sign-in screens in English and
Vietnamese, walked the wizard by keyboard, and checked 320 px and an emulated 200% zoom (ADR
0013).

The Discord and custom-webhook screens (picker, setup steps, validation messages, the one-time
secret reveal, rotation) were checked through types, lint and unit tests only: no browser pass at
320 px or desktop, no keyboard or screen-reader walkthrough, no contrast check and no Vietnamese
rendering. The reveal moves focus to itself on mount, as the sources reveal does, but that has
not been observed.

The integrations screens were checked in a real browser at 320, 375 and 1280 px against a
local Worker (ADR 0007). The rest of the app has not had a browser pass in this record.

Still open: **no screen reader pass**; reduced-motion, reduced-transparency, increased-contrast
and forced-colours were **tested in the stylesheet only, not seen in a browser**; one Chromium
build only; native select pop-ups were not keyboard-driven; the delivery detail dialog was
scanned in jsdom but not in a browser pass; the Vietnamese copy has had no native-speaker
review. See the ADR for the full record.
