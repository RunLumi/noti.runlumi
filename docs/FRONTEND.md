# Lumi Noti frontend

> Design authority: [`DESIGN.md`](../DESIGN.md). Rationale and acceptance:
> [`adr/0002-noti-design-system.md`](adr/0002-noti-design-system.md).

## Stack

Vite + React 19 + TypeScript, Tailwind 4, Base UI headless Dialog, TanStack Router / Query /
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

1. `npm install`
2. `npm run dev` — Worker on :8787 (needs local D1 and bindings)
3. `npm run dev:web` — UI on :5173; `/auth` and `/api` proxy to the Worker
4. `npm run typecheck:web` and `npm run build:web`

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
| `i18n/messages.vi.ts`, `messages.app.vi.ts` | Vietnamese catalogue, typed against English |
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
- **A new route** goes in `main.tsx` *and* in `ROUTE_PATHS` / the router in
  `a11y/testing/render.tsx` plus an axe scenario in `pages.a11y.test.tsx`; a route test fails
  until all three agree. It also needs a title in `a11y/route-titles.ts`.
- **A new dialog** needs an axe scan with it open and the focus contract: focus on the safe
  control, Tab cannot leave, Escape closes, focus returns to the trigger (see
  `dialogs.a11y.test.tsx`).
- **Text-field edges use `--color-control-border`** (Soft Slate, 3:1); the archival border is
  for sheets and rows.
- Switching language remounts the routed tree (`LocaleProvider`), so an unfinished form loses
  its values; the URL, session and query cache survive.

## Pages

`/signup` `/signin` `/forgot-password` `/verify` `/reset` ·
`/` (overview) `/integrations` `/integrations/new` `/integrations/:id` `/sources` `/activity` `/team`
`/settings` `/onboarding` `/invite`

## Delivery log and workspace data (`web/src/deliveries/`, `web/src/workspace/`)

Decisions and verification: [ADR 0009](adr/0009-delivery-log-ux.md).

| Path | Role |
| --- | --- |
| `deliveries/DeliveryLogPage.tsx` | `/activity`: filters, table, load more, empty/error/loading states |
| `deliveries/DeliveryTable.tsx` | TanStack Table; rows stack into labelled cards at narrow widths |
| `deliveries/DeliveryDetail.tsx`, `RedeliverPanel.tsx` | Detail dialog, plain-language cause, admin-only confirmed redelivery |
| `deliveries/DeliveryStats.tsx` | Overview figures from `GET /api/deliveries/summary` (last 24 hours, counted not estimated) |
| `deliveries/search.ts`, `api.ts`, `copy.ts` | URL-backed filters, strict response parsing, state and error copy |
| `workspace/` | Settings: credential-free export download and two-phase workspace deletion |

## Integrations feature (`web/src/integrations/`)

Decisions and verification: [ADR 0007](adr/0007-integrations-ux.md).

| Path | Role |
| --- | --- |
| `IntegrationsPage.tsx`, `IntegrationCard.tsx`, `EnabledSwitch.tsx` | List, card, optimistic pause/resume with rollback |
| `github/` | Connection panel, `?github=` return messages, repository picker, coverage rules |
| `wizard/` | Six-step create flow (filters are optional); `draft.ts` holds the pure step logic |
| `filters/` | Routing filters ([ADR 0010](adr/0010-routing-filters.md)): `model.ts` (lines to API shape, error mapping, "Try it"), `FiltersEditor`, `FilterTester`, `RoutingLog` |
| `settings/` | Per-integration screen: details form, filters, credential replacement, delete dialog |
| `validation.ts` | Client checks mirroring `src/api/integration-input.ts` (imports the Worker allowlist) |
| `events.ts` | Plain-language label map keyed by `src/connectors/sources/github/catalog.ts` |
| `../i18n/` | Message catalogue and `t()`/`tp()`; new screens add ids, not literals. Filter copy is in `messages.filters.en.ts`, merged into `en` |
| `../components/form.tsx` | `Field` (label, hint, linked error), `SecretInput`, `focusFirstInvalid` |

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

## Sources feature (`web/src/sources/`)

Decisions and verification: [ADR 0012](adr/0012-generic-source.md). It reuses the integrations
sheet, switch, field, destination-choice and dialog styles and the `validation.ts` URL policy.

| Path | Role |
| --- | --- |
| `SourcesPage.tsx` | `/sources`: create form, one-time secret reveal, list, empty / error / loading states |
| `SourceCard.tsx` | Endpoint URL with copy, last event, connected chats, pause switch, actions |
| `SecretReveal.tsx`, `CopyButton.tsx` | One-time secret (persistent warning, focus moves in, explicit dismiss); copy with a stated outcome and a manual-copy fallback |
| `SourceDialogs.tsx` | Rotate (states the cutover) and delete (typed name, states the chats deleted with it); focus starts on the safe choice |
| `ConnectChat.tsx`, `connect.ts` | Connect a Lark, Slack or Teams chat to a source; pure validation mirrors `src/api/integration-input.ts` |
| `Guidance.tsx`, `snippets.ts` | Event format and signing explanation; shell and Node examples that read the secret from `NOTI_SIGNING_SECRET` |
| `api.ts`, `hooks.ts` | Strict response parsing; mutations that return a secret use `gcTime: 0` and never write the query cache |

Rules this feature adds: the signing secret lives only in component state and is gone on
dismissal or navigation (no storage, URL, cache or console; a test greps for this); it is never
placed in a copyable example; status is always text, not colour alone. Rotate and delete are shown to workspace admins only (the server enforces it); a card shows "N events were rejected because their id was reused" when a sender reuses webhook-ids. Integrations bound to a
source show "Events from your own system" instead of a repository, and their settings page
explains that updates cannot be chosen. `web/src/sources/sources.test.ts` runs the shell and
Node examples and checks their output with the Worker's verifier. **Not verified:** a browser
pass at desktop and 320 px, keyboard and screen-reader walkthrough, contrast and Vietnamese
rendering of the new screens; they were checked only through types, lint and unit tests.

## Current truth

Signup, sign-in, verify, forgot/reset, sign-out, `/me`, onboarding, invitations and team
membership are wired to the Better Auth API. Email delivery is configured but unverified
against real providers.

Integrations (list, create, edit, pause, credential replacement, delete) and the GitHub
connection panel are wired to the real API and were exercised against a local Worker; see
ADR 0007 for what that does and does not prove.

The delivery log (`/activity`), manual redelivery, workspace export and two-phase deletion are
wired to the real API (ADR 0009). Microsoft Teams can be chosen in the create wizard.

Routing filters (settings section, create-wizard step, "Try it", recent decisions) are wired to
the real API. They have **not** had a browser pass: reflow at 320 px, keyboard order, contrast
and Vietnamese diacritics are open.

Accessibility and Vietnamese (slice 6c, ADR 0013): every route, wizard step, dialog and error
state is scanned by axe-core in the tests and in a real browser; the shell announces route
changes and manages focus; the interface can be switched between English and Vietnamese. No
screen reader has been run and no conformance level is claimed.

**Not implemented:** test send, the setup-progress model, per-attempt history and bulk replay.
Passkeys register and authenticate but have not been acceptance-tested for counter
regression.

Nothing on any screen claims a connector is production-ready, and no metric is invented to
make a screen look complete. `docs/PRODUCT.md`'s "median setup under 5 minutes" and
"80% of 10 users" remain **unmeasured hypotheses**, not results.

## Deployment

The frontend builds to `web/dist`. Deploy with SPA fallback, routing `/auth` and `/api` to the
Hono API on the same origin. Set the custom domain, origin policy, secure cookies, D1, Queue
and outbound transactional email before public use. **Do not use the Vite dev proxy as a
production gateway.**

## Not yet verified

The integrations, delivery log and workspace screens were checked in a real browser at 320, 375
and 1280 px (ADR 0007, 0009). Slice 6c re-ran axe-core in a real browser (colour contrast
included) on the shell, wizard, settings, activity, team and sign-in screens in English and
Vietnamese, walked the wizard by keyboard, and checked 320 px and an emulated 200% zoom (ADR
0013).

Still open: **no screen reader pass**; reduced-motion, reduced-transparency, increased-contrast
and forced-colours were **tested in the stylesheet only, not seen in a browser**; one Chromium
build only; native select pop-ups were not keyboard-driven; the delivery detail dialog was
scanned in jsdom but not in a browser pass; the Vietnamese copy has had no native-speaker
review. See the ADR for the full record.
