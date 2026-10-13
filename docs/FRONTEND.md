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

ESLint is **type-aware**. The web rules set `no-unsafe-*` to `warn` because dashboard APIs that
do not exist yet still return loosely-typed shapes; the Worker rules set them to `error`,
because a webhook body is untrusted input and `JSON.parse` returning `any` is the defect class
that produced `00-current-state.md` D3.

## Pages

`/signup` `/signin` `/forgot-password` `/verify` `/reset` ·
`/` (overview) `/integrations` `/integrations/new` `/integrations/:id` `/activity` `/team`
`/settings` `/onboarding` `/invite`

## Integrations feature (`web/src/integrations/`)

Decisions and verification: [ADR 0007](adr/0007-integrations-ux.md).

| Path | Role |
| --- | --- |
| `IntegrationsPage.tsx`, `IntegrationCard.tsx`, `EnabledSwitch.tsx` | List, card, optimistic pause/resume with rollback |
| `github/` | Connection panel, `?github=` return messages, repository picker, coverage rules |
| `wizard/` | Five-step create flow; `draft.ts` holds the pure step logic |
| `settings/` | Per-integration screen: details form, credential replacement, delete dialog |
| `validation.ts` | Client checks mirroring `src/api/integration-input.ts` (imports the Worker allowlist) |
| `events.ts` | Plain-language label map keyed by `src/connectors/sources/github/catalog.ts` |
| `../i18n/` | Message catalogue and `t()`/`tp()`; new screens add ids, not literals |
| `../components/form.tsx` | `Field` (label, hint, linked error), `SecretInput`, `focusFirstInvalid` |

Rules this feature follows: webhook URLs and signing secrets are write-only (masked input with
a show toggle, never pre-filled, never echoed); a failed query is an error state, not an
empty list; field errors sit next to the field and the first invalid control takes focus;
destructive confirmation focuses the cancel button. `npm test` runs
`web/src/integrations/integrations.test.ts` with the Worker tests.

## Current truth

Signup, sign-in, verify, forgot/reset, sign-out, `/me`, onboarding, invitations and team
membership are wired to the Better Auth API. Email delivery is configured but unverified
against real providers.

Integrations (list, create, edit, pause, credential replacement, delete) and the GitHub
connection panel are wired to the real API and were exercised against a local Worker; see
ADR 0007 for what that does and does not prove.

**Not implemented:** delivery history, replay, test send, and the API behind the `/activity`
table — those screens show explicit placeholders. Passkeys register and
authenticate but have not been acceptance-tested for counter regression.

Nothing on any screen claims a connector is production-ready, and no metric is invented to
make a screen look complete. `docs/PRODUCT.md`'s "median setup under 5 minutes" and
"80% of 10 users" remain **unmeasured hypotheses**, not results.

## Deployment

The frontend builds to `web/dist`. Deploy with SPA fallback, routing `/auth` and `/api` to the
Hono API on the same origin. Set the custom domain, origin policy, secure cookies, D1, Queue
and outbound transactional email before public use. **Do not use the Vite dev proxy as a
production gateway.**

## Not yet verified

The integrations screens were checked in a real browser at 320, 375 and 1280 px against a
local Worker (ADR 0007). The rest of the app has not had a browser pass in this record.

Rendered 320px reflow, Vietnamese typography, and WCAG conformance were **inspected in source,
not in a browser** — no browser was available in the environment that produced this document.
Treat those as open. See the ADR for the full verification record.