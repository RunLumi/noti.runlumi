# ADR 0025: Server-driven setup flow, shell and navigation, state gates

Status: Accepted · Date: 2026-10-14 · Implements slice 6f: F205, F207, F216 (in part), F208, F209, F211, F212,
F217, F218 (reachability), F220, F225, F221 and F223 (in part). Builds on ADR 0007, 0009, 0013, 0017, 0018, 0019.
Supersedes ADR 0018 for the shape of `GET /api/setup/progress`.

## Context

A first-time user had four derived steps on the Overview and a wizard that lived in component state. A refresh
mid-wizard lost the place, a shared link could not point at a step, "GitHub is not configured" was a notice at the
bottom of a form, the shell guarded pages with an exact-match array and redirected unknown paths, sign-in lost the
page the person came from, settings had no repair or health sections, and errors were one sentence with a status.

## Decisions

1. **The seven-step model is derived on the server (v2).** `workspace_created`, `github_connected`,
   `repositories_selected`, `destination_connected`, `events_chosen`, `test_delivered`, `activated`, each
   `todo | doing | done | blocked | skipped`, with `nextAction`, `blockedBy` and a `resume` point. Nothing new is
   stored: the evidence is installations, sources, the newest integration and the delivery ledger. Consequences,
   chosen on purpose:
   - An integration is created in one request, so `repositories_selected` and `destination_connected` flip together.
     Before that, the chosen repository exists only in the page's memory. That is honest: nothing is claimed saved.
   - `events_chosen` is `skipped` while the integration still has the quiet default and `done` once the events,
     filters or noise settings differ. "Skipped" therefore means "untouched, defaults apply", never "the user
     declined". The server default list is a constant kept equal to the wizard's by a test.
   - `test_delivered` is `done` with `verification: accepted` for Teams-style destinations: a message was accepted,
     and the UI says it was not confirmed shown. (ADR 0018 kept this as a non-done status; the spec's four-state
     vocabulary has no place for it, and the qualifier carries the same honesty.)
   - `activated` is the first real (non-test) event. It does not keep `complete` false; the Overview shrinks to one
     line until it arrives.
   - "GitHub App not configured" is a real `blocked` state read from `githubAppConfig(env)`, with `blockedBy`
     `github_app_not_configured`. The UI says it is a server setting and who can change it.
   - Not built: the spec's `setup_progress` table and a recorded `skip_test` choice, and a second state machine for
     additional integrations. They would store what the ledger already proves.
2. **`/setup/:step` is a route space.** Pages: github, repository, destination, events, test, done. `/setup` resumes
   where the server says. Deep links work on a cold load; a step reached before its prerequisite shows the
   prerequisite instead of a form that cannot work. The step list is an ordered list with `aria-current="step"` and
   every state in words. The draft (repository, destination, webhook address) lives in memory in the route
   component, never in the URL or storage, and leaving `/setup` with a non-empty draft asks first. `?org=` and the
   workspace-bound pattern (ADR 0019) are used for every write. The pages reuse the wizard's components and the
   normal `POST /api/integrations`; the Create wizard stays for power use and "add another destination".
3. **GitHub return.** GitHub redirects to `/integrations?github=…` (server-side, unchanged). A trip started in setup
   sets a `sessionStorage` hint; Integrations then forwards to `/setup/github` with the status. If storage is
   blocked, the page it lands on links back. The hint is never state.
4. **Shell.** `route-guard.ts` is a list of rows (`public | authenticated | admin`, `exact | prefix`). A test fails if
   a file route has no row or a navigation item has no route. An address with no row renders the 404 page inside the
   shell for a signed-in person and bare otherwise; it never redirects. Sign-in carries `returnTo`, and
   `safeReturnTo` accepts only a path that starts with a single `/`, has no backslash or control character, parses to
   the page's own origin, is not an auth page and is at most 2,048 characters; the result is rebuilt from the parsed
   parts. Admin-only Audit stays hidden from members (the page explains itself if opened directly); a disabled
   entry was rejected because it adds a seventh item for people who can do nothing with it. Breadcrumbs exist where
   there are nested routes (integration settings, new integration, setup steps). A delivery's detail is a dialog and
   a source's detail is a card, so neither has a breadcrumb.
5. **Destination abilities.** Static client facts (`abilities.ts`), compared to `capabilities.ts` by a test:
   card or JSON, link back, plain fallback, confirmation versus accepted, signed, no @mentions, Lark's redaction.
   Limits are listed as limits with the word "Limitation", not omitted.
6. **Settings order and repair.** Status (with the repair panel), source and updates, filters, destination, test,
   quiet hours, credentials, health, history, delete. `repairsFor` is pure and tested: quarantined credentials, a
   latest delivery rejected by the destination, an open breaker, unreadable filters or noise. An old failure that a
   later success cleared is history, not a repair. Health reads the first page of the integration's deliveries and
   says how many it looked at. The Failed view (with bulk redeliver) is linked from the integration page and from a
   navigation link under Activity whenever the server counts failed deliveries.
7. **Shared states.** `Skeleton`, `EmptyState`, `ErrorPanel` (what happened, why, what to do, how to get help). The
   kind of failure picks the copy; server text and exception messages never appear. There is no support address in
   the product, so "how to get help" is the workspace admin plus the HTTP reference; one message changes when a
   contact exists. `error-copy.test.ts` bans filler ("Something went wrong", "Oops", "Error 500", raw exception
   words) in English and Vietnamese and requires copy for every taxonomy `messageKey`. Four existing messages that
   broke the rule were rewritten.
8. **Accessibility process (ADR 0013).** Every new route and state has an axe scenario in English and Vietnamese
   (setup resume, GitHub blocked and connected, repository, destination prerequisite and saved, events, test, done,
   unfinished, progress error, 404). A static 320px reflow test covers the new stylesheets (jsdom has no layout);
   the real 320px check was done by hand.

## Verification

Automated: see the PR (server table and API tests, parser, abilities-versus-capabilities, route guard, `returnTo`,
breadcrumbs, repair and health, banned phrases, reflow, axe). Browser: recorded in the PR description with what was and
was not driven.

## Not done

Real-provider GitHub connect, Slack OAuth, Teams auth capture, verified screenshots (F212), new-repository diff and
private-repository warning (F209), pause and delete consequence counts, disconnect-source, a Destinations health
page, a screen-reader pass, a browser and device matrix, 320px in CI, the usability test (F226), a support address.
