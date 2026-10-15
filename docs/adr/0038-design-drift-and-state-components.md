# ADR 0038: Design-token drift, no-fabricated-number checks and shared loading and empty states

Status: Accepted · Date: 2026-10-15 · Completes parts of F206 and F224 (spec 14), and the shared-state part of F225; builds on ADR 0002 and ADR 0025

## Context

ADR 0002 made `DESIGN.md` the visual authority and the shipped stylesheet the place its values live. Two
things were unchecked. First, nothing asserted that the values in `web/src/styles.css` equal the values
`DESIGN.md` states; only the colour block was compared, and only its first occurrence. Second, F206 says
"every displayed figure is read from an API" and "a design system whose primary job is honesty about
absence", but no test looked for a literal number rendered as data. The loading and empty states were
shared components in `web/src/components/state.tsx` (ADR 0025), yet four dashboard lists still drew their
own copies of the skeleton and the empty section.

Starting state, checked before any change: the colour, spacing, radius, type-stack, shadow and glass values
in `styles.css` all matched `DESIGN.md`. The one real hazard was that `styles.css` declared `--font-sans`,
`--shadow-card` and `--shadow-button` twice in `:root`. The later declarations won, so the shipped values
were correct, but the earlier copies were the rgba forms and nothing said which one a future edit would
change.

## Decision

### 1. Drift test (`web/src/design/tokens.drift.test.ts`)

`DESIGN.md` is read, not transcribed. `web/src/design/design-md.ts` finds the numbered heading (`# 5.`,
`## 8.4`) and returns its fenced ```css blocks; it throws if the heading is missing or holds no block, so a
moved or renamed section fails the test rather than passing over nothing. Blocks are parsed with the
stylesheet reader in `web/src/a11y/css.ts`.

Compared against the top-level `:root` of `web/src/styles.css`, with `var()` references resolved and
whitespace and case normalised:

- §5 colours: every canonical name and value. An extra `--color-*` that DESIGN.md does not define fails,
  unless it is in `COLOUR_ALIASES` with the exact declared form and a canonical target.
- §6.1 type stacks: the sans stack must be the DESIGN.md stack led by the bundled family `geist variable`.
  The package (`@fontsource-variable/geist`) registers that name, and FRONTEND.md records why a bare `geist`
  is not enough. The mono stack must equal DESIGN.md.
- §7 spacing: the scale block, and `--space-N` equal to N × 4 px. The naming is the convention this test
  enforces; a new step must follow it.
- §8.1 radii: the entries, one for one. A range such as `16–20px` admits any value inside it.
- §8.3 and §8.4: `--shadow-card`, `--shadow-button`, and the opaque glass values (background, border,
  box-shadow) from the first declaration of the §8.4 block.
- §8.2 and §13 sentences: the archival border, focus ring and severity-rail widths, and the 120–180 ms
  transition range.
- Every custom property is declared once in a top-level `:root`. A duplicate fails.

Checked by hand: a changed `--color-lumi-blue`, a changed `--space-3`, a changed `--radius-chip`, and a
re-added `--shadow-card` each fail the test, and each was reverted.

Two sources of DESIGN.md were rejected: a hand-maintained token table (a second copy of the values to
keep in step) and a test that compares only the first occurrence (the earlier defect).

**Change made.** The duplicate declarations of `--font-sans`, `--shadow-card` and `--shadow-button` in the
first `:root` block of `styles.css` were removed. The later block, which is the one that took effect, is
unchanged, so every shipped value is identical before and after. No value was changed to match DESIGN.md:
none needed to be.

### 2. No fabricated numbers (`web/src/design/no-fake-numbers.test.ts`, `numeric-display.ts`)

A TypeScript-AST scan (the same tooling as `web/src/i18n/literal-scan.ts`) of every `web/src` `.tsx` file
outside tests and `a11y/testing` reports:

- digits or a percent sign in JSX text or in a string or template rendered as a child;
- a numeric literal rendered as a child, including through `?:`, `&&`, `||` and `??`;
- `?? 0` or `|| 0`, which a query that has not loaded would turn into a displayed zero.

A numeric prop such as `size={18}` is not reported. Each finding must match an `ALLOWLIST` entry with a
reason of at least a sentence. A stale entry, one that no longer matches, fails the test. The test shows a
planted `{counts ? counts.sent : 12}` as a failure (checked, then reverted).

Findings in this change, all allow-listed:

- three step ordinals `01`, `02`, `03` in the Overview's "Get started" list: sequence labels, not counts;
- four fallbacks that render nothing at zero: the failed-delivery nav link, the delete dialog's waiting line
  (shown only above zero), a yes-or-no workspace check, and a form default for the grouping select.

No live figure was found hard-coded. The "Delivered" and "Failed" labels on the Overview say "last 24
hours". That window is the server's `SUMMARY_WINDOW_MS`, which `GET /api/deliveries/summary` returns as
`windowHours`. The test reads the constant from `src/api/deliveries.ts` and asserts that the English and
Vietnamese labels name that window (`24 hours` and `24 giờ`). The labels are a fixed window, so they stay
text and are not fed from the response.

Catalogue sentences in metric namespaces (`overview.`, `nav.`, `health.`, `*.count`) may state a number only
through a `{placeholder}`, except those window labels.

Known limits, stated in the test: the scan cannot see a fallback that is assigned to a variable before it is
rendered, a number built in a helper, or a policy number in another namespace. Those are for review, not for
this test.

### 3. Shared Skeleton and EmptyState (`web/src/components/state.tsx`)

The components already existed (ADR 0025). This change makes them the only loading and empty markup in the
four dashboard lists that had copies: Integrations, Sources, Activity (delivery log) and Audit log. Each now
renders `Skeleton` while loading (a named `role="status"` with `aria-busy`, rows hidden from assistive
technology) and `EmptyState` for an empty list, a filter with no matches (with its clear action), and the
audit log's forbidden state. Heading levels, copy and catalogue keys are unchanged.

Left as they are, on purpose: the inline "Loading…" hint in `GithubGate` and the GitHub panel, and the
`empty-icon` blocks in `GithubGate`, `GithubStep` and the onboarding and invitation cards. Those are a
connect call to action and a page heading, not a list's empty state.

**Real finding, fixed.** `.empty p` set empty-state body copy to 14 px. DESIGN.md §16 and F221 require at
least 16 px for body text, so it is now 16 px. The shared state now reads at the right size on every page.

**Test support.** `ApiState` in `web/src/a11y/testing/render.tsx` gains `pending`, a list of request path
prefixes that never answer, so a test can see a loading state. Nothing else in the mock changes.

### 4. What did not change

- Locale in the URL (F224) and the native-speaker review of Vietnamese copy: not done, and not in this slice.
- F225's status line still says the shared components are not built. That is stale, and it belongs to the
  F225 owner and the coordinator's reconciliation. This change does not touch it.
- `styles.css` still declares `.empty` twice (lines near 600 and 1026); the later `padding: 32px` wins. It is
  a duplicate-rule hazard of the same kind, and it is out of this slice. Not changed here.

## Consequences

- A token edit in `styles.css` or `DESIGN.md` now fails a test until the other side agrees. A new colour
  that DESIGN.md does not state fails too, unless it gets an alias with its reason.
- A literal figure in a component fails the build unless it is allow-listed with a reason. A new real figure
  is expected to come from a query, and a query that has not loaded shows a dash.
- The four lists look a little different: the empty section padding is the shared one, and the loading rows
  are the shared rows. The body copy in empty states is 16 px, up from 14 px.
- The drift test reads `node_modules/@fontsource-variable/geist/index.css`, so it needs dependencies installed.
- No product behaviour changed; no API, migration or stored data changed.

## Verification

Run on 2026-10-15 in this worktree:

- `web/src/design` and `web/src/components`: 70 tests pass (drift 40, no-fake-numbers 13, state 17).
- The whole web suite, run in three chunks: 35 files pass (`web/src/a11y` 229 tests, `integrations`, `components`
  and `design` 295, the rest 246 with one skip). Two jsdom axe tests timed out during a first full run at a load
  average near 35 on four CPUs; they pass when rerun alone.
- Mutation checks, each reverted: changed colour, changed spacing, changed radius, added shadow declaration,
  planted literal in `DeliveryStats.tsx`. Each failed as intended. The original duplicate `:root` layout fails
  only the duplicate-declaration check, which confirms the values were already equal.
- `npm run -s typecheck` and `npm run -s typecheck:web` pass. `npx eslint` and `npx prettier --check` are clean on
  every changed file. `npm run -s docs:check` passes.
- `npm run -s test` (the full repo): 4616 pass, 4 fail. Three of the four are not caused by this change. The
  spec-status test fails because `docs/specs/STATUS.md` has not been regenerated from the F206 and F224 status
  lines, which the coordinator owns. The two `migration-0026-d1` tests fail on a JSON parse of `wrangler d1
  execute` output, and they fail when run alone too. The `migration-0026-matrix` test timed out under load and
  passes when run alone. The migration failures were not checked against a baseline commit.
- Browser: not run. The session has no browser. Layout, the 16 px body size and the four lists were checked in
  source and in jsdom with axe only, so this is not rendered 320 px, Vietnamese or screen-reader evidence.

## Revisit when

- DESIGN.md gains a token outside the sections read here (for example a focus or motion token table). Add it
  to the drift test rather than to a hand list.
- A metric is shown to people that the server does not compute, or the summary window changes. The
  allow-listed labels then change with it.
- The scan misses a real figure that reaches the screen (a fallback held in a variable, a number from a
  helper). Extend the scan, do not widen the allow-list.
- The browser pass for this slice is done, or the native-speaker review of Vietnamese copy changes the state
  copy.
