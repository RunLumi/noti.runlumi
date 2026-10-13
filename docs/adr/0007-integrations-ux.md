# ADR 0007: Integrations dashboard — list, create wizard, settings, GitHub connection

Status: Accepted · Date: 2026-10-13 · Implements slice 6a (F206, F210, F211, F216, F217,
F220, F221, F223, F224, F225 — each in part, as listed below)

## Context

The `/integrations` screen was a catalogue of placeholder cards. PR #9 shipped the
tenant-scoped integrations API and PR #11 the verified GitHub App install flow (ADR 0008).
Integrations can now only name a repository an active installation covers. The dashboard has
to let a nontechnical person connect GitHub, choose a repository, paste a webhook URL safely,
choose updates, and later pause, edit, replace credentials or delete — without claiming
anything the system has not done.

## Decisions

1. **The design system is `DESIGN.md`, applied to an app.** Paper White canvas; every reading
   surface (integration card, settings section, wizard sheet, GitHub panel) is an opaque white
   sheet with the archival border and navy-tinted card shadow; Civic Navy headings; Lumi Blue
   only for the primary action, the selected step, the on-switch and links. Status colours
   appear only with text: amber for advisory (legacy credentials, resync, the URL warning),
   red for a stop (quarantined credentials, delete). Tabler Outline icons at 16–24 px. No
   glass. Labels 16 px, body 16 px, metadata 12–14 px, every control ≥ 44 px.

2. **Repository first in the wizard.** Connecting GitHub is a full-page trip to github.com
   that returns to `/integrations?github=<status>`. Putting the repository step first means
   the trip happens before anything has been typed. With no active installation, step 1 is
   "Connect GitHub" and the Continue button is absent rather than disabled (F206: no dead
   affordance). An unconfigured server shows "GitHub App not configured on this server" and
   no button.

3. **Repository picker over the connection, not a free text box.** A native `<select>`
   grouped by account lists the repositories of `selected` installations; an `all`
   installation offers "Another repository in <account>…", which reveals a name field with the
   owner fixed. The client mirrors `repo-scope.ts` (case-insensitive, active installations
   only); the server stays authoritative and stores GitHub's casing. A saved repository Noti
   can no longer see stays visible in the picker as "(no longer visible to Noti)" instead of
   silently disappearing.

4. **Credentials are write-only.** URL and secret inputs are `type="password"` with a
   Show/Hide toggle, `autocomplete="off"`, no spell-check, password-manager opt-outs, and are
   never trimmed or reformatted on paste. Nothing is pre-filled; the review step says
   "Provided" and the settings page shows only destination, host and state. Replacing them is
   a separate, explicit section (**Replace webhook URL**), which also explains that an empty
   Lark secret turns signing off.

5. **Validation: client mirrors, server decides.** `validation.ts` imports the Worker's own
   `destinationAllowed` and copies the repository, name and secret rules. Unit tests compare
   each case against the real server parser so they cannot drift. Server 422 messages (which
   never echo input) are shown next to their field; the wizard jumps to the step that owns the
   first failing field and focuses it.

6. **Optimistic pause/resume with rollback.** The switch (`role="switch"`, named per
   integration, state also in text) moves immediately. On failure both caches are restored
   from the snapshot and an alert beside the switch says what did not change and why. It uses
   `aria-disabled` while saving so keyboard focus is not lost.

7. **Plain-language errors (F220).** The headline comes from our catalogue by status: network,
   session, missing capability vs blocked request (403), not found, 409 quota, 413, 422,
   429 (with `Retry-After` seconds) and server. The status code appears only as "Reference for
   support: HTTP n". All 15 `?github=` codes have their own sentence; an unknown code is
   treated as `unexpected_error`. The parameter is removed with `history.replaceState`.

8. **Delete is the one typed confirmation (F217)** in a Base UI `AlertDialog`. It states what
   is destroyed and that it cannot be undone, starts focus on **Keep integration**, and closes
   on Escape with focus returned to the trigger. Pause is offered as the alternative.

9. **Strings are translation-ready (F224), not translated.** New screens use message ids in
   `web/src/i18n/messages.en.ts` through `t()` and `tp()` (`Intl.PluralRules`), with no
   sentence built by concatenation. Event labels are a `Record` keyed by the server's closed
   catalog, so adding an event without a label fails the type check. Older screens
   (`pages.tsx`, team, onboarding) still hold literals.

10. **Honest absence.** Overview's integrations figure comes from the list query (`—` while
    loading or failed, with the reason). Delivery figures stay `—`. The planned-connector cards
    are replaced by one non-interactive roadmap sentence. `/activity` is unchanged.

## Deliberately not done

- Presets (F210) beyond a failures-only default, volume estimates, and a read-only
  "exactly which events" view: the presets themselves (F154/F155) do not exist yet.
- Test send, delivery log, setup-progress model, deep-linkable wizard steps (F207, F213–F216):
  they need APIs that do not exist. The wizard holds its draft in memory only, never in the URL
  or browser storage, because it contains a credential.
- Per-destination provider screenshots (F212): none were captured from real provider UIs, so
  the guidance is numbered text plus a link to the provider's official guide.

## Verification (2026-10-13)

**Automated.** `npm run format && npm run check` passes: format, lint (type-aware), Worker and
web type checks, 842 tests (69 new in `web/src/integrations/integrations.test.ts`), web build,
Worker bundle check — on the branch rebased onto `main` after PRs #8 and #10. The browser pass
below ran before that rebase; those PRs changed no `web/` code and no integrations or GitHub
API route.

**Browser, against a real local Worker.** `wrangler dev` with local D1 (all migrations
applied), the real Worker code and the Vite dev proxy; nothing in the app was stubbed. Setup
done outside the UI, and therefore *not* evidence of those paths:

- a local test account was signed up through the API and marked verified directly in D1;
- the GitHub App settings were placeholders (so the server reports `configured: true`) and
  three installation rows (selected, all, suspended) were inserted directly into D1;
- legacy and quarantined credential states were produced by editing rows in D1.

Checked in the in-app browser (Chromium):

- Empty state, list, legacy and quarantined notices, GitHub panel (unconfigured,
  configured, suspended, `needsResync`), `?github=installation_admin_required` and
  `?github=connected` (message shown, parameter stripped).
- Wizard end to end through the real `POST /api/integrations` for a `selected` repository and
  an `all` account's typed repository; client errors (no destination, wrong host) with focus on
  the invalid control; the gate step with no active installation.
- A real server 422: the request body was altered in the browser (`fetch` wrapper) to send an
  invalid repository and name; the Worker's 422 field errors appeared inline on step 1 with
  focus on the first field.
- Pause/resume against the real API with focus retained. The rollback path was exercised
  with a browser-side `fetch` wrapper that failed PATCH requests (simulated network failure):
  the switch returned to On and the alert was announced.
- Settings: replace webhook URL (quarantine cleared by the real API, URL never present in the
  DOM), typed-confirmation delete through the real API, dialog focus on cancel, Escape and
  Enter-on-cancel close without deleting.
- `POST /api/github/install` returned a `github.com/apps/<slug>/installations/new` URL. The
  button's navigation to github.com was **not** followed.
- No horizontal scroll at 320 px on the list, wizard and settings pages, or at 375 px on the
  wizard; no button, link-button, input or select under 44 px tall on the settings page at
  320 px. Vietnamese name ("Nhóm phát triển — thông báo") renders with
  intact diacritics.

Screenshots of local test data: `docs/screenshots/` (desktop list with GitHub panel,
credential states, repository picker; 320 px list and delete dialog). They show our own UI,
not provider screens.

## Not verified

- Any real GitHub App, Slack or Lark endpoint; any delivered message.
- Automated accessibility scan (axe), a screen-reader pass, forced-colours and
  reduced-transparency rendering, 200 % zoom, Firefox and Safari.
- The usability claim that setup takes under five minutes.

This is not evidence of production readiness (AGENTS.md release rule).
