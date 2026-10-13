# ADR 0013: Accessibility gate, keyboard and focus management, Vietnamese localization

Status: Accepted · Date: 2026-10-13 · Implements slice 6c: F221 (in part), F223 (in part),
F224 (in part). Builds on ADR 0002 (design system), 0007 (integrations UX) and 0009 (delivery
log UX).

## Context

Slices 6a and 6b built the dashboard screens with good local habits (labelled fields, linked
errors, a focus-first-invalid helper, a destructive-dialog rule, a message catalogue), but
nothing enforced them. There was no automated accessibility check, no skip-link behaviour or
route announcement, no test that the stylesheet carried the fallbacks `DESIGN.md` §16
requires, and the catalogue held English only. The shell, sign-in, overview, team,
onboarding and passkey screens still carried literal English in their components.

## Decisions

1. **axe-core runs in the unit tests and fails the build on serious or critical violations.**
   `web/src/a11y/pages.a11y.test.tsx` mounts the real route tree (a memory-history router,
   the real components, a mock `fetch`) at every route and in the states a person reaches
   without acting: loaded, empty and error lists, admin and member views, signed-out and
   signed-in invitations. `dialogs.a11y.test.tsx` scans what needs an action: every wizard
   step, a wizard validation error, the delete-integration, delete-workspace and
   delivery-detail dialogs, the redelivery confirmation, a settings validation error and a
   failed sign-in. Each runs in English and Vietnamese where it is language-sensitive. A
   test proves axe is live (it must report `image-alt`, `button-name` and `label` on a
   deliberately broken page), and a route test fails if `main.tsx` gains a route that the
   harness does not list.

   Dependencies, exact-pinned and all older than two weeks on the registry (`axe-core` 4.13.0,
   `jsdom` 29.1.1, `@testing-library/react` 16.3.3, `@testing-library/dom` 10.4.2,
   `@testing-library/user-event` 14.6.7). `axe-core` is used directly rather than through
   `vitest-axe`, which is only a thin matcher over it. jsdom is selected per file with
   `// @vitest-environment jsdom`; the existing Node tests are untouched. Dev dependencies
   only: nothing is added to the shipped bundle.

2. **What jsdom cannot check, stated rather than hidden.** `color-contrast` and `target-size`
   are switched off in the jsdom runs (no layout, no cascade for external styles);
   scrollable-region, reflow, text-spacing and zoom rules also cannot run. They are covered
   differently:

   - **Palette contrast** is a pure test (`contrast.test.ts`). The tokens are read from
     `styles.css`, compared to the canonical block in `DESIGN.md` §5 (they must be identical),
     and 34 text and non-text pairs (23 text, 11 non-text) are computed with the WCAG formula. The arithmetic is
     itself tested against known anchors (`#767676` on white is 4.54:1).
   - **Rendered contrast and reflow** were run in a real browser with axe-core injected into
     the running app (see Verification).

3. **Findings from the contrast test and what was done.** All 23 text pairs and 9 of the 11
   non-text pairs pass with the canonical colours (Soft Slate on Paper White 5.07:1, on white
   5.76:1; Lumi Blue on white and white on Lumi Blue 6.78:1; Risk Red on Red Soft 4.69:1;
   Success Green on Green Soft 4.81:1). Four findings:

   | Pair | Ratio | Needs | Decision |
   | --- | --- | --- | --- |
   | `--glass-bg-opaque` was `var(--color-soft-slate)` | Ink text on it 2.82:1 | 4.5 | **Fixed.** `DESIGN.md` §8.4 specifies the opaque fallback as `#f9f7f2`. A later rule masked it in the default case, but reduced-transparency and high-contrast modes would have drawn the sidebar mid-grey. |
   | Text-field edge, `--color-border` `#d9dee8` on white | 1.35:1 | 3 (1.4.11) | **Fixed without changing a token.** A new `--color-control-border` aliases `--color-soft-slate`, a canonical Lumi value, used for `.input` and `.role-select` only. 5.76:1 on white, 5.07:1 on Paper White. `DESIGN.md` does not prescribe form-field border colour (§8.2 speaks of document structure), but this is an interpretation a design owner should confirm. |
   | Switch track edge, `--color-border-strong` on white | 1.55:1 | 3 | **Accepted deviation.** No canonical colour is both quiet and 3:1. The switch always carries its state as the words On / Paused and by thumb position, so the edge is not the only cue (1.4.1). Pinned in the test at exactly 1.55. |
   | Warning severity rail, `--color-signal-amber` on white | 2.03:1 | 3 | **Accepted deviation.** The 3px rail reinforces an icon and text in every use; amber is never used as text colour. Pinned at exactly 2.03. |

   The accepted entries are pinned to their ratio: the test fails if one stops failing (remove
   it) or changes (re-decide).

4. **Route changes: title, announcement, focus (WCAG 2.4.2, 2.4.3, 4.1.3).**
   `web/src/a11y/RouteA11y.tsx` is mounted once in `AppShell`. When the path changes
   (not the query string) it sets `document.title` to "`<page>` · Lumi Noti", fills a
   visually-hidden `role="status"` region ("`<page>` page opened") and moves focus to the
   page `<h1>` (`tabindex="-1"`, outside the Tab order), after a frame so the new route has
   committed its heading. First load is left to the browser; filtering the activity log
   (query string only) never steals focus from the filter in use. The page names come from
   the catalogue, so Vietnamese titles and announcements need no extra code.

5. **Skip link and landmarks (2.4.1).** `SkipLink` is the first stop on the shell and on the
   auth screens; it focuses `<main id="main-content">` itself, without writing `#main-content`
   into the URL or the router history. The auth screens gained a real `<main>` (the form
   side) and the brand panel became a labelled `<aside>`. Axe's `region` finding there is
   gone.

6. **Dialogs.** The three confirmations (Base UI `AlertDialog`) and the delivery drawer
   (`Dialog`) already focused the safe control and restored focus; the tests now hold that
   as a contract: focus lands on Cancel, Tab cannot leave, Escape closes, focus returns to
   the trigger. Nothing in the components had to change.

7. **Reduced motion, reduced transparency, forced colours, increased contrast
   (`DESIGN.md` §16, §8.4).** The fallbacks mostly existed. `stylesheet.test.ts` parses every
   stylesheet and asserts them: glass only on the sidebar and the modal scrim; blur only inside
   `@supports`; an opaque colour before the translucent one; `backdrop-filter: none` under
   `prefers-reduced-transparency` and `prefers-contrast: more`; a universal
   `prefers-reduced-motion` rule with `!important`; animations only under `no-preference`;
   system-colour borders, selection and focus under `forced-colors`; a ≥2px focus ring; 44px
   control heights; no text under 12px; body at 16px. One gap was fixed: the modal scrim's
   `backdrop-filter: blur(2px)` was unconditional and had no reduced-transparency or
   high-contrast fallback. It now sits in `@supports` and is switched off in both modes.
   These tests prove the rules are present and wired to the right selectors; they do not
   prove how a browser paints them (see "Not verified").

8. **Localization: Vietnamese beside English, with a switcher.** `web/src/i18n/`:

   - `messages.vi.ts` (the integrations, delivery and workspace screens) and
     `messages.app.vi.ts` (shell, sign-in, overview, team, onboarding, passkeys,
     accessibility chrome). The English side is `messages.en.ts` (unchanged) plus the new
     `messages.app.en.ts`; they are merged in `i18n/index.ts`, and `en`, `MessageId`, `t()` and
     `tp()` keep their public shape. The Vietnamese objects are typed
     `satisfies Record<keyof typeof en, …>`, so a missing id is also a compile error.
   - Register: formal-friendly, addressing the reader as "bạn", short active sentences, what
     happened then what to do (`DESIGN.md` §14: not word-for-word). Product and provider
     names (Noti, GitHub, Lark, Slack, Microsoft Teams) and terms people look for in their own
     tools (webhook, URL, repository, pull request, workflow, commit, passkey) stay English.
     The Chinese menu labels in the Lark steps are verbatim from Lark's screen and are kept
     (F212). The translation was written for this change and has **not** been reviewed by a
     native-speaking editor; it should be before launch.
   - `locale.ts`: `vi` or `en`; the person's saved choice (`localStorage`, every read and write
     in `try/catch`) beats `navigator.languages`, which beats English. In the Node unit tests
     there is no DOM and the locale stays English regardless of the machine's `LANG`.
     `<html lang>` follows. `LocaleSwitcher` is a native `<select>` (sidebar and sign-in
     screens), each option carrying its own `lang` and its endonym.
   - Plurals use `Intl.PluralRules` for the active locale (Vietnamese has one category);
     numbers, dates and relative times go through `Intl` with the active locale
     (`i18n/format.ts`; `deliveries/Time.tsx` now uses it; the hard-coded `'en'` and
     `toLocaleDateString()` are gone). A missing Vietnamese id at runtime falls back to the
     English text rather than a blank.
   - **Switching language remounts the subtree.** `t()` is a plain function, so
     `LocaleProvider` keys the routed tree by locale. The router, URL, query cache and session
     live above it and survive; an unfinished form loses its typed values. F224 asks for
     unsaved values to be preserved; that is not met (see "Not done").

9. **Tests that stop the catalogue drifting.** `catalogue.test.ts` fails if any English id is
   missing from Vietnamese, if Vietnamese has an unknown id, if any message is empty, if a
   `{placeholder}` set differs from English (including each plural variant), if braces are
   unbalanced, if a Vietnamese plural carries a category the language lacks, if a sentence is
   an untranslated copy, if a brand term was dropped, if the Lark labels were translated, and
   if text is not NFC. The checking function is itself tested against deliberately broken
   catalogues. `hardcoded-strings.test.ts` parses every `.tsx` under `web/src` (TypeScript
   API, not a regex) and fails on JSX text, string literals rendered in JSX and visible
   attribute strings (`aria-label`, `placeholder`, `title`, `alt`, …), plus
   `confirm`/`alert`/`prompt` with a literal. Its allow-list is **empty**: every existing
   literal in `pages.tsx`, `team.tsx`, `onboarding.tsx`, `passkeys.tsx` and `ui.tsx` was moved
   into the catalogue, and the strings `lib/api.ts` returns for the sign-up, resend and
   forgot-password screens too. The scan is a heuristic: it cannot see strings assembled in
   helper functions, and server-supplied text (Better Auth error messages) is not caught.

10. **Vietnamese typography.** Geist's Vietnamese subset is bundled and loaded `swap`;
    `stylesheet.test.ts` reads the package CSS and asserts the `vietnamese` face is there with
    `U+1EA0-1EF9` and `font-display: swap`, that no face points at a CDN, and that every
    non-Latin-1 character in the Vietnamese catalogue (CJK Lark labels excepted, which come
    from the Noto fallbacks in `--font-sans`) is covered by one of the bundled faces. `locale.css`
    applies the per-script display rules from `DESIGN.md` §6.2 only under `:lang(vi)`: display
    line-height 1.14 (1.13 under 700px), lighter tracking, and no change to body size.

11. **Layout defects found by looking at it** (the point of the browser pass). At 1024px, and
    equally at 200% zoom on a larger screen, the wizard's review step squeezed values to a few
    characters per line ("Slac / k") because a fixed 180px label column sat in a ~350px sheet,
    and the destination cards were two columns of ~100px text. Fixed in `a11y/a11y.css`
    (review rows stack below 1100px; option cards use `auto-fit`) and covered by two
    stylesheet assertions. The fix lives in the new file to avoid colliding with parallel work
    in `integrations/**`.

## Verification (2026-10-13)

**Automated.** `npm run format && npm run check` passes: format, lint, type checks, the Worker
and web tests, web build, Worker bundle guard. 1,336 tests, 183 of them new: catalogue 18,
hard-coded strings 6, locale 14, contrast 39, stylesheet 29, pages (axe) 50, dialogs (axe) 12,
keyboard 15. Mutation checks were run on the stylesheet tests (smooth scrolling, a 1px focus ring, a
renamed `@supports` selector each turned the suite red).

**Browser, against a real local Worker.** `wrangler dev` with local D1 (all migrations), the
real Worker, the Vite dev proxy; nothing in the app was stubbed. Setup done outside the UI and
so not evidence of those paths: the account was signed up through the API and marked verified
in D1, the workspace was created through the Better Auth API (see "Found"), and one GitHub
installation with three repositories was inserted into D1. A throwaway copy of axe-core was
served from `web/public` for the run and removed.

- **axe-core in the page, with `color-contrast` on:** zero violations on `/signin`, `/`,
  `/integrations`, `/integrations/new` (steps 1, 4 and 5), the integration settings page,
  `/activity`, `/team`, `/settings` and `/signup`, in English and in Vietnamese, and with the
  delete dialog open. A deliberately low-contrast paragraph was flagged by the same run, and
  39 contrast checks passed on the wizard page, so the rule was live.
- **Keyboard only** through sign-in and the create wizard: skip link first (visible, ringed),
  logo, five navigation links, language selector, the page's first control; the step heading
  takes focus after every Continue; a failed first step puts an inline error beside the
  repository field and returns focus to it; Tab past the last control wraps instead of
  trapping. The delete dialog: focus on Cancel, Tab stays inside (after the dialog's focus
  guard has run), Escape closes, focus returns to the trigger.
- **320 px** (Vietnamese): no horizontal scroll on `/`, `/integrations`, the wizard,
  `/activity`, `/team`, `/settings` or `/signin`; no button, link-button, input, select or
  switch under 44px tall.
- **200% zoom, emulated** as a 640×400 CSS-pixel viewport (the tool cannot change page zoom):
  the wizard reflows without horizontal scroll and long Vietnamese text wraps.
- **Vietnamese rendering**: tone marks render from the bundled Geist Vietnamese subset
  (screenshots below), including stacked marks in the display heading "Bớt nhiễu. Rõ tín hiệu."
  at line-height 1.14 without clipping.

Screenshots (our own UI, local test data): `docs/screenshots/a11y-vi-signup-desktop.png`,
`a11y-vi-integration-settings-desktop.png`, `a11y-vi-activity-desktop.png`,
`a11y-vi-wizard-320.png`, `a11y-vi-wizard-200pct-zoom.png`.

**Found, not fixed here.** `GET /api/workspace/me` returns 403 for a signed-in user with no
workspace, and the dashboard treats any `/me` error as signed-out, so a brand-new user is sent
back to `/signin` and can never reach `/onboarding`. It is a Worker change (`src/**`), outside
this slice, and has been filed as a separate task.

## Not verified

- **No screen reader was run.** Not VoiceOver, NVDA, JAWS or TalkBack. Everything about
  announcements (route changes, live regions, labels, dialog names) rests on axe, the DOM
  tests and reading the accessibility tree, not on hearing it.
- **`prefers-reduced-motion`, `prefers-reduced-transparency`, `prefers-contrast` and
  `forced-colors` were not exercised in a browser.** The browser tool exposes only a colour
  scheme switch. The stylesheet tests prove the fallbacks exist and target the right
  selectors; nobody has seen the result in Windows High Contrast or with the OS setting on.
- **Native `<select>` popups** (repository, outcome and integration lists, the language
  switcher) cannot be driven by the tool's synthetic keys, so the options were set
  programmatically in the browser pass. Keyboard operation of a native select is the
  browser's, not ours, but it was not exercised.
- **Real zoom, real devices, Safari and Firefox.** One Chromium build only, with an emulated
  viewport. No touch testing.
- **Delivery detail, redelivery and the member-role views in a browser:** no delivery rows
  were seeded for this pass, so those dialogs were checked only in jsdom.
- **Contrast of glass over moving content** (F221) is moot while the sidebar is opaque (a
  later rule in `styles.css` removes the blur); revisit if glass returns.
- **Focus Not Obscured (2.4.11).** There is no sticky or fixed bar today (the wizard has none).
  `scroll-margin-block` is in place as a guard; a test that a focused control is not hidden
  behind a sticky bar cannot exist until the bar does.
- The Vietnamese text has not had a native-speaker edit. Provider-side labels in
  `destination.*.step*` follow the providers' English UI and the Chinese Lark menu as
  documented; they were not re-checked against the live provider screens in this slice.

## Not done

- Locale in the URL (`?locale=`), and preserving unsaved form values across a language switch.
- Localised server-supplied text: Better Auth's own error messages (for example a failed
  sign-in) and any `error` string the Worker returns outside the integrations/delivery
  taxonomy still arrive in English.
- `lang` on inline provider text, and a locale-aware screenshot pipeline (F212).
- A manual release checklist run (keyboard + screen reader + zoom) and any conformance claim.
  Nothing in the product or docs says "WCAG compliant", and that stays true.
- The live-delivery-tail stop control (F213) does not exist yet because there is no live tail.
