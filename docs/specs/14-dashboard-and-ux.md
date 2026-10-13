# 14 — Dashboard & User Experience

> External references read **2026-10-13**. Provider facts are cited to
> `docs/DESTINATION_API_REFERENCE.md`, which is the source of record. Competitor facts are cited
> to `docs/specs/COMPETITIVE-FEATURE-SET.md`.
>
> **No usability result in this file has been measured.** The two numbers in
> `docs/PRODUCT.md` — median setup under 5 minutes, and ≥80% of 10 new users completing a first
> delivery without developer help — are **hypotheses written into a success-thresholds section
> that is explicitly labelled "initial hypotheses, not measured"**. They are the *target* this
> file is designed to let us test. Nothing in this file asserts that either is achievable, and
> no screen, flow or number here may be presented externally as evidence until F226 has run.

**This file implements the design and brand contract in `AGENTS.md` and does not restate it.**
`DESIGN.md` is the authoritative visual system and governs where the two overlap: exact Lumi
colours, the warm Paper White canvas, opaque evidence sheets, Civic Navy headings, self-hosted
Geist, Tabler Outline iconography, spacing and geometry. The original assets in `brand/` are
used as-is. F206 binds this file to `DESIGN.md`; F221, F223 and F224 add the accessibility,
mobile and Vietnamese obligations that contract imposes. Where this file names a value
(`44 px` controls, `320 px` reflow) it is consistent with `AGENTS.md`'s contract, and
`DESIGN.md` wins if the two ever disagree. Every UI change made against this file must record
its decisions and verification in `docs/adr/` and `docs/FRONTEND.md`.

## Why the dashboard is not a view layer

`AGENTS.md` asks for "accessible, readable contrast, responsive mobile UX, clear errors and
translated-ready strings" as *engineering invariants*. This file treats them as the **product**.
The product wedge is GitHub → Lark/Slack/Teams, but the thing a non-technical user actually
buys is the ten minutes where they connect GitHub to a chat channel. The dashboard is the
product; the Worker is the supply chain.

Two structural facts about the code we own constrain everything below:

- `web/src/pages.tsx` currently renders `—` in every stat, `"Not yet connected to live API"`
  underneath them, `"Preview"` in the top bar, and a notice saying *"Connection creation is not
  enabled yet."* That is **the correct pattern and it is the house standard**, not a placeholder
  to be removed. F206 fixes it as a rule.
- `web/src/pages.tsx:12` renders six source cards, four of which are labelled `Planned`, with no
  affordance and no link. That is the shape `AGENTS.md` forbids — *"No AI slop, fake screenshots,
  unsupported claims or placeholder connectors advertised as working."* F206 decides what replaces
  it.

## What this file does not do

- **It does not close any D-series defect.** D1–D16 (`00-current-state.md`) are server-side and
  are closed by specs 01–12. D2 (no tenant boundary) and D3 (routing on `repo` from the request
  body) are the two defects between this repo and a shippable product, and no amount of frontend
  work touches them. **The dashboard must not be used as a reason to defer them.**
- **It does not duplicate grouping/noise (F141–F168), destination capabilities (F91–F104) or
  reliability (F169–F190).** Where this file touches those surfaces it renders them; the
  behaviour lives there.

## ID reconciliation

Earlier specs reference features in this file's range. This file owns them:

| ID | Earlier reference | Owned here as |
| --- | --- | --- |
| F213 | `07:F100/F149/F164/F185` dep — "error surfacing in the dashboard" | Delivery log |
| F216 | `07:F98` dep "(onboarding)"; `00-current-state.md:N3` "blocks F216" | Setup wizard shell |
| F222 | `05:F68` dep — "every lifecycle transition writes an `audit_events` row (F222)" | Audit trail (write trigger **and** read side) |

Two dangling references are left as-is rather than silently renumbered:
`01:F13` says "Blocks F08, **F20** (error surfacing in the dashboard)" — `F20` is *Passkeys*
(`02:F20`). The intended target is **F220**. And `11` references **F233** for
billing-on-messages-sent, which lives outside both of this session's ranges and is owned by
`docs/specs/16-ai-and-roadmap.md`'s sibling billing work; `16:F253` restates it.

---

## F205 — Information architecture and navigation

**Priority** P0 · **Status** not started

**Story** As a person who does not work with developer tools, I want to find the one thing I
came for, so that I never have to guess where something is.

**Acceptance**

- [ ] The product answers exactly three questions, and every screen belongs to one:
      | Question | Screens |
      |---|---|
      | **Is it working?** | Overview, Destinations health, Delivery log, Dead letters |
      | **What did I get?** | Activity (events), Delivery log, Preferences ("what will I receive") |
      | **How do I change it?** | Setup wizard, Integrations, Preferences, Settings, Team, Audit |
- [ ] Primary navigation is **at most six items at 1280 px**, and a first-run workspace never
      shows a destination it cannot use. Final set: `Overview · Integrations · Activity ·
      Destinations health · Team · Settings`, with setup state surfaced *on* Overview rather
      than as a seventh nav item.
- [ ] ⭐ **Routes are deep-linkable and survive a refresh.** Every state a user can reach is a
      URL. The GitHub install callback, the Teams/Lark return links and a support reply all
      resolve to a working deep link. Today `web/src/pages.tsx` guards private routes with
      `privatePaths.includes(pathname)` — an exact-match array. Adding a route requires editing
      that array, which is a bug factory. **A route-not-matched inside the shell must render the
      404 screen, not redirect to `/`.**
- [ ] The wizard is a **route space** (`/setup/...`), not a modal, a drawer or a wizard component
      with internal state. A modal wizard cannot be resumed, shared or linked.
- [ ] Breadcrumbs exist on every page below the top level and are `aria-label`ed; the top bar
      currently renders the raw pathname (`pathname.slice(1)`) as a label, which produces
      "Activity" as an h-next and is not a breadcrumb at all.
- [ ] Every screen has **one** primary action. The current `Overview` has two competing CTAs
      (`Explore integrations` in the header, plus three unnumbered steps in a panel).
- [ ] A first-run workspace with zero integrations gets a **guided Overview** (the "next step"
      surface, F207) instead of a stat grid of em-dashes.

**Design** — Six destinations is not a lot of screens, and that is a constraint we should spend.
The failure mode in the competitor set is not "too few screens", it is that a user cannot tell
which screen answers their problem. The grouping above is a **decision procedure**, not a menu
organiser: if a new screen cannot be placed in one of the three questions, it is either a modal
of an existing screen or a sign the feature is not earning its place.

**Schema** — routes are declared in `web/src/main.tsx:8-20`; the guard becomes a matcher on the
router, not an array:

```ts
// web/src/lib/guard.ts
export function isShellRoute(pathname: string): boolean {
  return pathname === "/" ||
         pathname.startsWith("/integrations") ||
         pathname.startsWith("/setup")   ||
         pathname.startsWith("/activity") ||
         pathname.startsWith("/destinations") ||
         pathname.startsWith("/team") ||
         pathname.startsWith("/settings") ||
         pathname.startsWith("/audit");
}
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Authenticated, no workspace, any non-`/onboarding` route | Redirect to `/onboarding` (existing behaviour) |
| Authenticated, has workspace, on `/onboarding` | Redirect to `/` (existing behaviour) |
| Unauthenticated on a shell route | Redirect `/signin?returnTo=<full path+query>` |
| Unmatched route inside the shell | Render 404 with a link to Overview — **never** a silent redirect |
| Unmatched route outside the shell | Same 404, no shell chrome |

**Security** — `returnTo` must be a **path-relative** value. An open redirect on a sign-in
handoff is the cheapest account-takeover path in a product with email invites; only accept
`returnTo` that begins with `/` and not `//`, and resolve it against `location.origin`.

**Tests**
- `shell_route_guard_does_not_require_editing_an_array`
- `unmatched_route_renders_404_instead_of_redirecting_to_overview`
- `every_navigation_item_resolves_to_a_real_route`
- `return_to_rejects_protocol_relative_urls`
- `breadcrumbs_are_labelled_and_reflect_the_route`

**Deps** — F14 (authenticated shell), F216.

---

## F206 — Design system, and the no-fake-anything rule

**Priority** P0 · **Status** not started

**Story** As a user, I want the interface to tell me the truth about what exists, so that I
never act on a promise the product has not kept.

**Acceptance** — the following are **hard rules**, each with a test:

- [ ] **No fabricated numbers.** Every displayed figure is read from an API. The existing
      `—` + "Not yet connected to live API" treatment is retained wherever the backing query
      does not exist, and there is **no path** in the codebase that renders a statistic, chart
      or count that is not derived from a response.
- [ ] **No fabricated screenshots.** No image of a product state may exist unless it was
      captured from the running product (see F212 for the capture pipeline and the
      `captured_at` contract).
- [ ] **No selectable-looking thing that is not selectable.** The `Planned` connector cards in
      `web/src/pages.tsx:12` are replaced by a single non-interactive line —
      *"More sources and destinations are on the roadmap. We do not list integrations we cannot
      connect today."* — with no card, no icon tile and no hover state. A card is an affordance;
      a dead affordance is a broken promise.
- [ ] **No "coming soon" inside a flow.** If a capability exists in the data model but not in
      the product, the control is absent — not disabled-with-a-tooltip, not greyed.
- [ ] ⭐ **Feature-flagged surfaces are labelled.** Where a surface ships dark, it carries the
      existing `Preview` badge (`web/src/pages.tsx:7`) and the badge is removed in the same
      release that turns the surface on. A badge that outlives its flag is worse than none.
- [ ] Tokens are the single source for: colour, type scale, spacing, radius, shadow, motion
      duration, focus ring. Current state: `web/src/styles.css` (9.9 KB) holds raw values and
      `web/src/components/ui.tsx` holds `Card`, `Button`, `Input`, `Badge`. Anything hard-coded
      is a F221 contrast failure waiting to happen.
- [ ] ⭐ **`DESIGN.md` is the source of record for every visual token.** F206 does not invent a
      palette, a type scale or a radius. The bound values:
      | Token group | Contract (`DESIGN.md` / `AGENTS.md`) |
      |---|---|
      | Canvas | warm **Paper White**; light only, **no dark theme** |
      | Headings | **Civic Navy**, never black |
      | Reading surfaces | **opaque** evidence sheets; glass is never a reading surface |
      | Glass | floating header and one workflow navigation dock **only**, with a reduced-transparency and a `forced-colors` fallback; never nested |
      | Type family | self-hosted **Geist** (variable Latin + Vietnamese subsets, `font-display: swap`), `Geist Mono` for technical fragments only |
      | Body text | **≥16 px**; metadata **≥12 px**; controls **≥44 px** tall |
      | Icons | **Tabler Outline**, 24×24 grid, 20–24 px ordinary / 16 px compact metadata, one outline family, no mixing with filled icons |
      | Radius / borders / elevation | §8 of `DESIGN.md`; no local overrides |
- [ ] ⚠️ **Open conflict, must be resolved in an ADR before F206 lands.** `package.json` depends
      on `lucide-react` and `web/src/pages.tsx` imports ~20 icons from it. `DESIGN.md` §10 names
      **Tabler Outline** as the geometric foundation and forbids mixing families. Tabler is **not
      a drop-in replacement** for the used subset: stroke width, `size`/`strokeWidth` prop
      shapes and a handful of icon names (`Webhook`, `ActivityIcon`, `GitBranch`) do not map
      one-to-one. The decision to swap families, and the decision to stay on Lucide and amend
      `DESIGN.md`, are both legitimate — **silently mixing them is not**, and neither is
      pretending the swap is mechanical. Record the choice in `docs/adr/`.
- [ ] The logo assets in `brand/` are imported into the Vite app so builds fingerprint them.
      **Do not redraw, recolor, stretch or substitute** a generic icon for the Lumi mark. Use
      `lumi-black-*` on Paper White and `lumi-white-*` **only** on Civic Navy contexts. Current
      `web/src/pages.tsx:7` draws the brand as `<span className="brand-mark"><Zap
      strokeWidth={2.8}/></span>` — a Lucide lightning bolt standing in for the Lumi mark. That
      is precisely the substitution `AGENTS.md` forbids and it is replaced by the real asset.
- [ ] `DESIGN.md` §9 is **landing-oriented**. Its company/product narrative, hero flow and email
      CTA are **not** requirements for the authenticated app. The authenticated dashboard keeps
      Noti's real workflows and its honest prototype/planned labels, and **never simulates a
      live run or a chat input** to make a screen look complete — this is F206's rule applied
      with `DESIGN.md` §9's own wording.
- [ ] Component inventory is closed and each has a documented state matrix:
      `Button (default/outline/ghost/danger · hover/focus/active/disabled/loading)`,
      `Card`, `Input` (+`select`, `textarea`, `checkbox`, `switch`), `Badge`
      (`neutral/success/warning/danger/info`), `Notice` (currently a local component in
      `web/src/pages.tsx:5` — it must be promoted into `components/ui.tsx` because F225 and
      F220 depend on it), `Skeleton`, `EmptyState`, `Toast`, `Dialog`, `Tooltip`,
      `DataTable`, `Pagination`, `Stepper`, `CodeBlock`.
- [ ] ⚠️ Icon-only controls **must** carry an accessible name. `web/src/pages.tsx:10` renders
      `<Plus size={16}/> Explore integrations` and `<ActivityIcon/>` — both fine — but the
      `stat`/`benefit` rows rely on icons adjacent to text that is **not** in the accessible
      name of anything. Every icon-only affordance introduced by F208–F219 must pass
      `has-accessible-name`.
- [ ] **Icon set is one set.** Lucide is already a dependency (`lucide-react` in `package.json`).
      No destination logo may be hand-drawn or emoji-substituted; provider marks are vendored
      SVG assets with correct `viewBox` and `alt`.

**Design** — The em-dash discipline is cheap, unglamorous, and the single highest-leverage
decision in this file. `AGENTS.md` bans "fake screenshots, unsupported claims or placeholder
connectors advertised as working"; the way that ban is enforced is not a style guide, it is a
test suite that fails the build when a literal appears where data should be. A design system
whose primary job is *honesty about absence* is the correct system for a product whose defining
promise is "we will tell you when your notification failed".

The trade-off is real and should be stated in the PR that implements F206: this will make
pre-launch demos look emptier than the competition's landing pages. A dashboard with three
honest em-dashes converts worse and **trusts better**, and the `ROADMAP.md` gate is an
unassisted-setup study, not a signup funnel. Do not trade this for polish.

**Schema** — the token module is a *transcription* of `DESIGN.md` §5–§8, not a design space.
The literal values below are placeholders for structure; the real values come from that file and
must not be decided here.

```ts
// web/src/lib/tokens.ts — transcribed from DESIGN.md §5–§8; single source, no raw values in components
export const token = {
  color: { paperWhite, surface, surfaceRaised, border, ink, inkMuted,
           civicNavy, success, warning, danger, info, focusRing } as const, // DESIGN.md §5
  type:  { body: '16px', metadata: '12px', control: '44px' } as const,        // AGENTS.md contract
  space: { 0:'0rem',1:'0.25rem',2:'0.5rem',3:'0.75rem',4:'1rem',6:'1.5rem',8:'2rem' } as const,
  radius:{ sm:'…', md:'…', lg:'…' } as const,                                 // DESIGN.md §8.1
  motion:{ fast:'120ms', base:'200ms' } as const,
  material: { readingSurface: 'opaque', navSurface: 'glass' } as const,      // DESIGN.md §4, §8.4
} as const;
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| A stat has no backing query | Render `—` plus the reason, never `0` and never a guess |
| Query failed | Error state from F225, never `—` (an em-dash means "no data", not "broken") |
| Connector not shipped | Absent from the catalogue, or the single roadmap line |
| Surface dark-flagged | `Preview` badge in the top bar |

**Security** — F206 is the layer that makes F120 (redaction) enforceable in the view: a
component that renders a `DestinationConfig` **cannot** receive the ciphertext column because
the type it accepts omits it (F97). Redaction at render time is a fallback, not the mechanism.

**Tests**
- `no_hardcoded_colour_values_outside_the_token_module`
- `token_values_match_design_md_and_fail_when_it_changes`
- `icon_family_is_single_and_matches_the_adr_decision`
- `lumi_brand_assets_are_imported_not_substituted`
- `brand_mark_is_not_a_generic_placeholder_glyph`
- `white_brand_variant_is_used_only_on_civic_navy`
- `glass_is_limited_to_the_header_and_navigation_dock`
- `reading_surfaces_are_opaque_with_a_forced_colors_fallback`
- `body_text_is_at_least_16px_metadata_12px_controls_44px`
- `no_statistic_is_rendered_without_a_backing_query`
- `unbuilt_connectors_are_absent_from_the_catalogue`
- `every_icon_only_control_has_an_accessible_name`
- `notice_is_exported_from_the_component_library`
- `preview_badge_is_absent_when_no_surface_is_dark_flagged`

**Deps** — F14, F121, `DESIGN.md`, `brand/`.

---

## F207 — Setup progress model

**Priority** P0 · **Status** not started

**Story** As someone who got interrupted, I want to be told exactly what to do next, so that I
can finish what I started without remembering what I did.

**Acceptance**

- [ ] Progress is **derived, never client-held**. `GET /api/workspace/setup-state` returns the
      full step list with `status` and the single `next_step`. The browser holds no step state;
      a refresh, a new device, a shared link or an expired session changes nothing.
- [ ] Two machines, because onboarding happens in two places:
      | Scope | Owner | Used for |
      |---|---|---|
      | `workspace_setup` | first source **and** first destination in the workspace | The "get to a working notification" journey |
      | `integration_setup` | each additional source→destination pair | Adding a second repo/channel |
- [ ] Step set is closed and ordered:

```ts
type StepId =
  | 'workspace_created' | 'github_connected' | 'repositories_selected'
  | 'destination_connected' | 'events_chosen' | 'test_delivered' | 'activated';
```

- [ ] Every step carries four fields and nothing else:

```ts
type SetupStep = {
  id: StepId;
  title: string;              // "Connect your GitHub account"
  status: 'done' | 'current' | 'blocked' | 'todo';
  why_this_step: string;      // one sentence, shown before the user starts
  next_action: { label: string; href: string };  // the exact next step, always
  blocking_reason?: 'needs_admin_approval' | 'destination_unverified' | 'no_repository_selected';
};
```

- [ ] ⭐ **A step is `done` only when verified, never when asserted.**
      `github_connected` requires a bound installation row (F56/F57), not a redirect that
      returned. `destination_connected` requires `F98` test delivery success **or** an explicit
      user choice `skip_test` recorded as such — and `skip_test` means the step reports
      *"Not verified — you skipped the test message"*, never a green tick.
- [ ] Exactly **one** step is `current` at any time. Zero current steps + everything done means
      complete; zero current + something incomplete is a bug and raises a metric (F191).
- [ ] Completion = `github_connected && repositories_selected && destination_connected &&
      events_chosen && test_delivered`. `activated` is not required — an integration that is
      verified but deliberately left paused is **complete**, and the wizard must say so rather
      than block the user on a ceremony.
- [ ] Third-party wait is named and excluded from the clock: a step blocked on a Microsoft or
      Lark **admin approval** shows *"Waiting for approval from your Slack/Teams administrator.
      This part is not in your control."* and the F226 timing harness excludes it, exactly as
      `docs/PRODUCT.md` says.
- [ ] Steps can be completed **out of order** (destination before GitHub, which is a legitimate
      order) without the UI blocking; the model reports the *lowest incomplete prerequisite* as
      current.
- [ ] Progress is visible in three places and is identical in all three: Overview, the wizard
      header, and `/setup`.

**Design** — The reason this is a server-derived state machine and not a component: **"show the
exact next step" is `docs/PRODUCT.md`'s words**, and the only way that phrase survives a browser
crash, a support handoff and a second device is if the answer lives on the server. Client-side
wizard state is the single most common reason real products lose onboarding progress.

The other decision that matters: **verification, not assertion**. Every onboarding implementation
that reports "GitHub connected" on the strength of a redirect that returned will eventually
report success for an installation that GitHub declined to create (zero repositories selected,
org SAML blocks it, the user picked the wrong GitHub account). Deriving `done` from a server
row that only a signed webhook can create is what makes the F216 progress indicator trustworthy
enough to put in the UI.

**Schema**

```sql
CREATE TABLE setup_progress (
  org_id         TEXT NOT NULL,
  scope          TEXT NOT NULL CHECK (scope IN ('workspace_setup','integration_setup')),
  scope_ref      TEXT NOT NULL,          -- '' for workspace, integration_id otherwise
  step_id        TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('done','current','blocked','todo')),
  status_source  TEXT NOT NULL,          -- 'verified' | 'user_declared' | 'derived'
  verified_at    INTEGER,
  note           TEXT,                   -- human-readable basis, never a secret
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (org_id, scope, scope_ref, step_id)
) WITHOUT ROWID;
CREATE INDEX ix_setup_progress_current ON setup_progress(org_id, scope, scope_ref, status);
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Installation row exists but `github_installations` unbound | `github_connected = todo`, `blocked` with reason *"Finish connecting GitHub"* |
| Destination credential saved, test never run | `destination_connected = current`, never `done` |
| User skipped the test | `done` with `status_source='user_declared'` and note *"Skipped by user"*; UI shows amber, not green |
| All steps done, user returns | Overview shows the maintenance view, not the wizard |
| Step cannot be derived | `internal_error`, 500; metric `setup_state_unresolvable` raised |

**Security** — `setup_progress` is tenant-scoped on every read and write (F24/F26). No step
records a credential, a webhook URL or a token; `note` is free text and is **not** an escape
hatch — it is size-capped and rendered as text only.

**Tests**
- `next_step_is_derived_server_side_not_held_by_the_client`
- `progress_survives_a_browser_refresh_and_a_second_device`
- `a_step_is_done_only_when_verified`
- `skipping_the_test_does_not_report_a_verified_connection`
- `exactly_one_step_is_current`
- `admin_approval_wait_is_distinguished_from_user_action`
- `setup_progress_is_tenant_scoped_on_every_query`
- `steps_may_be_completed_out_of_order`

**Deps** — F56, F57, F98, F191.

---

## F208 — GitHub App install flow UI

**Priority** P0 · **Status** not started

**Story** As a repository owner, I want to connect my GitHub account in a few clicks and come
back to the right screen, so that I never end up lost on a GitHub page.

**Acceptance**

- [ ] One control: **"Connect GitHub"**, described as *"Lumi Noti asks GitHub for read access to
      the repositories you choose. It cannot post to your code."* No permission vocabulary
      without a consequence.
- [ ] The redirect is a **full-page navigation**, not a popup. Popups are blocked by default in
      Safari and iOS, and the destination provider (Microsoft) will also hand back a popup-shaped
      callback. Cost of a full-page redirect: one extra browser back. Cost of a blocked popup: a
      dead end for the target user.
- [ ] `state` is generated and consumed exactly as F56 specifies — signed, single-use,
      expiring, bound to `{org_id, user_id, expiry}`. This feature is the **UI** for F56 and
      must not re-derive tenant binding client-side.
- [ ] The callback screen states three things in order, without a spinner-only state:
      1. *"You're connected as @<github_login>."*
      2. *"Waiting for GitHub to confirm the installation — this usually takes a few seconds."*
      3. *"Choose which repositories to send."* (F209)
- [ ] ⭐ **Wrong-account detection.** The login GitHub returned is displayed the moment it is
      known, before any repository is chosen. If it differs from the account the user believes
      they are using — which we cannot know, so this must be phrased as a check, not a
      judgement — the screen offers *"Not you? Switch GitHub account"*, a link to
      `https://github.com/logout` plus a retry. This is the single most common non-technical
      failure in GitHub App onboarding and it is invisible without this.
- [ ] Re-entry and interruption states:
      | Condition | Behaviour |
      |---|---|
      | User backs out of GitHub | Return to the step with *"Not connected yet"*, no error styling |
      | Already connected | *"Connected as @x"* + *"Manage repositories"* → F209, never a second install |
      | Install on a GitHub org where SSO blocks the App | GitHub shows its own error page; we surface *"Your organization restricts which GitHub Apps it allows. Ask an administrator to approve Lumi Noti."* and nothing more |
      | Reinstall after uninstall | Fresh `state`; the old installation row is reconciled, never silently reused |
      | `installation_id` in the query string | **Ignored** (F56). The UI must not display it |
- [ ] Progress through the flow is announced to assistive technology as a live region; the GitHub
      redirect is a navigation, so the landing screen re-announces its own title.
- [ ] A **copyable** fallback line — *"or ask your administrator to install Lumi Noti for the
      whole organisation"* — with the App's slug, for the org-owner-and-Engineer case. Sentry,
      Grafana and incident.io all offer per-block test actions for the same reason: the person
      reading the instructions is frequently not the person who holds admin rights.
- [ ] The screen carries the **permission list we actually request**, rendered from the App
      manifest (F55), not from a hand-written string that drifts.

**Design** — The instructions-instructions problem: the person reading "Approve the permissions
request" is often not the person who can approve it. So this screen is written for two
readers at once — the operator doing the clicking and the administrator they have to fetch —
and the administrator-facing half is deliberately short and copyable rather than hidden behind
an "advanced" disclosure.

The wrong-account affordance deserves its own justification: GitHub shows **no** indication of
which account is active once signed in, and a user with two accounts (personal + work) who
installs with the personal one sees a repository list that does not contain their work code,
and concludes the product is broken. Every competitor flow shares this failure; it is cheap to
avoid.

**Schema**

```ts
type GitHubConnectUi = {
  step: 'redirect' | 'confirming' | 'ready' | 'blocked';
  github_login?: string;      // never the installation_id
  bound_installation_id?: string; // shown as "App installation #12345"
  next: { label: string; href: string };
};
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| `state` missing/expired/replayed | 400 page: *"This link has expired. Start again."* + a Connect button. No detail |
| `installation.created` for an unknown `state` | Stored `unclaimed` (F56); UI says *"You're connected, but not to this workspace. Ask an administrator, or sign in with the account you used."* |
| Installation bound to a different `org_id` | **Refuse**, audit (F222), message says only *"This GitHub installation is already connected to another workspace."* |
| GitHub unreachable during confirm | Retry with backoff, then *"We couldn't confirm with GitHub. Try again in a minute."* — never a dead spinner |

**Security** — `installation_id` from the query string is never trusted, never displayed and
never used to authorise; only the signed `installation.created` event binds (F56). The install
link is a **capability URL** — anyone holding it can install the App into a GitHub account — so
it is never logged in full (F12) and its `state` is single-use.

**Tests**
- `install_flow_is_a_full_page_navigation_not_a_popup`
- `github_login_is_shown_before_repository_selection`
- `wrong_account_guidance_is_offered`
- `installation_id_from_the_query_string_is_never_displayed_or_trusted`
- `expired_state_shows_an_actionable_message_not_an_error_dump`
- `install_callback_returns_to_the_correct_setup_step`
- `permission_list_is_rendered_from_the_app_manifest`
- `administrator_instructions_are_copyable`

**Deps** — F55, F56, F57.

---

## F209 — Repository selection UI

**Priority** P0 · **Status** not started

**Story** As a repository owner, I want to pick which repositories notify my team, so that I
control exactly what leaves my GitHub account.

**Acceptance**

- [ ] ⭐ **All repositories / selected repositories is the user's first choice**, and
      *selected* is the default. GitHub's own permission model defaults to all; for a product
      whose trust argument is least privilege, defaulting to all is the wrong default even
      though the platform default is convenient.
- [ ] The picker shows `owner/repo`, the repository's **primary language/description line** when
      available, and a private-repository marker. Selection is per repository, persisted as a
      list, never as "all" with exceptions — because "all" must re-expand when someone creates
      a new repository, and silently starting to deliver from a repo nobody chose is a trust
      breach.
- [ ] ⚠️ **Creating a new repository does not auto-subscribe it.** The GitHub App's
      `repository` selection screen does re-run on reinstall; we surface a **diff**: *"3 new
      repositories are available. Add them?"* with an explicit per-repo list.
- [ ] Zero-repository dead end is handled explicitly, because it is a real and common outcome
      (picked the wrong account, or chose "selected" then selected nothing):
      *"No repositories selected. Choose at least one, or switch to All repositories."*
- [ ] Scale: a GitHub org with >500 repositories is paginated and searchable; the "select all"
      affordance applies to the **filtered** set with the count stated (*"Select all 214
      matching"*), never silently to all.
- [ ] Private repositories show a one-line warning at selection time, not after first delivery:
      *"Private repository events will appear in your chat channel. Anyone with access to that
      channel can see issue titles and commit messages."*
- [ ] ⭐ **"Why can't I see my repository?" is an answer, not a support ticket.** A repository is
      absent when it belongs to another GitHub organisation, when SSO has not approved the App,
      when the token's scopes do not cover it, or when it was archived. The picker distinguishes
      these where it can and otherwise links to a named troubleshooting page that lists all
      four.
- [ ] The selection is **enforced server-side** (F67). A repository added later, directly in
      GitHub, does not become deliverable until our webhook authorises it. The UI never
      implies otherwise.
- [ ] Removing a repository is a **stop**, not a delete: its history remains in the delivery log
      (F213), new events stop immediately, and a confirmation states what stops and when.

**Design** — `docs/DESTINATION_API_REFERENCE.md` §7 and `AGENTS.md` both push toward per-source
authorisation; this screen is where that becomes visible. The "all vs selected" default is a
deliberate disagreement with GitHub's own default, justified by the product's own
`docs/PRODUCT.md` line *"connect with least privilege"*. The cost is one extra click for a user
with one repository; the benefit is that a user who installs the App and walks away has not
subscribed to everything they own.

**Schema**

```sql
-- F67 enforces this; the UI reads it and never writes around it.
CREATE TABLE github_installation_repositories (
  installation_id TEXT NOT NULL,
  repository_id   INTEGER NOT NULL,     -- GitHub numeric id, not the name
  full_name       TEXT NOT NULL,
  private         INTEGER NOT NULL DEFAULT 0,
  selected_at     INTEGER NOT NULL,
  removed_at      INTEGER,
  PRIMARY KEY (installation_id, repository_id)
) WITHOUT ROWID;
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Installation has 0 repositories | Blocked with the named fix, not an empty list |
| Repository list API fails | Keep the previous selection visible; show the error above the picker, never blank it |
| Repository deleted in GitHub | Mark `removed_at`, keep history, show a quiet notice in Integrations |
| Token lacks `repo` scope on a private repo | Exclude it and name the reason; never silently drop |

**Security** — The repository list is read with the **installation token**, not a user's PAT
(F66). A PAT has a wider blast radius than an installation and cannot be scoped to the repos
that were actually selected. Private repository names are themselves sensitive — they are
visible only to members of the organisation, and this API is member-only and tenant-scoped.

**Tests**
- `selected_repositories_is_the_default_not_all`
- `select_all_applies_to_the_filtered_set_and_states_the_count`
- `zero_repositories_shows_a_named_fix`
- `new_github_repositories_are_not_auto_subscribed`
- `private_repository_selection_shows_the_channel_visibility_warning`
- `absent_repositories_name_the_four_causes`
- `removal_stops_delivery_and_preserves_history`
- `repository_picker_reads_via_the_installation_token`

**Deps** — F67, F57, F70.

---

## F210 — Event selection and preset step

**Priority** P1 · **Status** not started

**Story** As someone who does not know what a "workflow run" is, I want to pick from named
choices with a recommendation attached, so that I get useful notifications without configuring
anything.

**Acceptance** — this feature is **the UI for F154/F155** and defines none of the presets.

- [ ] The step leads with the preset list as **radio buttons with consequences**, never a
      multi-select of raw event types:
      | Preset | Shown as |
      |---|---|
      | Everything | *"Every update, right away"* |
      | Failures only | *"Only things that failed — recommended to start"* |
      | Needs my attention | *"Failures, review requests and mentions"* |
      | Comment digest | *"Group comments into one message every 5 minutes"* |
      | Daily summary | *"One message each morning"* |
      | Release & deploy | *"Releases and deployments only"* |
      | Workflow results | *"Build and test results"* |
- [ ] ⭐ **The recommendation is explicit and honest.** The first-run default is **Failures
      only**, and the step says *"We start with failures only because it is the quietest useful
      setting. You can change it any time."* The user can accept the default with one keypress —
      this is the step most likely to decide the F226 median.
- [ ] Raw event-type selection is **present but collapsed** under *"Show exactly which events
      this includes"* — a read-only checklist of the closed F42 catalog, not an authoring
      surface. "Custom" in F42/D16 is a trap: it is a parse fallback, not a user feature.
- [ ] Applying or changing a preset shows the **previewed diff** F154 requires, in the same
      plain language: *"This will stop sending 3 types of update and combine comments for 5
      minutes."* Changing a preset **never** silently discards hand-edited filters — the diff
      lists them under *"your own rules will be kept"*.
- [ ] A volume estimate appears **only when there is data**, and is labelled an estimate with its
      method: *"About 2–4 messages a day, based on the last 7 days of activity on the 6
      repositories you selected."* With no history it says *"We can't estimate volume yet —
      we'll suggest one after a week of events"* and shows nothing numeric.
- [ ] Advanced filters (repository, branch, actor, status, bot suppression) are in a collapsed
      section titled *"Only send me some of these"*, with F141/F161 semantics and no custom
      expression language (F167 is an explicit anti-feature).
- [ ] The step is skippable with *"Just send me everything"* — a one-click escape to the
      *Everything* preset. A user who wants to move on must be able to move on.

**Design** — The estimate is the subtle part. A non-technical user choosing between presets
wants to know which one is quiet, and "Failures only" versus "Everything" is an abstract
difference without volume. Competitors leave that inference to the user: Sentry's published
guidance is *"start with narrow Alerts and consolidate into one with broader filters"*
(<https://docs.sentry.io/product/monitors-and-alerts/alerts/create-alerts/>), which is a
sentence a non-technical user cannot execute. An estimate sourced from the workspace's own
traffic, explicitly labelled with its window and its uncertainty, closes that gap — and it is
**derived from the customer's own data, never a global average**, because a global average would
be a fabricated number.

**Schema** — none. This feature reads F154/F155's preset data and F42's closed event catalog
and defines neither. The only type it owns is the screen-local view model:

```ts
type PresetOption = { id: string; label: string; plain_consequence: string;
                      recommended?: boolean; selected_event_types: string[] };
type VolumeEstimate = { window_days: number; low: number; high: number; method: string }
                    | null;   // null when there is no history - never a guess
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| No event history | No estimate; the preset list stands on its own descriptions |
| <7 days of history | Estimate shown with the actual window (*"based on 2 days of activity"*) |
| Preset applies zero destinations | Blocked at save with *"This preset would send nothing"* |
| User edited filters, then changed preset | Diff view; custom rules kept unless unchecked |

**Security** — n/a; this screen reads and writes configuration only. No event payload is
rendered in the picker — only counts, which are already tenant-scoped aggregates.

**Tests**
- `preset_is_offered_before_raw_event_types`
- `recommended_preset_is_the_default_and_says_why`
- `changing_a_preset_previews_the_consequence_in_plain_language`
- `volume_estimate_appears_only_with_history_and_states_its_window`
- `one_click_replaces_event_selection_entirely`
- `raw_event_checklist_is_read_only`
- `quick_setup_completes_from_a_preset_alone`

**Deps** — F154, F155, F42, F167.

---

## F211 — Destination setup flow

**Priority** P0 · **Status** not started

**Story** As a team administrator, I want to connect the channel my team already uses, so that
notifications arrive where I will actually see them.

**Acceptance** — three **structurally different** flows, chosen by what the provider allows, not
by our preference (from `docs/DESTINATION_API_REFERENCE.md` §0):

| Destination | Flow | Customer pastes a secret? |
| --- | --- | --- |
| **Slack** (Web API + `incoming-webhook` scope) | OAuth: *"Add to Slack"* → Slack's own channel picker → we receive the URL | **No** |
| **Slack** (incoming webhook) | Paste URL | Yes |
| **Lark / Feishu** custom bot | Paste URL + optional signing key | Yes |
| **Lark app** | App credentials + tenant admin approval | Yes, and admin-gated |
| **Microsoft Teams** (Workflows) | Paste trigger URL + choose the trigger's auth mode | Yes |

- [ ] For every destination the flow states, **before** asking for anything: *"Where should
      notifications go?"* → *"To the channel you pick in Slack"* / *"To a group you create in
      Lark"*, plus what the message will look like.
- [ ] ⭐ **Credential handling** (F96/F97) is uniform:
      - The field is `type="password"`, `autocomplete="off"`, `spellcheck="false"`,
        `data-1p-ignore`, and labelled **"Webhook URL"**, not "API endpoint".
      - A persistent warning sits above it: *"Anyone with this URL can post to your channel.
        Treat it like a password. We store it encrypted and never show it again."*
      - The value is **write-only**. After save, the UI shows the host and a masked tail
        (`https://hooks.slack.com/services/***/B…/aB3x`), never the full value, and the only
        operation is **Replace** (which requires re-entering) or **Rotate**.
      - Paste is allowed — non-technical users paste constantly — and the field never
        auto-trims or reformats a pasted URL, because doing so silently corrupts the secret.
      - Clipboard write-back ("copy your webhook again") is **not offered**; if the destination
        exposes the URL to the user again it is a leak by definition.
- [ ] **Capability honesty at save time** (F92/F93): options this destination cannot honour
      are rendered **disabled with the reason inline**, e.g. *"Update the same message when CI
      finishes again — not available with a Slack incoming webhook."* Never selected-then-
      degraded.
- [ ] Teams specifically must capture the trigger's `triggerAuthenticationType` at save time
      (`Anyone` / `Any user in my tenant` / `Specific users`), because sending a token when
      `Anyone` is set makes **every** request fail
      (`docs/DESTINATION_API_REFERENCE.md` §2.2). Getting this wrong at delivery time is
      indistinguishable from an outage.
- [ ] The flow ends in **"Send a test message"** (F215), reachable from the setup step itself,
      not only from the finished settings page.
- [ ] Multiple destinations per integration is supported and encouraged, not a duplicate-setup
      chore: after the first destination saves, the step offers *"Add another channel"* and the
      wizard continues.
- [ ] A destination the workspace is not entitled to is **absent from the picker** (F206), not
      greyed out.
- [ ] Editing a destination never loses an existing secret when a non-secret field changes.

**Design** — Slack's OAuth `incoming-webhook` path is the gold standard in this category and
`docs/DESTINATION_API_REFERENCE.md` §1.7 calls it exactly that: the scope *"triggers a
user-facing channel picker in the OAuth 2.0 installation sequence"* and returns the URL. That
is zero-paste, zero-transcription, zero-leak. Where a provider gives us that, we take it, and
the paste-a-URL flows exist only for the three destinations that (per the same reference)
**cannot** be provisioned programmatically.

The "treat it like a password" warning is not decoration: for webhook destinations the URL *is*
the credential, and `docs/SECURITY.md` lists compromised credentials in the threat model. The UI
is the only place the customer can be told that before they paste something into a Slack DM.

**Schema**

```ts
type DestinationSetupState = {
  destination_type: 'slack_webhook' | 'slack_api' | 'lark_custom_bot'
                   | 'lark_app' | 'msteams_workflow';
  credential_ref: string;        // opaque id — never the ciphertext, never the value
  credential_hint: string;       // "hooks.slack.com/services/…/aB3x"
  capability_notes: string[];    // populated from adapter.capabilities(cfg)
  teams_trigger_auth?: 'anyone' | 'tenant_user' | 'specific_users';
  verified_at: string | null;    // from F98
  verification_source: 'test_delivery' | 'user_declared' | null;
};
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| URL not `https:` / wrong host / userinfo present / bad path (F102) | Rejected at **save** with *"That doesn't look like a Lark webhook address."* and the expected host — not at first delivery |
| Non-secret field saved on an existing destination | Existing secret preserved byte-for-byte |
| Destination type changed | Secret is re-entered; the old one is destroyed |
| Slack OAuth returns a URL outside `hooks.slack.com` | Rejected; the value is never stored |

**Security** — `credential_ref` is the only thing the client ever receives. SSRF validation is a
**write-time** gate (F96) and re-checked at send time (F91). The credential is never returned
by any read endpoint, never logged (F12), never included in an error body, and never placed in
a client-side analytics event. Redirects are never followed (`redirect: 'manual'`, with a 3xx
treated as a permanent failure; amended 2026-10-13, [ADR 0006](../adr/0006-destination-adapter-contract.md)).

**Tests**
- `credential_field_is_write_only_and_never_echoed`
- `credential_field_warns_that_the_url_is_a_bearer_secret`
- `invalid_destination_url_is_rejected_at_save_with_the_expected_host`
- `unsupported_capabilities_are_disabled_with_the_reason_inline`
- `slack_oauth_path_never_asks_the_user_to_paste_a_url`
- `teams_trigger_auth_mode_is_captured_at_save_time`
- `saving_a_non_secret_field_preserves_the_existing_secret`
- `credential_appears_in_no_read_endpoint_and_no_log_line`

**Deps** — F91, F92, F93, F96, F97, F102.

---

## F212 — Destination setup instructions and the verified-screenshot pipeline

**Priority** P0 · **Status** not started

**Story** As a non-technical user, I want pictures of the exact screen the provider is showing
me, so that I can find the button without understanding the provider's product.

**Acceptance** — **no screenshot may exist in the repository until it was captured from the real
provider UI by a named person on a recorded date**, and every screenshot carries its capture
metadata in the filename.

- [ ] The **capture contract**:
      `docs/assets/destinations/<destination>/<step>-<slug>__captured-YYYY-MM-DD__ui-<provider-version>.webp`
      and an adjacent `.meta.json`:

```json
{
  "destination": "msteams_workflow",
  "step": 4,
  "provider": "Microsoft Power Automate",
  "provider_surface": "flow-designer",
  "captured_at": "2026-10-08",
  "captured_by": "<git handle>",
  "tenant": "a real test tenant, not customer data",
  "locale": "en-US",
  "redactions": ["flow owner email", "team name"],
  "verified_by_end_to_end_run": true
}
```

- [ ] ⭐ **`verified_by_end_to_end_run: true` is mandatory.** A screenshot of a screen we have not
      successfully completed is documentation of a dead end. The capture is only accepted when
      the same person took the screenshot while walking a first-time customer from that screen
      to a `202 Accepted`/`code: 0` response.
- [ ] **Redaction rules:** no real customer names, no real team/channel names, no email
      addresses, no tenant identifiers, no webhooks in the URL bar. Prefer a freshly created
      test tenant per capture.
- [ ] Each instruction is a numbered step, and each step carries exactly one of: a screenshot,
      a precise written instruction, or neither. Never a screenshot with no instruction —
      screenshots drift and prose is searchable.
- [ ] Every step links to the **provider's own official documentation** as a fallback, so a
      screenshot that goes stale does not strand the user.
- [ ] ⭐ **The page states its own freshness:** *"These instructions were verified against
      Microsoft Power Automate on 8 October 2026. If a screen looks different, see [the provider's
      current guide]."* A stale-by-3-months page is worse than an honest "check the official
      docs" link.
- [ ] Re-verification is triggered by: any F226 study participant lost on a step, any support
      report naming a destination, or any change in the destination's adapter capabilities.

**Per-destination step content** (the screens each step needs; written to `AGENTS.md`'s "use
official API documentation and test actual provider payloads"):

**Lark custom bot** (`docs/DESTINATION_API_REFERENCE.md` §3.4 — custom bot webhooks **cannot** be
created by API; creation is a manual UI flow, which is why this step needs pictures):

| # | Step | Needs a screenshot of | Notes to the user |
| --- | --- | --- | --- |
| 1 | Open the group chat where notifications should appear | the chat's `⋯` menu | *"Messages will be visible to everyone in this group."* |
| 2 | `设置` → `群机器人` | the Settings panel with 群机器人 highlighted | The label is Chinese in both Lark and Feishu — **say so explicitly**, it is the point where non-English users stall |
| 3 | `添加机器人` → `自定义机器人` → name it → `添加` | the custom-bot dialog with the name field | Name it something the team will recognise in the group |
| 4 | Copy the **webhook address** | the webhook URL row with the copy icon | ⭐ Mark: *"This URL is a password. Anyone with it can post to your group."* |
| 5 | *(optional, recommended)* Enable `签名校验` and copy the secret | the signature row | Enables F101/F102; without it the request is unsigned |
| 6 | Return here, paste, **send a test message** | — | The customer should see the test in Lark before continuing |

**Slack incoming webhook** (incoming webhooks remain available
(<https://docs.slack.dev/apps/manifests>) — ⚠️ Slack has been changing this surface; the
instructions must be re-verified at capture time, not assumed):

| # | Step | Needs a screenshot of | Notes |
| --- | --- | --- | --- |
| 1 | Prefer **"Add to Slack"** if the OAuth app is installed | — | *"Choose the channel in Slack. You do not need to paste anything."* |
| 2 | `Apps` → `Incoming Webhooks` → `Add to a channel` | the app-directory page | Slack's channel picker, not ours |
| 3 | Copy `Webhook URL` | the URL row | *"This URL is a password."* |

**Microsoft Teams Workflows** (the default Teams path per
`docs/DESTINATION_API_REFERENCE.md` §2.2/§2.5 — no premium licence, no Entra app
registration, the only option a non-technical user can complete without IT):

| # | Step | Needs a screenshot of | Notes |
| --- | --- | --- | --- |
| 1 | Open `make.powerautomate.com` → *Create* → search *"Post to a channel when a webhook request is received"* | the template gallery result | Quote the template name exactly — it is searchable |
| 2 | **Inside the flow**, pick the Team and the Channel | the team/channel dropdown | *"Notifications will post in this channel, as the Workflows bot."* |
| 3 | `…` → `Accept sample payload` / `Get sample payload` | the sample-payload panel | We do **not** need this — we send our own body. Say *"You can skip this."* |
| 4 | Save. **Copy the HTTP POST URL** from the trigger | the trigger card with the URL | *"This URL is a password."* |
| 5 | Record the **authentication mode** the trigger shows | the Authentication dropdown open | Determines whether we send a token — see F211. Surface this as a choice, not a guess |
| 6 | Confirm the Workflows app is allowed in Teams admin | the Teams admin centre allow-list | *"If an administrator hasn't approved Workflows, your message will arrive and then fail. Ask them to check."* |
| 7 | Return here, paste, send the test | — | ⚠️ Teams returns **202 Accepted** — that is *not* delivery. The user must confirm the message appeared |

- [ ] ⭐ **The orphan-flow warning is mandatory on the Teams flow.** Workflows are *"linked only
      to specific users (referred to as owners of the workflow) and not to a Teams team or
      channel"*
      (`docs/DESTINATION_API_REFERENCE.md` §2.2). If the person who built the flow leaves, it
      breaks silently. The setup step says: *"This flow belongs to <name>, not to the team. If
      they leave the company, notifications stop. Ask <name> to add a co-owner, or ask us about
      the managed option."*
- [ ] Instructions are **per-locale-aware** (F224): the provider's admin UI is in the
      provider's language, not the user's. Each step that crosses into provider UI says which
      screen it is *in English* regardless of the user's locale.
- [ ] Instructions are rendered **inside the product** (a drawer at the credential field), not
      as a link to a docs site. The user who needs the picture is mid-flow, with a form open.
- [ ] If a destination has **no verified captures yet**, its step shows written instructions
      and a labelled gap: *"We have not yet verified these steps with a live Microsoft tenant."*
      It does not show a placeholder image.

**Design** — Screenshot-first setup instructions are standard and still routinely wrong,
because screenshots are captured once by whoever wrote the docs and nobody owns their staleness.
The `.meta.json` contract plus the `verified_by_end_to_end_run` flag converts a screenshot from
an illustration into **an assertion that a person completed the flow**. The staleness disclaimer
is the honest version of a mechanism most products omit: we are telling the user in advance that
this page may be out of date and where the authority lives.

**Schema** — the capture contract is the only new artefact this feature defines. It is a
repository layout plus a required sidecar, and it is machine-checked:

```text
docs/assets/destinations/<destination>/<step>-<slug>__captured-YYYY-MM-DD__ui-<provider-version>.webp
docs/assets/destinations/<destination>/<step>-<slug>.meta.json
```

```ts
type ScreenshotMeta = {
  destination: 'slack_webhook'|'lark_custom_bot'|'msteams_workflow';
  step: number;
  provider: string;               // e.g. 'Microsoft Power Automate'
  provider_surface: string;       // the screen, named
  captured_at: string;            // ISO date
  captured_by: string;
  tenant: 'dedicated_test_tenant'; // enum, not free text: customer tenants are not a value
  locale: string;
  redactions: string[];
  verified_by_end_to_end_run: boolean;   // MUST be true or the build fails
};
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Screenshot missing, `.meta.json` missing, or `verified_by_end_to_end_run !== true` | Build fails |
| Capture older than the adapter's last verified date | Warning in CI; must be re-captured or the date justified |
| Provider UI changed | Stale-detection is manual — triggered by a study loss or a support report (F212 re-verification) |
| A user reports a step is wrong | That report is a bug with a P1 label, not documentation drift |

**Security** — Screenshots of a real tenant are a **data-leak surface**: team names, channel
names, employee email addresses and sometimes webhook URLs. Capture happens only in a dedicated
test tenant, redaction is reviewed in the PR that adds the image, and `.meta.json#redactions`
records what was removed. No customer tenant is ever used for capture.

**Tests**
- `every_screenshot_has_a_meta_json_captured_from_a_real_run`
- `no_screenshot_is_taken_from_a_customer_tenant`
- `instruction_steps_reference_an_official_provider_doc`
- `instructions_state_their_verification_date`
- `teams_setup_step_contains_the_orphan_flow_warning`
- `missing_captures_render_written_instructions_and_a_labelled_gap`
- `lark_chinese_menu_labels_are_called_out_verbatim`

**Deps** — F211, F98, F104.

---

## F213 — Delivery log

**Priority** P0 · **Status** not started · **Referenced by `07:F100`, `07:F149`, `11:F164`,
`11:F185`**

**Story** As a customer, I want to see every notification we tried to send and what happened to
it, so that I can trust the product enough to hand it real alerting.

**Acceptance**

- [ ] `web/src/pages.tsx:15` currently renders a table with `data={[] as ActivityRow[]}` and the
      string *"No activity data available. Delivery history API is not implemented yet."* That
      state is correct today and is replaced by the real ledger (F184) when it exists — not
      before, and not with sample rows.
- [ ] **List**, newest first, paginated with an explicit count (*"Showing 50 of 1,284"*):

| Column | Content | Notes |
| --- | --- | --- |
| When | Relative + absolute on hover | Local timezone, absolute in ISO |
| What happened | Actor + action + subject, one line | e.g. *"dwh opened issue #482 'Login fails on Safari'"* |
| Destination | Name + type + channel | Never the credential |
| Outcome | Status chip | **Text + icon, never colour alone** (1.4.1) |
| Why | Degradation rung, suppression reason, retry count | Cross-ref F149 |

- [ ] **Status vocabulary is the honest one from F100**, and the UI must never merge them:

| Chip | Meaning |
| --- | --- |
| `Delivered` | The provider confirmed receipt (Lark `code:0`, Slack 200 `ok`, Telegram `message_id`, Discord with `wait=true`) |
| `Accepted` | ⚠️ Teams Workflows `202` — *accepted, not confirmed* |
| `Retrying` | Will be attempted again; the next attempt time is shown |
| `Failed` | Terminal, permanent, with the taxonomy code and the fix |
| `Dead-lettered` | Retries exhausted. The full attempt log is here |
| `Suppressed` | Deliberately not sent — duplicate, muted, filtered, or out of quiet hours. **The reason is the point of this row** |
| `Waiting` | Held for a digest window or quiet hours |

- [ ] ⭐ **Every delivery detail states the delivery model** (F185): *"Noti delivers at least
      once. A notification may occasionally be delivered more than once."* — shown once at the
      top of the detail panel, not repeated per row.
- [ ] **Detail panel** contains: full canonical envelope fields, the **redacted** rendered
      payload as it was sent, the degradation rung used (F93), the attempt table (F184
      `delivery_attempts`: attempt number, started, finished, HTTP status, provider code,
      taxonomy code, latency, `Retry-After`), the correlation id (F11), the dedup key, the
      provider message id where one exists, and **"Why did I get this?"** (F149) rendering
      GitHub's `reasons` array as the matched rule.
- [ ] A Slack `internal_error` / `fatal_error` is surfaced as *"this may have been delivered"*
      (F185), not as a plain failure.
- [ ] ⭐ **Filters** are: outcome, destination, repository, event type, time range, correlation
      id (paste), and text search over subject. Filters live in the **URL query string** so a
      support reply can contain a link to exactly what the user is looking at.
- [ ] **Actions**: copy a redacted diagnostic bundle for support; **replay** from here, gated on
      F204's `replay` capability (F218).
- [ ] Export: CSV/JSON of the filtered set, respecting the same tenant scope, rate-limited and
      audited.
- [ ] Empty states are specific (F225): *"No notifications in the last 24 hours"* + which
      filters are active + a one-click clear. Never *"No data."*
- [ ] ⚠️ The delivery log is **the product**, per `AGENTS.md`: *"expose possible duplicates and
      dedupe where feasible."* Anything that makes this screen cheaper to read at the cost of
      honesty is rejected.

**Schema** — read model only; `deliveries` and `delivery_attempts` are F184. The UI's view
type:

```ts
type DeliveryRow = {
  id: string;
  occurred_at: string;          // ISO 8601 UTC
  occurred_at_local: string;    // pre-formatted for the user's locale/timezone
  subject: string;              // e.g. "Login fails on Safari"
  actor: string | null;         // null renders "—" (F43), never a guess
  repository: string;
  event_type: string;
  destination: { id: string; name: string; type: DestinationId };
  state: 'pending'|'claimed'|'sent'|'accepted'|'failed'|'dead_lettered'|'suppressed'|'held';
  provider_message_id: string | null;
  degradation_rung: string | null;   // F93
  suppressed_reason: 'duplicate'|'muted'|'filtered'|'quiet_hours'|'digest_pending'|'budget' | null;
  attempts: number;
  next_attempt_at: string | null;
  error_code: TaxonomyCode | null;
  correlation_id: string;
  test: boolean;                // test rows are visually marked and never counted
};
```

**Design** — Two decisions set this screen apart from an admin table.

The first is the **status vocabulary**. F100 establishes that a Teams `202` is *accepted*, not
delivered, and every product that collapses those states is one day going to tell a customer
their notification arrived when it did not. So `Delivered`, `Accepted`, `Suppressed` and
`Dead-lettered` are four distinct chips with four distinct meanings, and `Suppressed` carries
its reason in the row rather than hiding the row. That is the whole argument behind
`AGENTS.md`'s "expose possible duplicates and dedupe where feasible": a notification the user
*chose* not to receive is information, and hiding it makes the log lie about volume.

The second is that **this screen is the answer to "it didn't arrive"**, which means it must be
readable by the person who was paged, not the person who wrote the code. That drives the
one-line subject column (*"dwh opened issue #482 'Login fails on Safari'"* rather than
`issues.opened acme/api`), human-facing taxonomy wording (F220), and the decision not to require
the user to open a delivery to learn its outcome. The cost is a wide row and a simpler table; the
benefit is that the most common support question is answerable in the list view.

**Errors**

| Condition | Behaviour |
| --- | --- |
| Ledger query fails | Error state above the table; the table area keeps its last good rows with a "may be out of date" note. Never an empty table pretending to be empty |
| One delivery's payload exceeds the render budget | The payload panel shows the **byte count and the elision notice** (F95), never a silent truncation |
| Provider status is absent | Outcome renders `—` with *"we don't know"* — F100 honesty, not a green chip |
| `error_code` has no user message (should be impossible — F13) | Fails a unit test; renders the code only in the support bundle |

**Security** — Redaction (F12/F120) is applied **server-side** in the read endpoint, not by the
client, because a client-side redactor is a client-side leak. No `error_detail` containing a
provider body, no webhook URL, no ciphertext. Every query is tenant-scoped (F26). The export is
audited and rate-limited.

**Tests**
- `delivery_outcome_never_renders_accepted_as_delivered`
- `delivery_detail_discloses_the_at_least_once_model`
- `suppressed_rows_state_the_suppression_reason`
- `status_is_conveyed_by_text_and_icon_not_colour_alone`
- `filters_round_trip_through_the_url`
- `payload_panel_shows_byte_count_and_elision_not_a_silent_truncation`
- `delivery_log_renders_no_rows_until_the_ledger_exists`
- `log_is_tenant_scoped_and_redacted_server_side`

**Deps** — F184, F185, F186, F93, F99, F100, F149, F11.

---

## F214 — Event log and single-event trace

**Priority** P1 · **Status** not started

**Story** As a user, I want to see what arrived from GitHub even when nothing was delivered, so
that "I got nothing" has an answer.

**Acceptance**

- [ ] The event log is a **separate object** from the delivery log. One inbound event fans out to
      N destinations, each of which may be delivered, retried, suppressed or filtered. The
      delivery log shows the leaves; the event log shows the root and the **decisions**.
- [ ] **Event row**: received-at (provider timestamp and our ingest timestamp, because they
      differ and the difference is diagnostic), provider, event type, `X-GitHub-Delivery` id,
      installation it was authorised against, signature verdict, normalised subject.
- [ ] ⭐ **The trace is the product of this screen.** For one event, the fan-out is a tree:

```
workflow_run.completed  failure   run #482 on acme/api
├── acme/api → #engineering  → Delivered                       (10:02:14)
├── acme/api → #alerts       → Suppressed (duplicate)          (10:02:14)
└── acme/web → #frontend     → Suppressed (filtered: repo list) (10:02:14)
```

      Every leaf states the decision and the rule that made it. "Nothing happened" is the screen's
      most important output and it must be as legible as "it worked".
- [ ] Filters: repository, event type, outcome (**including *not matched***), installation, time
      range, `X-GitHub-Delivery` id, correlation id.
- [ ] Decision reasons are a **closed set**, so they can be grouped and counted:
      `matched` · `no_repository_selected` · `integration_disabled` · `filter_excluded`
      (with the named filter) · `bot_or_self_authored` (F151) · `muted` (F162, with the mute
      scope) · `quiet_hours` (F146) · `digest_pending` (F144) · `critical_lock` (F148)
      · `dedup_suppressed` (F186) · `destination_unavailable`.
- [ ] The payload viewer is **redacted** and **size-capped** with the byte count shown. Retention
      boundary is stated on the screen: *"Events are kept for 30 days."* (F51) — stated rather
      than assumed, matching `docs/COMPETITIVE-FEATURE-SET.md`'s finding that users need to be
      told about retention.
- [ ] An unknown/unparsed event type (the F42 passthrough case) shows its raw type and
      *"we don't have a detailed view for this event type"* — never a blank or a wrong label.
- [ ] A rejected signature appears **only** to admins and is a security signal, not an error a
      customer caused; the copy is *"This request was rejected. No notification was sent."*

**Design** — This screen exists because of a specific asymmetry: the current data model records
what was *sent* far better than what was *ignored*. A user whose filter excludes
`push` events sees silence and concludes the integration is broken. Meanwhile our logs are full
of "correctly filtered" lines that nobody reads. Putting the decision tree at the centre converts
a logging feature into the answer to the second-most-common support question after "it didn't
arrive".

**Schema**

```ts
type EventTraceNode = {
  event_id: string;
  received_at: string;
  provider: 'github';
  provider_delivery_id: string;         // X-GitHub-Delivery
  installation_id: string | null;
  signature_verdict: 'verified' | 'rejected' | 'not_applicable';
  event_type: string;                   // closed catalog (F42)
  subject: { actor: string|null; title: string|null; url: string|null };
  repository: string;
  decisions: Array<{
    integration_id: string;
    destination_id: string | null;
    decision: EventDecisionReason;      // closed set above
    rule_detail: string | null;         // which filter/mute/preset produced it
    delivery_id: string | null;
  }>;
  retention_expires_at: string;
};
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Event received but the installation no longer exists | Trace shows *"the repository is no longer connected"* — the history is not deleted |
| Event older than retention | Event row remains as a tombstone: *"payload no longer available (retention)"* with the decision list |
| Fan-out produced no leaves | Show the root with *"no destination matched"* and the list of checked integrations |

**Security** — Event payloads are **private repository content** and are tenant-scoped on every
read (F26). The viewer is not available to non-members of the workspace. Signature-rejected
rows are admin-only. Redaction applies to the payload view. No event payload leaves the tenant
through an error tracker or an analytics event — `docs/SECURITY.md` requires this explicitly.

**Tests**
- `event_trace_shows_every_decision_not_just_deliveries`
- `no_match_is_a_first_class_trace_outcome`
- `decision_reasons_are_a_closed_set`
- `event_payload_view_is_redacted_and_size_capped_with_byte_count`
- `retention_expiry_renders_a_tombstone_not_a_gap`
- `unknown_event_type_shows_its_raw_type_and_says_so`
- `event_log_is_tenant_scoped_and_admin_only_where_required`

**Deps** — F41, F42, F48, F51, F151, F186, F26.

---

## F215 — Test-delivery screen

**Priority** P0 · **Status** not started · **UI for F98**

**Story** As someone who has never used this product, I want to prove it works before I trust
it, so that I know the setup was worth finishing.

**Acceptance**

- [ ] ⭐ **Reachable from every stage of setup**, including *before* an event type is selected
      (F98 requires this) and at any later time from the integration. It is a first-class screen,
      not a debug panel.
- [ ] The test goes through the **real renderer and the real send path** (F98). There is no
      "simulated success" mode, and no way to make it look successful.
- [ ] **Event choice**, two options, both honest:
      | Option | What it sends |
      |---|---|
      | **A real recent event** (default when history exists) | The most recent real event from the selected repositories, re-rendered and re-sent |
      | **A sample event** | A versioned fixture (F72), clearly labelled *"Sample — this is not a real event from your repository"* |
      The real-event option is the one that teaches: the user recognises their own repository
      and their own colleague's name in the message.
- [ ] **The result panel has four parts**, all present on success *and* failure:
      1. **Did it arrive?** — for destinations that confirm, the state from F100. For Teams, an
         explicit *"Accepted by Teams at 14:03. This confirms the flow ran, not that the message
         appeared. Did you see it in the channel?"*
      2. **What we sent** — the rendered payload, **redacted** (F98/F120).
      3. **What this did and did not prove** — capability honesty (F98/F93), e.g. *"This
         proves the webhook works. It does not prove messages can be edited later — incoming
         webhooks cannot do that."*
      4. **If it failed** — the plain-language explanation and the **exact next action**, with a
         button that performs it where possible (*"Reconnect"*, *"Open Teams settings"*).
- [ ] ⭐ **Confirmation is user-provided where the provider cannot confirm.** For Teams (202)
      the user answers *"Yes, I see it"* / *"No message"*. This is recorded, and it is the only
      thing that can move `destination_connected` to `done` for that destination. Framing: *"Only
      you can tell us whether it arrived."*
- [ ] The test is **free and unmetered** and is excluded from statistics (F98) — and the UI
      says so, because a test message that appears in the customer's real message count is a
      confusing support ticket.
- [ ] Retry from the failure panel is one click and creates a **new** delivery row marked
      `test`, so history stays truthful.
- [ ] Test deliveries are visually marked everywhere they appear (delivery log, event log,
      Teams cards) with a *"Test"* tag, never by a different colour alone.
- [ ] A failed test never blocks the wizard outright: *"You can keep setting up and come back to
      this"* is offered, because a user who is told they cannot continue will abandon setup, and
      a stuck wizard is how a target user ends up needing a developer.

**Design** — Every serious competitor has this control: Sentry's *"Send Test Notification"* on
**each If/Then block** individually (<https://docs.sentry.io/product/monitors-and-alerts/alerts/create-alerts/>),
Grafana's *"Send demo alert"* (<https://grafana.com/docs/oncall/latest/set-up/get-started>),
incident.io's alert preview that marks which recent alerts your filters would have dropped
(<https://docs.incident.io/alerts/alert-sources>). Three independent products converged on it,
which makes it the one feature in this file with the least risk of being wrong.

The addition ours makes is the **confirmation step for destinations that cannot confirm**. Teams
returns 202 and nothing else; incident.io's preview and Sentry's send-test both stop at the
transport layer. Adding a one-click *"did you see it?"* converts an unverifiable success into a
verified one, using the only evidence source that exists — the person who asked for the
notification.

**Schema**

```ts
type TestResult = {
  delivery_id: string;
  test: true;
  state: 'delivered' | 'accepted' | 'retrying' | 'failed' | 'dead_lettered';
  provider_message_id: string | null;
  error_code: TaxonomyCode | null;
  user_message: string;              // from F13, localised (F224)
  rendered_payload_redacted: string;
  proved: string[];                  // "webhook received the message"
  not_proved: string[];              // "messages cannot be edited later"
  requires_user_confirmation: boolean;
  user_confirmed_at: string | null;
  excluded_from_metrics: true;
};
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| No history and no fixture available | Sample-event option is always available — F72 fixtures are mandatory |
| Credential invalid | `destination_credentials_invalid` → *"Reconnect the destination"* as the primary action |
| Payload exceeds the destination cap | `payload_too_large` with the byte count (F95), never truncated |
| Provider accepted but user says no message | Recorded as a **confirmed failure**, surfaced on the integration as *"Teams accepted it but no message appeared — the flow is probably switched off in Teams."* |
| Test fails | Non-blocking; the wizard continues |

**Security** — The rendered payload preview is **redacted** (F98/F120): a Lark or Slack card
can embed the destination webhook URL, which is a bearer secret. The preview is generated
server-side by the same redactor used for the delivery log, so the client never holds the
unredacted payload at all.

**Tests**
- `test_delivery_runs_through_the_real_renderer_and_send`
- `test_delivery_is_reachable_before_event_selection`
- `test_result_states_what_it_did_and_did_not_prove`
- `teams_test_requires_user_confirmation_to_mark_connected`
- `test_payload_preview_is_redacted_server_side`
- `test_deliveries_are_excluded_from_metrics_and_marked_in_history`
- `a_failed_test_does_not_block_the_wizard`

**Deps** — F98, F99, F100, F72.

---

## F216 — Setup wizard shell and step navigation

**Priority** P0 · **Status** not started · **Referenced by `07:F98`, `00-current-state.md:N3`**

**Story** As a new user, I want one guided path from nothing to a notification that works, so
that I never have to work out the order myself.

**Acceptance**

- [ ] The wizard is the **default landing route** for a workspace that has never completed a
      first delivery. Not a modal, not a nag banner — a route.
- [ ] Ordered steps, with the **exact next step** always visible on a sticky bar:

```ts
const STEPS: SetupStepDef[] = [
  { id:'workspace_created',      title:'Create your workspace' },
  { id:'github_connected',       title:'Connect GitHub' },
  { id:'repositories_selected',  title:'Choose repositories' },
  { id:'destination_connected',  title:'Choose where messages go' },
  { id:'events_chosen',          title:'Choose what to send' },
  { id:'test_delivered',         title:'Send a test' },
  { id:'activated',              title:'Turn it on' },
];
```

- [ ] ⭐ **Completion is one definition, shown in one place:** *"You've completed setup. GitHub
      events from 6 repositories are now going to #engineering in Slack."* with a live example
      link into the delivery log. A user who finished does not have to wonder whether they
      finished.
- [ ] **Every step is deep-linkable** (`/setup/2/repositories`) and every step renders correctly
      on cold load, from a bookmark, and after the GitHub redirect.
- [ ] Steps can be **revisited and re-run** after completion — an integration is a living object,
      not a one-time ceremony. The wizard becomes *"Manage your connection"* and preserves
      history.
- [ ] ⚠️ **Escape hatch, always visible:** *"Finish later"* on every step. Closing the tab is
      always permitted and progress survives (F207). Forcing a wizard is how products lose
      non-technical users.
- [ ] **Third-party waits are named and non-blocking.** A step waiting on a Teams/Lark admin is
      marked `Waiting for your administrator` with the exact instruction to forward, and the user
      can leave and be notified when the credential becomes valid (F98's daily health job).
- [ ] The wizard is **additive**, not exclusive: a user can reach Integrations and build an
      integration by hand at any time. The wizard is the easy path, never the only path.
- [ ] The step indicator itself is accessible: it is an ordered list with
      `aria-current="step"` on the active item, not a row of coloured circles, and it announces
      *"Step 3 of 7: Choose repositories"* on each transition (F221).
- [ ] ⚠️ **The wizard never claims a success it has not verified.** `docs/PRODUCT.md`'s ≥80%
      threshold is about *first delivery*; a wizard that marks a step done on a redirect would
      make that metric meaningless and would ship broken connections.

**Design** — `docs/PRODUCT.md` sets the target: *"median successful setup under 5 minutes in
moderated tests, excluding third-party admin approvals."* Two design consequences follow, and
they conflict with how onboarding is usually built:

1. **A wizard with a step per concept will not hit 5 minutes.** Six steps × a "read and
   understand" step each is ten minutes of reading. Therefore: the *default* path collapses to
   four decisions — connect, choose, choose, prove — and everything else is a preset (F210) or
   skipped. Steps 5 and 7 are one keypress each.
2. **The escape hatch protects the metric.** If a user who is stuck at step 3 abandons, the F226
   median is measured on people who finished, which flatters the result. `docs/PRODUCT.md` says
   "successful setup", and F226 records abandonment separately so the number cannot be
   massaged.

**Schema** — the wizard holds no state of its own; it renders `GET /api/workspace/setup-state`
(F207) and navigates. Step transitions are the same mutations as the normal settings screens —
**there is no wizard-only write path**, so a user who edits an integration from the settings
screen cannot desynchronise the wizard's model.

**Errors**

| Condition | Behaviour |
| --- | --- |
| Direct navigation to a step whose prerequisite is unmet | Render the prerequisite step read-only with an explanation, never a broken form |
| Step API unreachable | Cache the last known state visibly marked *"may be out of date"*; never reset progress |
| User disconnects GitHub mid-wizard | Steps 2–7 revert to `todo` with the cause; the wizard does not silently stay green |
| User already completed setup | Redirect to Overview with a *"Your connection is live"* summary |

**Security** — The wizard performs **no privileged work of its own**; it sequences
capability-checked calls (F24). The install link it redirects to is a capability URL and is
never logged in full (F208). All writes are tenant-scoped and audited where F222 applies.

**Tests**
- `wizard_is_the_landing_route_for_an_unconfigured_workspace`
- `every_step_is_deep_linkable_and_renders_on_cold_load`
- `exact_next_step_is_always_visible`
- `progress_survives_closing_the_tab`
- `wizard_completion_states_what_is_live_in_one_sentence`
- `a_step_is_never_marked_done_without_verification`
- `wizard_writes_go_through_the_same_endpoints_as_settings`
- `wizard_step_indicator_is_aria_current_step`

**Deps** — F207, F205, F210, F211, F215.

---

## F217 — Integration settings

**Priority** P0 · **Status** not started

**Story** As an administrator, I want one screen per connection where I can see and change
everything about it, so that I never hunt through menus to turn something off.

**Acceptance**

- [ ] One route per integration: `/integrations/:id`, with a **stable section order** that does
      not change as features ship:
      1. **Status** — live / paused / needs attention, with the one-line cause
      2. **GitHub source** — installation, login, repositories (→ F209)
      3. **Events** — preset + exact list + filters (→ F210)
      4. **Destinations** — one card each, capabilities and verification state
      5. **Noise** — grouping, digest, quiet hours (rendered from F141–F168; **no new logic
         here**)
      6. **Credentials** — last four characters, rotated-at, **Replace** (never *View*)
      7. **Health** — last successful delivery, last failure, failure reason
      8. **History** — link into the delivery log filtered to this integration
      9. **Danger zone** — pause, disconnect source, delete
- [ ] **Save is explicit per section**, with an unsaved-changes guard on navigation
      (`beforeunload` + router blocker). A settings screen that saves on blur loses a
      non-technical user's work; one that saves everything on blur saves things they did not
      intend.
- [ ] ⭐ **Pause ≠ delete.** Pause stops new events immediately and preserves all history and
      configuration. It is the recommended first response to *"it's too noisy"* and is offered as
      such, with the exact consequence: *"No new notifications will be sent. Your 1,284 past
      deliveries stay here. You can turn it back on."*
- [ ] **Delete** states, before confirming: how many deliveries and events will be removed,
      whether they can be exported first, and that destination credentials are destroyed.
      Confirmation is typed (type the integration name) — the one place a typed confirmation is
      warranted.
- [ ] **Disconnecting the GitHub source** is distinguished from deleting the integration, and
      states what happens to events already in flight.
- [ ] The health section uses the **real** delivery ledger (F184). Until it exists, it renders
      the honest placeholder (F206) and says so.
- [ ] Every change is audited (F222) and every credential change is separately audited with a
      redacted diff.
- [ ] Unknown/broken configuration from an old version renders a **repair panel** naming the
      broken field and offering the fix, rather than a form that silently drops the invalid
      value (D12 — an unvalidated JSON column is exactly how a customer ends up with a rule that
      quietly stopped matching).

**Design** — The section order above is the product's mental model, expressed once. Everything a
customer changes about a connection lives on one screen in one order, which is the cheapest
possible answer to *"where do I turn that off?"* — and *"where do I turn that off"* is the
question `docs/COMPETITIVE-FEATURE-SET.md` identifies as the motive behind Zapier's 95%/7-day
auto-off complaint: *"the single most-recurring complaint pattern"* in automation
(<https://help.zapier.com/hc/en-us/articles/8496037690637-How-to-troubleshoot-errors-in-Zap-workflows>).
Zapier's response was to disable the customer's automation behind their back. Ours is a
Pause button with a stated consequence.

**Schema** — no new tables. Reads are composed from `integrations`, `github_installations`,
`destinations` and the F184 ledger, tenant-scoped on every join.

**Errors**

| Condition | Behaviour |
| --- | --- |
| Save rejected by server validation | Field-level error next to the field, the section stays dirty, nothing else is lost (3.3.1, 3.3.3) |
| Save partially applied | Must be impossible — each section is one transactional call, or explicitly non-transactional and stated |
| Configuration invalid for the current schema | Repair panel; the invalid value is quarantined and shown as raw text, never discarded |
| Destination capability changed since it was saved | Warning banner with the specific option that is now unsupported (F93) |

**Security** — Credentials are write-only (F211). The settings read endpoint never returns a
ciphertext, a webhook URL, or a partial secret beyond a host plus a four-character tail. Delete
destroys the credential rather than orphaning it. Every write is capability-checked (F24) and
audited (F222).

**Tests**
- `settings_render_credentials_as_write_only`
- `pause_preserves_history_and_states_the_consequence`
- `delete_confirmation_states_what_is_removed_before_it_happens`
- `unsaved_changes_block_navigation`
- `invalid_configuration_renders_a_repair_panel_and_never_drops_data`
- `every_settings_mutation_is_audited`
- `settings_are_tenant_scoped`

**Deps** — F24, F93, F97, F184, F222.

---

## F218 — Dead-letter queue and replay UI

**Priority** P0 · **Status** not started · **UI for F181/F182**

**Story** As a customer whose notifications stopped, I want to see what failed and retry it
myself, so that I do not have to wait for you to notice.

**Acceptance**

- [ ] Reachable from Overview when the dead-letter count is non-zero (a badge, not a banner
      storm), and always from `/destinations/dead-letters`.
- [ ] **Grouped first, listable second.** The primary view aggregates:
      *"#engineering · Slack · 412 failures in the last hour · `destination_revoked`"* — 412
      rows is not information. Expand gives the individual rows (F181).
- [ ] Each row: when, what the event was, destination, terminal taxonomy code, the plain
      explanation, the attempt count with per-attempt timestamps, and the **redacted** rendered
      payload (F181).
- [ ] ⭐ **Replay is a two-step action with a stated consequence:**
      1. *"Replay 412 notifications from #engineering since 09:00."* — a count, a window, a
         destination, and the rendered payload of the **first** item, so the user knows what
         will appear in their channel.
      2. *"Yes, send 412 notifications."*
      For more than 25 items the button reads *"Replay 412 notifications"* rather than
      *"Replay"*.
- [ ] Replay is **capability-gated** (F204) — a member without `replay` sees the rows and the
      reason, and no button.
- [ ] ⚠️ **A likely-still-broken destination warns before replaying.** If the same taxonomy code
      accounts for >80% of the selected rows, the panel says: *"These 412 failed because the
      Slack webhook was deleted. Replaying now will fail again. Reconnect it first."* with a
      link to the destination. This is the difference between a replay button and a support
      ticket generator.
- [ ] Every replay is audited (F182) and appears in the audit trail (F222) with the row count.
- [ ] A replayed delivery keeps its original history and gains a new attempt series with a
      `replayed_from` pointer (F182) — the UI shows both.
- [ ] **No replay of a successful delivery is offered anywhere.** A dead-letter list has no
      replay action; a suppressed-duplicate row offers *"Send anyway"* with a clear note that it
      may be an intentional duplicate.
- [ ] Replay of a suppressed *by filter* row is not offered (nothing failed).
- [ ] Empty state: *"No dead letters. 0 retries exhausted in the last 30 days."* (F181) — with
      the window stated so a quiet log is distinguishable from a short log.

**Design** — `AGENTS.md` asks for "dead-letter inspection and manual redelivery", and `12`
specifies both halves (F181/F182). The UI addition is the **probable-cause warning**, and it
exists because of Zapier's replay gap: Zapier documents that *"you cannot replay a filtered
Zap"* (<https://community.zapier.com/t/how-to-replay-filtered-task-20020> ⚠️ community) — a
customer who bulk-replays into a still-broken destination gets a channel flooded with nothing.
The warning is cheap, derived from data we already group by, and prevents the most damaging
misuse of the feature.

**Schema**

```ts
type DeadLetterRow = {
  delivery_id: string;
  dead_lettered_at: string;
  destination: { id: string; name: string; type: DestinationId };
  subject: string;
  terminal_code: TaxonomyCode;
  user_message: string;
  attempts: Array<{ n: number; started_at: string; http_status: number|null;
                    provider_code: string|null; taxonomy_code: TaxonomyCode; latency_ms: number }>;
  rendered_payload_redacted: string;
  replayable: boolean;
  replay_block_reason?: 'capability_missing' | 'destination_unhealthy' | 'already_replayed';
  replayed_from?: string | null;
};
type DeadLetterGroup = {
  destination_id: string; code: TaxonomyCode;
  count: number; first_at: string; last_at: string;
  sample_subject: string; dominant_cause: boolean;
};
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Replay requested with the capability missing | 403; the UI never showed the button |
| Destination still unhealthy | Warning + a one-click "reconnect first"; replay still permitted (the user may know something we don't) |
| Replay of an already-terminal delivery | Refused with *"This was already replayed on 12 Oct"* |
| Replay partially succeeds | Each delivery is independent; the result panel reports succeeded / failed / still-retrying counts |

**Security** — Replay re-sends content that may have been retracted (F182), so it requires a
capability, not membership, and is audited. The rendered payload is redacted exactly as in the
test preview (F98/F120). Replay is tenant-scoped: a user can never replay into another
workspace's destination, and the destination used is resolved from the delivery's own
`destination_id`, never from a client-supplied one.

**Tests**
- `dead_letters_are_grouped_with_a_count_before_listing`
- `replay_requires_the_replay_capability_and_the_button_is_hidden_without_it`
- `replay_confirmation_states_the_count_window_and_destination`
- `replay_of_a_likely_broken_destination_warns_first`
- `no_replay_action_exists_for_a_successful_delivery`
- `empty_dead_letter_state_states_the_window`
- `replay_is_audited_and_tenant_scoped`
- `payload_preview_is_redacted`

**Deps** — F180, F181, F182, F204, F222.

---

## F219 — Notification preferences UI

**Priority** P1 · **Status** not started · **UI for F147/F148/F150**

**Story** As a person receiving notifications, I want to control what reaches me without
asking an administrator, so that a noisy integration does not become something I have to
complain about.

**Acceptance**

- [ ] Rendered as **one plain sentence**, because the model is one plain sentence (F147):
      *"For acme/api → #engineering you get: failures, review requests and mentions.
       Set by the Failures only preset, changed by you on 3 Oct."*
- [ ] ⭐ **Show the resolved value and the winning level, both.** A user who changes a personal
      preference must see whether it took effect, or whether a workspace rule overrides it.
      Levels are named *"Your setting"*, *"Workspace rule"*, *"Integration default"* — not
      `level_2` / `user_override` / `default`.
- [ ] Where a workspace rule wins over a personal preference, the personal control is shown
      **disabled with the reason**: *"Your team's workspace rule requires all failures. You can
      still turn individual ones off."* Not silently ignored (F148).
- [ ] **Critical events are locked**, and the lock is explained, not merely enforced:
      ⚠️ A critical event (F148) carries the text *"Build failures on your release branch are
      always sent. Your team decided this — critical alerts cannot be muted."* with a link to
      who decided it. A lock without a reason reads as a bug.
- [ ] ⭐ **Sticky unsubscribe (F150).** The mute action taken from a notification (a Slack card
      button or a dashboard action) is **the same mute** the preferences screen edits — one
      model, one scope, one place it is visible. The preferences screen always shows current
      mutes, their scope (*this thread / this repository / this whole source*), and their expiry
      (F162). *"Muted until Monday 09:00 — created by you from a notification on 12 Oct."*
- [ ] Quiet hours (F146) are shown with **timezone spelled out** and the critical carve-out
      stated: *"Quiet hours 22:00–07:00 Europe/London. Critical failures still come through."*
- [ ] Changes apply **immediately and are visible immediately**, with an undo for 10 seconds.
      A mute that takes effect after a page refresh feels broken.
- [ ] Preferences are **per person**, not per workspace, and the screen says so: *"These
      settings are yours. They do not change what your team receives."* This distinction is
      the single most likely misreading and is stated on the screen, not in a tooltip.
- [ ] If a user's personal preference would suppress something critical, it is refused with the
      reason rather than silently downgraded.

**Design** — The three-level model is Novu's documented structure and is the right one
(<https://github.com/novuhq/docs/blob/main/content/docs/platform/concepts/preferences.mdx>).
Novu also ships an escape hatch for critical notifications; ours is F148. What Navu-style
products generally do *not* do — and what `11:F150` identifies as our opportunity — is make the
**source of the effective setting visible**, so a user never has to guess whether their change
did anything. Rendering "who won" is what makes a three-level model comprehensible to a
non-technical user; without it, three levels is just three places to fail.

**Schema** — reads F147's `preferences`; writes are ordinary capability-checked mutations. No
new tables. Mutes are F162's, displayed not reimplemented.

**Errors**

| Condition | Behaviour |
| --- | --- |
| Workspace rule overrides a personal setting | Personal control disabled with the rule's name and who set it |
| Critical event would be suppressed | Refused: *"Critical alerts can't be turned off here."* |
| Preference change races with a role change | Server wins; the UI re-fetches and shows the effective value |
| No mutes | *"Nothing is muted."* |

**Security** — Preferences are personal but **tenant-scoped**: a user may only write preferences
for themselves within a workspace they are a member of. Mutes are audited (F222). Effective-value
disclosure must not leak another user's configuration — the screen shows *my* effective value
and *the rule that produced it*, never another member's personal choice.

**Tests**
- `effective_setting_is_rendered_as_one_sentence_with_its_winning_level`
- `workspace_override_disables_the_personal_control_with_a_reason`
- `critical_lock_is_explained_and_names_who_set_it`
- `mute_taken_from_a_notification_is_visible_in_preferences`
- `quiet_hours_show_timezone_and_the_critical_carve_out`
- `preference_changes_apply_immediately_with_undo`
- `preferences_are_per_person_and_say_so`
- `preferences_are_tenant_scoped`

**Deps** — F147, F148, F149, F150, F162, F222.

---

## F220 — Plain-language error message system

**Priority** P0 · **Status** not started · **Referenced (as "F20") by `01:F13`**

**Story** As a user, I want errors to tell me what happened and what to do, so that I can fix
them without reading a log.

**Acceptance**

- [ ] Every user-facing error has **four parts**, in this order:
      `what happened (one sentence)` → `what it means for you (one sentence)` →
      `the next action (a button or a named instruction)` → `details (collapsed, correlation
      id only)`.
- [ ] ⭐ **Banned in user-facing text**, enforced by a CI test over the message catalogue:
      | Banned | Why |
      |---|---|
      | Stack traces, `at Foo.bar (file:12)` | Unactionable; implies a bug report is the next step |
      | Raw taxonomy codes as the *primary* message | `destination_revoked` is a support key, not a sentence |
      | HTTP status codes as the primary message | "HTTP 410" means nothing to this user |
      | Provider response bodies | These routinely echo back webhook URLs and tokens (F13) |
      | "Invalid", "Error", "Something went wrong" **alone** | No next action |
      | "Unexpected error" | Same |
      | Blaming the user ("you entered an invalid…", "you don't have permission" unless they do) | Say what the system could not do |
      | Any claim of success | Forbidden globally — see F185, F100 |
- [ ] The F13 taxonomy maps to copy, and the **primary** message never shows the code:

| Code | Primary message | Next action |
| --- | --- | --- |
| `destination_url_rejected` | That address isn't a {destination} webhook address. | *"Show me the steps"* → F212 |
| `destination_credentials_invalid` | {Destination} rejected the credentials we saved. | *"Reconnect"* |
| `destination_revoked` | This connection was removed in {destination}. Notifications can't be sent to it. | *"Reconnect"* |
| `destination_unauthorized` | {Destination} refused the request. The connection may need new permission. | *"Reconnect"* |
| `destination_rate_limited` | {Destination} asked us to slow down. We're retrying automatically. | None — show next retry time |
| `destination_unavailable` | {Destination} didn't respond. We're retrying automatically. | None; escalates to the circuit-breaker notice (F183) |
| `payload_too_large` | This notification is {n} KB and {destination} accepts {m} KB. | *"Reduce what's included"* |
| `render_failed` | There's no message format this destination can use. | *"Change the format"* |
| `config_invalid` | This integration has a setting we can't read. | *"Open repair"* → F217 |
| `internal_error` | Something went wrong on our side. Your notifications are still queued. | None. `correlation_id` shown |

- [ ] The **code** appears only inside the collapsed *"Details for support"* block, alongside
      the correlation id (F11) — which is also copyable, because it is what makes a support
      reply useful.
- [ ] `signature_invalid`, `replay_detected` and `unauthorized_tenant` **never surface**. They
      are not user errors and their visibility teaches an attacker about the verification
      boundary.
- [ ] Errors are **per-field where per-field**, **per-section where per-section**, and
      `role="alert"` + programmatically associated with the field (3.3.1). A page-level banner
      for a single bad input is not acceptable.
- [ ] Every error offers a way forward that is *doable in the UI*, except
      `internal_error`, which must not promise anything: no "try again" loop that cannot help,
      and no *"our team has been notified"* unless an alert actually fires — that claim must be
      backed by the F191 metric or removed.
- [ ] Error copy is **localisable** (F224) and stored as message ids, not literals, so no error
      string is assembled by concatenation.
- [ ] A **copy test** is a required acceptance item: every message in the catalogue is read
      aloud by a non-author and must pass *"I know what happened and what to do next."*

**Design** — The `⚠️` rows in the table are the interesting ones. `destination_rate_limited` and
`destination_unavailable` get **no action button**, because there is nothing the user can do and
a disabled-looking "Retry" would invite a support ticket. The correct message is an assurance
plus a timestamp. Conversely `internal_error` gets no action for the same reason — the
distinction is that a retry is invisible and automatic for the first two, and pointless for the
third.

The CI lint on the catalogue is the mechanism. A rule nobody runs is a comment.

**Schema**

```ts
type UserMessage = {
  id: string;                       // stable, localisable key: 'error.destination_revoked'
  params: Record<string, string>;   // only {destination}, {n}, {m} — no arbitrary HTML
  next_action?: { kind: 'route'|'reconnect'|'repair'|'steps'|'none'; href?: string };
  support_detail: { show: boolean; include_code: boolean; include_correlation_id: true };
  retry?: { scheduled_for: string | null };
};
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Taxonomy code has no message | Unit test fails the build (F13 already requires a message for every code) |
| Message renders `undefined` in a param | Development build shows `«n»`; production logs a metric and renders a safe fallback — never the literal word `undefined` |
| Provider string would be shown | Structurally impossible: the message catalogue has no field for provider text |

**Security** — The server selects the message by code; **the client never renders a server
string**. Provider text reaches the client only inside the redacted diagnostic bundle, behind
the collapsed disclosure, and is itself passed through F12 first. This removes an entire class
of reflected-content bug.

**Tests**
- `no_user_facing_message_contains_a_stack_trace`
- `no_user_facing_message_leads_with_a_taxonomy_code_or_http_status`
- `every_taxonomy_code_has_a_message_and_a_next_action_or_none`
- `internal_errors_do_not_promise_team_notification_unless_an_alert_fires`
- `signature_invalid_never_surfaces_to_a_user`
- `field_errors_are_associated_with_their_input`
- `messages_are_selected_by_id_not_rendered_from_server_text`
- `rate_limited_and_unavailable_show_no_action_button`

**Deps** — F11, F12, F13, F99, F224.

---

## F221 — Accessibility

**Priority** P0 · **Status** not started

**Story** As a person who uses a keyboard or a screen reader, I want the whole product to work
without a mouse and without sighted assistance, so that I am not locked out of my own alerts.

**Acceptance** — target is **WCAG 2.2 AA**
(<https://www.w3.org/TR/WCAG22/>, W3C Recommendation 12 December 2024, read 2026-10-13).
"AA" means every A and AA criterion; the nine criteria new in 2.2 are listed explicitly because
they are the ones a 2.1-era audit misses.

- [ ] **All of 1.1.1–4.1.2 at A and AA**, with specific attention to:
      | Criterion | Requirement in this product |
      |---|---|
      | 1.4.3 Contrast (Minimum) AA | 4.5:1 body, 3:1 large text. Measured per token in F206 |
      | 1.4.11 Non-text Contrast AA | 3:1 on focus ring, input borders, chart series, status chips |
      | 1.4.1 Use of Color A | Status is text + icon, never colour (F213, F145) |
      | 1.4.10 Reflow AA | 320 CSS px, no two-dimensional scrolling (F223) |
      | 1.4.12 Text Spacing AA | No loss of content at the specified overrides |
      | **2.4.11 Focus Not Obscured (Min) AA** | ⭐ Sticky wizard bar and sticky table header **must not** cover a focused control. This is the 2.2 criterion most likely to be broken by F216's sticky next-step bar |
      | **2.5.8 Target Size (Min) AA** | 24×24 CSS px minimum; we target 44×44 for primary mobile actions (F223) |
      | **2.5.7 Dragging Movements AA** | Repository reorder and filter reordering need non-drag alternatives (F209) |
      | **3.2.6 Consistent Help (A)** | Help link in the same relative position on every screen |
      | **3.3.7 Redundant Entry (A)** | Re-entering information previously given in the same process is auto-populated |
      | **3.3.8 Accessible Authentication (Min) AA |** | Passkey and email codes; no cognitive-function test, no puzzle (Better Auth `@better-auth/passkey` is already wired) |
      | 4.1.3 Status Messages AA | `role="status"` / `role="alert"` live regions for async results (test result, install callback, save) |
- [ ] **Keyboard**: every function reachable by keyboard; no traps (2.1.2); a visible focus ring
      on every interactive element (2.4.7); a **skip link** to main content (2.4.1); the wizard's
      step indicator is an ordered list, not interactive decoration; tables have real
      `<th scope>`; the delivery log's row → detail is a link, not a click handler on `<tr>`.
- [ ] **Focus management** is specified, not incidental:
      | Transition | Focus goes to |
      |---|---|
      | Route change (TanStack Router) | `<h1>` (or the main landmark), announced |
      | Dialog open | First focusable inside; trapped; `Esc` closes |
      | Dialog close | The trigger |
      | Inline validation error | The first invalid field, **after** submit, not on every keystroke |
      | Toast | Never steals focus; `role="status"` only |
      | Async result (test delivered) | A `role="status"` region, focus unchanged |
      | Destructive confirm dialog | The **cancel** button, so a stray `Enter` does not delete |
- [ ] ⭐ **Screen readers, including the destination rule.** Slack's own documentation states
      that *"screen readers will default to the top-level text field of your post, and will not
      read the content of any interior blocks"*
      (`docs/DESTINATION_API_REFERENCE.md` §1.6). Therefore the Slack renderer **must always
      populate the top-level `text` field as a complete, meaningful fallback** — not a
      placeholder, not "New notification". It carries the same summary as the card and the same
      source link. This is a rendering requirement (F94/F143) surfaced here because it is an
      accessibility requirement, and it is covered again because getting it wrong is invisible
      to sighted QA. The same principle applies to every destination with a fallback field.
- [ ] ⚠️ **Do not claim a conformance level we have not tested.** No "WCAG 2.2 AA compliant"
      claim on the marketing site until an automated scan **and** a manual keyboard and screen
      reader pass have been run and recorded. `docs/AGENTS.md` and `docs/SECURITY.md` prohibit
      unevidenced claims; an accessibility claim is a legal-adjacent claim.
- [ ] **In CI**: `axe-core` against the built app on every page state (including empty, error,
      loading and dialog-open), failing the build on **serious** or **critical** violations.
      Automated scanning catches roughly a third of issues and is a floor, not the assessment.
- [ ] **Manually, before every release**: keyboard-only pass of the full setup journey
      (F216), one screen-reader pass of the same journey, and 200% zoom + 320 px reflow.
- [ ] ⚠️ **The F226 participant sample does not include anyone with a stated accessibility
      need** (see F226). The WCAG conformance claim therefore rests on criteria testing and
      expert review, not on the usability study. That limit is stated, not glossed.
- [ ] Reduced motion honoured via `prefers-reduced-motion` (2.3.3 / 2.2.2 for any auto-updating
      content — the live delivery tail in F213 must offer a stop control).
- [ ] ⭐ **`AGENTS.md`'s explicit validation list**, each a named check with a recorded result:
      desktop **and 320 px mobile reflow** · keyboard focus · contrast · reduced motion ·
      **Vietnamese diacritics**. The last is not a nice-to-have: `DESIGN.md` §6 specifies Geist
      with a **Vietnamese** subset, a dedicated `line-height: 1.14` for Vietnamese display text,
      and the rule *"Never clip diacritics or shrink Vietnamese body text."* Geist loaded
      without the Vietnamese subset renders Vietnamese as fallback glyphs with clipped tone
      marks — invisible to a Latin-only reviewer and a total failure for a Vietnamese reader.
      `line-height: 1.14` must be applied per-script, not globally.
- [ ] Contrast is verified **against the rendered pairs in `DESIGN.md` §5**, including the Civic
      Navy inversion and the glass navigation dock over a moving Paper White background. Glass
      over content is the classic AA failure, and it is why `AGENTS.md` mandates the
      reduced-transparency fallback: the dock's text must pass 4.5:1 over the *lightest and
      darkest* content it can overlap, not over the average.
- [ ] `forced-colors` / Windows High Contrast is supported: glass degrades to a solid system
      colour, borders stay visible, and nothing relies on a gradient or background image to be
      perceivable (1.4.11).

**Design** — Two specific traps justify this feature existing separately from "make it accessible".
The first is **2.4.11 Focus Not Obscured**, new in 2.2 and directly threatened by the design
decision in F216: a sticky next-step bar is excellent for a non-technical user and it will
obscure a focused control at the bottom of a long form unless scroll-margin is set on every
focusable element. The second is the Slack top-level-text rule: our Slack renderer is in the
Worker and invisible to any frontend accessibility test, so it would pass every CI gate while
shipping a notification that a screen-reader user cannot read at all. Accessibility defects have
to be named individually, because that is the only way they get found.

**Schema** — none. CSS logical properties (`margin-inline-start`, `inset-inline-end`) rather
than `left`/`right` for F224's RTL readiness; `scroll-margin-block-end: 5rem` on all focusable
elements in the wizard.

**Errors**

| Condition | Behaviour |
| --- | --- |
| Automated scan finds a serious/critical violation | Build fails |
| A new component has no focus-visible style | Lint/test fails |
| A destination adapter omits the fallback field | Adapter conformance suite fails (F91 suite, extended here) |

**Security** — n/a. One adjacent rule: accessibility exceptions are never granted to avoid
building a feature ("it's fine, it's a preview").

**Tests**
- `axe_scan_fails_the_build_on_serious_or_critical_violations`
- `every_page_state_is_scanned_including_dialog_open`
- `focus_moves_to_the_h1_on_route_change`
- `destructive_dialog_focuses_cancel_first`
- `focused_control_is_not_obscured_by_the_sticky_wizard_bar`
- `slack_renderer_always_populates_a_meaningful_top_level_text`
- `no_marketing_page_claims_conformance_without_a_recorded_test_run`
- `skip_link_reaches_main_content`
- `all_rows_in_the_delivery_log_are_reachable_by_keyboard`
- `vietnamese_text_renders_with_unclipped_diacritics`
- `glass_navigation_passes_contrast_over_lightest_and_darkest_overlap`
- `forced_colors_mode_degrades_glass_to_a_solid_system_colour`

**Deps** — F206, F91, F94, F143, F216, `DESIGN.md`.

---

## F222 — Audit trail and change history

**Priority** P0 · **Status** not started · **Referenced by `05:F68` as the write trigger for
installation lifecycle events**

**Story** As an administrator, I want to see who changed what in my workspace, so that I can
answer "who turned that off?" and prove nothing changed silently.

**Acceptance**

- [ ] ⚠️ **Write trigger**: every GitHub App installation lifecycle transition writes an
      `audit_events` row — `installation.created`, `installation.deleted`,
      `installation.repositories_added`, `installation.repositories_removed`,
      `installation.suspend`/`unsuspend`, and `installation.new_permissions_accepted`. This is
      the requirement `05:F68` points at, and it is why F222 is in this file rather than only in
      a logging spec.
- [ ] Also written, from this file's surfaces: integration created / updated / enabled /
      disabled / deleted · destination added / replaced / removed · credential rotated ·
      **replay executed** (F182) · mute created (F162) · preference changed (F219) · member
      invited / removed / role changed · export generated · workspace deletion requested
      (F30) · AI enabled or disabled (fwd ref `16:F252`) · plan or quota changed
      (fwd ref `16:F253`).
- [ ] **Read side**: `/audit`, filterable by actor, action, target type, target, time range and
      correlation id; filter state in the URL; paginated with a stated total.
- [ ] Each entry shows: **who** (name and email), **when** (absolute + relative), **what**
      (action, phrased for a human: *"Dana disabled the acme/api integration"*), **which**
      (target link), and a **non-secret diff** of changed fields.
- [ ] ⭐ **Secrets are represented by their occurrence, never their value:** `"webhook_url":
      "changed"` — not a hash, not a prefix beyond what F211 already shows, not a length, not a
      masked tail. A diff renderer that can emit a secret is a leak waiting for a bug.
- [ ] Actor rendering distinguishes **a human, the system, and an installation**: *"GitHub
      installation acme/apps"*, *"Noti (system)"*, *"Dana Okonkwo (dana@acme.com)"*. The third
      case — an action taken by GitHub on someone else's behalf — is the one that explains most
      confusing audit entries.
- [ ] Retention is stated and enforced: audit rows follow the workspace retention policy
      (F51) and export is available before deletion (F30). The screen says what will be
      removed when a workspace is deleted.
- [ ] **Non-members cannot read the audit trail**, including support staff acting on a user's
      behalf; support access uses a separate, disclosed, time-boxed mechanism.
- [ ] Audit writes are **append-only**. No UI affordance edits or deletes a row; the retention
      job is the only remover and it is itself audited.

**Design** — An audit trail that the customer can read is a differentiator against the
category's norm and a direct consequence of `AGENTS.md`'s "audit events" invariant being about
*the customer's* ability to trust the system, not ours. Zapier's failure mode is instructive:
its most-recurring complaint is that an automation was disabled and nobody could find out why
or by whom (<https://help.zapier.com/hc/en-us/articles/8496037690637-How-to-troubleshoot-errors-in-Zap-workflows>).
We have the data to be the product that answers that question in one click — provided the trail
is customer-visible and says "GitHub removed the app" when that is what happened.

**Schema**

```sql
CREATE TABLE audit_events (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,                 -- F02: the tenant boundary
  actor_type    TEXT NOT NULL CHECK (actor_type IN ('user','system','installation','api_key')),
  actor_id      TEXT,                          -- user id, or installation id
  actor_label   TEXT NOT NULL,                 -- rendered display label, frozen at write time
  action        TEXT NOT NULL,                 -- closed set; see the table above
  target_type   TEXT NOT NULL,                 -- 'integration'|'destination'|'installation'|'member'|'workspace'|'replay'
  target_id     TEXT,
  target_label  TEXT,                          -- frozen so history survives renames/deletion
  diff          TEXT,                          -- JSON: field -> {from,to}; secrets -> "changed"
  correlation_id TEXT,
  occurred_at   INTEGER NOT NULL
);
CREATE INDEX ix_audit_org_time ON audit_events(org_id, occurred_at DESC);
CREATE INDEX ix_audit_org_actor ON audit_events(org_id, actor_id, occurred_at DESC);
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Target deleted after the event | Row survives with the frozen `target_label` and no live link |
| Actor account deleted | Row survives with the frozen `actor_label` |
| Audit write fails | The **action** fails. There is no unaudited write path |
| Export too large | Bounded job, tenant-scoped, rate-limited, audited, delivered as a signed link with an expiry |

**Security** — Tenant-scoped on read **and** write (F26). Diff values pass through an explicit
denylist of field names (`webhook_url`, `token`, `secret`, `signing_key`, `client_secret`,
`ciphertext`, `private_key`) rendered as `"changed"` **in the writer**, not in the renderer.
Exports are tenant-scoped, time-limited, and themselves audited. No audit row contains a
webhook URL, a token, or a raw event payload.

**Tests**
- `installation_lifecycle_transitions_write_audit_rows`
- `every_action_in_the_list_writes_exactly_one_row`
- `no_audit_diff_ever_contains_a_secret_value`
- `audit_rows_survive_target_and_actor_deletion`
- `audit_is_tenant_scoped_and_append_only`
- `unauthenticated_write_is_impossible`
- `actors_distinguish_user_system_and_installation`

**Deps** — F28, F26, F24, F68, F182.

---

## F223 — Responsive and mobile UX

**Priority** P0 · **Status** not started

**Story** As someone who reads notifications on my phone between meetings, I want the dashboard
to work on a small screen, so that I can check whether my alerts are working from anywhere.

**Acceptance**

- [ ] **Breakpoints**: `sm 320` (floor) · `md 768` · `lg 1024` · `xl 1280` (full sidebar).
- [ ] ⭐ **WCAG 1.4.10 Reflow (AA)**: at 320 CSS px no page requires two-dimensional scrolling,
      with the standard data-table and image exceptions. The **delivery log and event log tables
      are therefore explicitly excepted from reflow** and use the card pattern below; every other
      page reflows normally.
- [ ] **Data tables → cards.** At `< md`, a table row becomes a stacked card: subject, outcome
      chip, destination, time. Sort and filter move to a collapsible sheet above the list.
      Horizontal scrolling of a 5-column table is **not** an acceptable mobile pattern for the
      screen this product is judged on.
- [ ] **Wizard**: single column, one decision per screen on `< md`; a **sticky footer bar** with
      `Back` / `Continue` and the step count, offset so it never obscures a focused control
      (2.4.11 — F221); the step list collapses to *"Step 3 of 7"* with an expandable list.
- [ ] **Sidebar** becomes a drawer behind a labelled hamburger, with a focus trap, `Esc` to
      close, and focus returned to the toggle.
- [ ] **Tap targets** ≥44×44 CSS px for primary actions, and **all controls ≥44 px tall** per
      the `AGENTS.md` contract (this exceeds the 24×24 AA floor in 2.5.8); icon buttons get
      padding rather than relying on an icon's bounding box. Body text is ≥16 px and metadata
      ≥12 px on **every** breakpoint — the common mobile failure is shrinking metadata to 11 px
      to fit, which the contract forbids.
- [ ] **No hover-only affordance** anywhere. Anything that appears on hover in desktop (row
      actions, tooltips, the credential hint) is reachable by tap, and the tooltip content is
      also available on focus.
- [ ] **Orientation**: portrait and landscape both work (1.3.4); nothing is locked to landscape.
- [ ] **Mobile-specific journeys** are named and must work end-to-end on a 320 px viewport:
      view the delivery log · open one delivery and read its status · acknowledge/silence a
      notification from F219 · send a test · pause an integration. These are what the target user
      does on a phone.
- [ ] ⭐ **The GitHub install flow is a full-page navigation (F208)** specifically because
      mobile browsers block popups. The return lands on a screen that works at 320 px.
- [ ] Images and provider logos are `max-width: 100%; height: auto` with explicit dimensions to
      avoid layout shift (F225).
- [ ] Testing matrix in CI: Playwright at 320, 375, 768, 1280 px across the setup wizard, the
      delivery log, and one dialog — screenshots compared to a checked-in baseline only for
      **regression detection**, never published as product screenshots (F212 forbids that).
- [ ] **Vietnamese is the named reflow-and-diacritics fixture.** `DESIGN.md` treats Vietnamese
      as a first-class case, so the 320 px pass runs against the **longest Vietnamese strings in
      the catalogue** (the wizard step titles and the error catalogue), not the English ones.
      Vietnamese runs roughly 20–30% longer than English for the same meaning; a layout that
      passes in English at 320 px and clips in Vietnamese is the failure this catches.

**Design** — Responsive design here is not a layout concern; it is an onboarding concern.
The median-setup hypothesis is measured in moderated sessions and moderators overwhelmingly run
participants on their own laptop, but the **post-setup** check — "did it work?" — happens on a
phone. A product whose status screen only works on a laptop forces a return to the laptop to
answer the only question that matters on day one.

**Schema** — none. Tailwind 4 with CSS logical properties (F221/F224).

**Errors**

| Condition | Behaviour |
| --- | --- |
| Viewport < 320 px | Content still usable; horizontal scroll allowed below the floor with no loss |
| Very long repository/branch names | Truncate with an ellipsis, full value in `title` and on focus |
| Sticky bar overlaps a focused control | `scroll-margin-block-end` is the fix; covered by F221's test |
| No JS / slow network | The status of each step is server-rendered enough to be readable without hydration |

**Security** — n/a, with two adjacent rules that are not. Mobile layouts must **not** introduce a
second, weaker authorisation path: there is no privileged action reachable from a compact layout
that is absent from the desktop layout, and the drawer's nav items are subject to the same
capability checks (F24). And the 320 px matrix is a **regression harness, not a publication
channel** — its screenshots live in CI artefacts, never in `docs/assets/` (F212 forbids
publishing a captured image as a product screenshot, and a CI baseline screenshot of a test
fixture would breach that by accident).

**Tests**
- `every_page_reflows_at_320_css_px`
- `vietnamese_longest_strings_reflow_at_320_css_px`
- `delivery_log_renders_as_cards_below_the_md_breakpoint`
- `no_primary_journey_requires_horizontal_scrolling_on_mobile`
- `tap_targets_meet_44px_and_controls_are_44px_tall_at_every_breakpoint`
- `body_text_is_16px_and_metadata_12px_at_every_breakpoint`
- `no_affordance_is_hover_only`
- `drawer_traps_focus_and_returns_it_on_close`
- `install_callback_works_at_320_px`
- `playwright_matrix_runs_on_every_pr`

**Deps** — F205, F216, F221.

---

## F224 — Internationalisation and translated-ready strings

**Priority** P1 · **Status** not started

**Story** As a user who does not read English, I want the product in my language, so that setup
does not require an interpreter.

**Acceptance**

- [ ] ⚠️ **`docs/PRODUCT.md` names a nontechnical audience and `AGENTS.md` requires
      "translated-ready strings". Translated-ready is not translated.** The acceptance here is
      structural: a string catalogue, no concatenation, locale-aware formatting, and no
      hardcoded locale assumptions. A second locale is a separate commitment and is **not**
      claimed.
- [ ] ⭐ **Vietnamese is the design-time reference locale and is validated in V1**, because
      `DESIGN.md` §6 specifies Geist's **Vietnamese subset**, a Vietnamese-specific display
      `line-height: 1.14`, and an explicit prohibition on clipping diacritics — and `AGENTS.md`
      requires validating "Vietnamese diacritics" before launch. That is a **design-system
      obligation**, and it does not by itself commit us to shipping a Vietnamese UI. What V1
      owes: the catalogue handles plural categories Vietnamese needs, the font stack loads the
      subset, line-height is applied per-script, and the fixture strings exist so the layout is
      proven before anyone commits to a translation.
- [ ] **Plural categories are locale-correct, not English-correct.** ICU MessageFormat's `plural`
      needs `ordinal` and `exact` categories where the locale has them, and zero is often its
      own form. An English-only catalogue that renders *"1 notifications"* in every locale is
      the most visible translation bug and the cheapest to prevent now.
- [ ] **Every user-facing string is a catalogue entry** with a stable id. Zero literals in
      components. A CI check greps for quoted English in `web/src/**/*.tsx` outside
      `web/src/i18n/` and fails the build.
- [ ] ⭐ **No string concatenation, ever.** Placeholders use ICU MessageFormat, with real
      plural rules — `"{count, plural, one {# notification} other {# notifications}}"` — because
      a naive `"# notification(s)"` is the marker of an app that was never localised. Noto
      counts, Teams mention counts and delivery counts all go through it.
- [ ] All dates, times, numbers and durations use `Intl.DateTimeFormat` / `NumberFormat` /
      `RelativeTimeFormat`. Timestamps are stored UTC and rendered in the **user's** timezone;
      the timezone is **named** wherever a time governs behaviour (quiet hours, digest send
      time) because an unqualified time is a bug report waiting to happen.
- [ ] `<html lang>` is set per locale; `lang` is set on inline content in another language
      (3.1.1/3.1.2). Locale lives in the route (`?locale=` or a path prefix) so a link carries it.
- [ ] ⭐ **The cross-locale trap is called out explicitly** (F212): the user reads our UI in
      their language and then lands in **Microsoft/Lark/Slack's admin UI in the provider's
      language**. Every instruction that crosses that boundary says which language the screen is
      in and uses the **verbatim label from that UI** — the Lark step is `设置` → `群机器人`
      because those are the actual characters on the screen, translated in parentheses.
- [ ] **Provider strings are never shown raw.** A `destination_unauthorized` error is our
      message, not Slack's. Where a provider message is genuinely useful it appears in the
      collapsed support detail, translated or not, clearly attributed.
- [ ] Layout is RTL-ready without shipping RTL: CSS logical properties only; **no `left`/`right`,
      no directional icon-only arrows** (use `ChevronRight` that mirrors, or `ChevronDown`);
      no `text-align: right` where `text-align: end` is meant; no hardcoded icon meaning.
- [ ] Icons are paired with text or `aria-label`, never used as the only carrier of meaning.
- [ ] Any string that may grow is width-safe: no fixed-height single-line containers, and the
      delivery-log status column does not assume a fixed chip width.
- [ ] **Screenshot pipeline is locale-aware** (F212): a capture is tagged with `locale`, and an
      instruction step whose screen text is language-dependent is either re-captured per locale
      or marked as showing the **English** UI with an explicit note.
- [ ] Error messages come from the catalogue by id (F220), so an untranslated error is a
      **missing key**, which a CI check reports, rather than an English string leaking through.
- [ ] Dates in the delivery log sort and filter consistently regardless of locale: filtering is
      by ISO timestamp, never by a parsed localised string.

**Design** — The Lark case is the concrete reason translated-ready is in V1 scope rather than a
later i18n ticket: Lark's custom-bot creation flow is a Chinese-labelled menu
(`设置` → `群机器人`) in **both** the Lark and Feishu products, and our primary wedge
destination is Lark. A user who cannot read that menu cannot complete setup, and we cannot
influence the provider's UI. The only lever we have is to prepare the exact characters in
advance, which is a translation problem in our interface, not in theirs.

Second design decision: **no concatenation means no locale can leak English into a translated
string.** The alternative — a template with `${count}` baked in — looks fine in English and
produces word salad in every other language, discovered only after a launch.

**Schema**

```ts
// web/src/i18n/messages.en.ts — the catalogue
export const messages = {
  'error.destination_revoked': '{destination} removed this connection. Notifications can\'t be sent to it.',
  'delivery.count': '{count, plural, one {# notification} other {# notifications}}',
  'setup.step.current': 'Step {current} of {total}: {title}',
  'wizard.completion': 'GitHub events from {repositories} repositories are now going to {destination}.',
  'empty.deliveries': 'No notifications in the last {window}.',
} as const;
export type MessageId = keyof typeof messages;
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Missing catalogue key | Development: `«id»`; production: a logged metric and a safe fallback, never raw English |
| Unknown locale in the URL | Fall back to default and **keep** the requested value in the UI so the user can see what they asked for |
| Locale changes mid-flow | Setup state is server-side (F207), so it survives; open forms are re-rendered with unsaved values preserved |
| String exceeds the layout | Wraps; no truncation of an error message, ever |

**Security** — Translated strings are **not** HTML. No `dangerouslySetInnerHTML` for catalogue
values (F94's rendering-safety rule applies to the dashboard as well as the destination
payloads). Interpolation of user-supplied values — repository names, actor names — is escaped
by the template layer, not by the translator.

**Tests**
- `no_user_facing_string_literals_exist_outside_the_catalogue`
- `no_template_string_concatenation_in_user_facing_text`
- `plural_forms_use_icu_messageformat_with_locale_correct_categories`
- `vietnamese_fixture_strings_render_without_clipped_diacritics`
- `geist_vietnamese_subset_is_loaded_with_font_display_swap`
- `vietnamese_display_line_height_is_applied_per_script`
- `all_dates_and_numbers_use_intl_formatters`
- `untranslated_key_is_reported_and_never_leaks_english`
- `css_uses_logical_properties_only`
- `lark_instruction_step_names_verbatim_chinese_labels`
- `screenshot_captures_declare_their_locale`

**Deps** — F206, F220, F212, F146, F221, F223, `DESIGN.md`.

---

## F225 — Loading, skeleton, empty and error states

**Priority** P0 · **Status** not started

**Story** As a user, I want every screen to tell me what is happening, so that I never sit
staring at a blank page wondering whether something broke.

**Acceptance** — one definition per state, enforced per component:

- [ ] **Loading**: a skeleton that matches the **shape** of the content (a row skeleton for a
      row, not a spinner over a whole page), with `aria-busy="true"` on the container and no
      layout shift when data arrives.
  - [ ] No spinner may persist beyond **10 seconds** without a message; beyond 30 seconds the
        skeleton is replaced by an error state.
  - [ ] Mutations use an **inline** pending indicator on the control that was pressed (the
        button becomes *"Sending…"* and is disabled), never a blocking overlay. This is already
        the existing pattern in `web/src/onboarding.tsx:43`.
  - [ ] Background refresh never replaces content with a skeleton — the current data stays and a
        subtle indicator shows.
- [ ] **Skeleton**: `Skeleton` is a component in the library (F206) with `width`, `height` and
      `lines`. It renders `aria-hidden` and the container carries `aria-busy`, so a screen reader
      hears "loading", not a paragraph of grey boxes.
- [ ] ⭐ **Empty states have three parts, always**: an **icon**, a **cause**, and an **action**.
      *"No integrations yet — nothing is connected to this workspace. Connect GitHub to get
      your first notification."* `[Connect GitHub]`
  - [ ] Every empty state names what would be here. *"No data"* is banned.
  - [ ] An empty state caused by a **filter** says so and offers *"Clear filters"*.
  - [ ] An empty state caused by **time** states the window: *"No notifications in the last 24
        hours"* (F213).
- [ ] **Onboarding empty states** — first-run, before anything exists:

| Screen | Empty state | Action |
| --- | --- | --- |
| Overview | *"Nothing is connected yet. Four steps to your first notification."* + the step list (F207) | *Start setup* |
| Integrations | *"No connections yet."* + the roadmap line (F206), **no clickable catalogue of unavailable sources** | *Connect GitHub* |
| Activity | *"No events have arrived yet. Once GitHub sends one, it appears here."* + *"Send a test instead"* | *Send a test* (F215) |
| Destinations | *"No destinations connected."* | *Connect a channel* |
| Dead letters | *"No dead letters. 0 retries exhausted in the last 30 days."* | — |
| Team | *"You're the only member so far."* | *Invite someone* |
| Audit | *"No recorded changes yet."* | — |

- [ ] **Partial states** exist and are common: three destinations where one is failing renders
  all three, with the failing one marked, rather than hiding the healthy ones. A screen that
  shows only failures trains users to distrust it.
- [ ] **Stale state**: data older than its refresh window shows *"Updated 4 minutes ago · Refresh"*;
  data older than 15 minutes additionally shows *"This may be out of date."* Health-check data
  (F98's daily job) is labelled with **when it last ran** — a stale green is worse than an
  honest grey.
- [ ] **Error state**: per F220 — plain message, next action, collapsed support detail.
- [ ] ⚠️ **An empty table is never rendered when the query failed.** The distinction between
      "no results" and "could not load" is the whole value of an empty state, and conflating
      them is how a product silently lies about reliability. `web/src/pages.tsx:15` currently
      gets this right with an explicit *"API is not implemented yet"* string; that specificity
      is the model.
- [ ] All five states (loading, empty, partial, error, stale) are **covered by the F221
      axe-scan** and by the F223 viewport matrix.

**Design** — `AGENTS.md`: *"clear errors"*. The specific engineering consequence of that
sentence is the empty-vs-error distinction, and it is the one most often got wrong: a `catch`
that returns `[]` produces a truthful-looking empty table during an outage, which is worse than
a crash because the customer acts on it. In this product that means a failed delivery-log query
during an incident makes the customer believe their alerts stopped, when in fact we stopped
knowing. The rule is: **the catch block must return an error, never an empty array.**

**Schema**

```ts
type ViewState<T> =
  | { kind:'loading' }
  | { kind:'ready'; data: T; stale_at: string|null }
  | { kind:'empty'; reason:'never_had_data'|'filtered'|'time_window'; window?: string }
  | { kind:'partial'; data: T; failing: Array<{ id: string; error_code: TaxonomyCode }> }
  | { kind:'error'; error: UserMessage; support: { correlation_id: string } };
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Query error | `kind:'error'` — never `'empty'` |
| Query returns zero after a filter | `kind:'empty'` with `reason:'filtered'` + clear-filters action |
| A destination in the list fails to load | `kind:'partial'`; healthy destinations still render |
| Health check has not run | Stale/neutral, with *"Last checked never"* — never a green default |

**Security** — n/a. One rule: error states render through the message catalogue (F220), so the
client never displays a server-provided string.

**Tests**
- `failed_query_renders_an_error_state_not_an_empty_table`
- `every_empty_state_names_a_cause_and_an_action`
- `filtered_empty_states_offer_clear_filters`
- `empty_states_state_their_time_window`
- `skeletons_match_content_shape_and_do_not_shift_layout`
- `partial_state_renders_healthy_destinations`
- `stale_health_is_labelled_with_its_last_run_time`
- `all_five_states_are_covered_by_the_a11y_scan`

**Deps** — F206, F207, F215, F220.

---

## F226 — Usability test plan

**Priority** P0 · **Status** not started · **This is the gate, not the report**

**Story** As the product owner, I want the onboarding measured against real non-technical users
before we add connectors, so that we spend effort on observed friction rather than opinions.

**Acceptance**

- [ ] ⭐ **Nothing in this file is a measured result until this has run.** Until then,
      `docs/PRODUCT.md`'s two thresholds are hypotheses and every screen in this file is a
      *hypothesis about* setup difficulty. No marketing page, no changelog and no sales deck may
      cite "under 5 minutes" or "80% of users" — in either direction, including as a caveat that
      it is unverified.
- [ ] **Participants** (`docs/PRODUCT.md` §"Test with real users"):

| Group | n | Why this group |
| --- | --- | --- |
| Developers / DevOps | 5 | Know GitHub, do not know our product |
| Operations staff | 3 | Non-technical, high tolerance for procedure, no GitHub fluency |
| Non-technical managers | 2 | **The defining audience.** If these two succeed, the product thesis holds |

- [ ] ⚠️ **Stated limitation, recorded in the study write-up:** this sample contains **no
      participant with a stated accessibility need**. F221's WCAG claim therefore rests on
      criteria testing and expert review, not on this study. Do not let "validated with 10
      users" imply accessibility validation.
- [ ] **Method**: **moderated, unassisted, in person or screen-share.** Moderator does not help;
      help is only given after the participant has explicitly given up, and every intervention
      is recorded with a timestamp. Recording is screen + audio **with written consent**, with a
      stated retention period and a deletion process (F51).
- [ ] **Task script** (read verbatim, identical for every participant):
      1. *"Set up Lumi Noti so that when a pull request fails its checks on `acme/api`, someone
         in `#engineering` in Slack finds out. Do it however you would normally do it."*
      2. *"Check that it works."*
      3. *"Now make it stop sending you pull request comments."*
      4. *"Something stopped arriving. Find out why."*
      Each task has a **success criterion stated in advance** and a **failure reason taxonomy**:
      `couldn't_find` · `couldn't_understand` · `couldn't_complete_third_party` (attributed to
      the provider, not us) · `didn't_think_to` · `assumed_wrong_thing` · `technical_blocker`.
- [ ] **Measured, per participant and per task**:
      | Metric | Definition |
      |---|---|
      | Time on task | Wall clock from script delivery, **excluding** third-party admin approval waits (per `docs/PRODUCT.md`) and excluding time the participant spent waiting on someone else |
      | First hesitation | First moment of >10 s silence or a "what do I do" utterance, with a timestamp and the screen |
      | Outcome | Complete unassisted / complete with recorded help / abandoned / escalated |
      | Steps that produced a wrong turn | Count, with the step id |
      | Verbatim quotes of confusion | Collected verbatim, not paraphrased |
      | Stated mental model | Asked at the end: *"what do you think this product does?"* and *"who can see these notifications?"* |
- [ ] **Setup metric definition**, stated before data collection so it cannot be redefined
      afterwards: *"median successful setup"* = a participant who, unassisted, reaches a state
      where **one delivery is confirmed in the destination channel** (not merely a 202) within
      5 minutes of the task starting. Sample of 10 → report the **median and the full
      distribution**, never a mean, and never a rounded "about 3 minutes" without the spread.
- [ ] ⚠️ **What n=10 cannot support**, written into the report: no A/B claims, no statistical
      significance, no segment-level conclusions (5 developers ≠ 5 ops ≠ 2 managers as separate
      findings), no claim about "users" in general. It can support a ranked list of **observed
      friction**, and that is the only output `docs/PRODUCT.md` asks for.
- [ ] **Gate** (`docs/ROADMAP.md`): *"Proceed from P1 only if a real signed webhook reliably
      reaches a real destination and at least **8/10** target users can set it up without
      engineering help. Otherwise improve onboarding/reliability instead of expanding catalog."*
      The study reports against 8/10 **and** states the distribution. Missing the gate **stops
      the catalogue expansion** (GitLab, Sentry, Stripe, Cloudflare) — it does not start a
      redesign debate. Both conditions (real signed webhook + 8/10) must be met.
- [ ] **Reprioritisation rule** (`docs/PRODUCT.md`): *"Reprioritise by observed friction, not
      feature votes."* Each friction item carries: step id, participant count affected, whether
      it blocked completion, and a proposed fix. Fixes ranked by *blocked completions*, not by
      how many participants *mentioned* it.
- [ ] **Friction log** is a repo artefact (`docs/adr/` reference + a running table), updated in
      the same PR as each fix, so the decision trail survives.
- [ ] **Re-run triggers**: a new destination added, a wizard step reordered, a copy change to
      any setup string, or a support ticket naming a setup step — because any of those invalidates
      the measurement.
- [ ] ⭐ **The finding this study is designed to produce**: which step, if any, breaks the
      non-technical managers. If it breaks exactly there, the fix is in the copy or the defaults,
      **not** in adding a feature. The most expensive outcome would be a study that concludes
      "we need more configuration options".

**Design** — One design decision carries this entire feature, and it is the reason the study is
worth more than a survey.

`docs/PRODUCT.md` says the product is for a non-technical owner who needs "understandable setup".
F226 is the only mechanism that tests that claim against people rather than against the team's
intuition, and its output is a **ranked friction list**, not a score. The rank is by *blocked
completions* — how many participants could not finish because of this step — and never by how
many *mentioned* it. That distinction is the whole point: a step five people found confusing and
one person failed at is a support question; a step one person disliked and nine sailed through is
nothing.

The second decision is to **fix definitions before collecting data**. "Successful setup" is
defined here as *one delivery confirmed in the destination channel* — not a 202, not a spinner,
not a wizard reaching step 7 — because the looser definition is the one that would let the
product claim success while delivering nothing. Similarly the clock exclusion for third-party
admin approval is written before the first session, so it cannot be widened afterwards to rescue
a bad number.

The third is to **record the sample's limits in the report itself**: n=10 supports a friction
list and nothing else, and the sample contains no participant with a stated accessibility need,
so it is not evidence about accessibility (F221). A study that reports only its positive finding
is indistinguishable from marketing.

**Schema**

```ts
type StudySession = {
  participant_id: string;          // pseudonymous; PII in a separate consented store
  group: 'dev_devops'|'ops'|'nontechnical_manager';
  consented_at: string; recording_retained_until: string;
  tasks: Array<{
    task_id: 'setup'|'verify'|'reduce_noise'|'diagnose_stopped';
    started_at: string; ended_at: string;
    excluded_wait_seconds: number;   // third-party admin approval
    outcome: 'complete_unassisted'|'complete_helped'|'abandoned'|'escalated';
    help_interventions: Array<{ at: string; moderator: string }>;
    failure_reason?: StudyFailureReason;
    wrong_turns: string[];          // setup step ids
    first_hesitation: { at: string; screen: string } | null;
  }>;
};
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Participant cannot complete because of a **provider** admin wall | Counted as `couldn't_complete_third_party`, attributed to the provider, **excluded from the median clock** and reported separately. This is the exclusion `docs/PRODUCT.md` mandates |
| Participant asks for help before attempting | Recorded as a hesitation, not as a completion |
| Recording consent refused | Session runs unrecorded, notes only, and is flagged in the report |
| Participant declines the whole task | Counted as `didn't_think_to`, which is a friction finding, not a data point to discard |

**Security** — Recordings of non-technical participants include names, employers and screen
content with real data. Consent is written and specific; recordings are stored encrypted with a
stated expiry; **test workspaces only** — no participant's production workspace is used without
explicit written agreement; deletion is exercised at least once before V1 (F30).
`docs/PRODUCT.md` participants are colleagues and external staff: this is personal data.

**Tests**
- `study_cannot_report_setup_time_before_the_study_runs`
- `third_party_admin_waits_are_excluded_from_the_clock`
- `setup_success_requires_a_confirmed_delivery_not_a_202`
- `report_includes_the_full_distribution_not_just_a_median`
- `report_states_that_n_equals_ten_supports_no_significance_claims`
- `report_records_that_the_sample_excludes_accessibility_needs`
- `gate_reports_against_eight_of_ten_and_the_distribution`
- `friction_is_ranked_by_blocked_completions_not_mentions`
- `no_public_page_cites_the_unmeasured_thresholds`

**Deps** — F216, F215, F207, F212, `docs/ROADMAP.md`.