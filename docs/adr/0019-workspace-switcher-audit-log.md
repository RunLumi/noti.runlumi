# ADR 0019: Workspace switcher and audit log

Status: Accepted · Date: 2026-10-14 · Implements slice 6e: F28 (read side, in part) and F222 (read
side, in part); closes the "not built" note in PROGRESS "Fix F". Builds on [ADR 0003](0003-better-auth.md),
[ADR 0007](0007-integrations-ux.md), [ADR 0009](0009-delivery-log-ux.md),
[ADR 0013](0013-accessibility-localization.md) and [ADR 0017](0017-tanstack-start.md).

## Context

Two gaps were left open on purpose. A person can belong to several workspaces (PR #29) and the
session has an active one, but the dashboard had no way to choose it, so a second workspace was
unreachable without a URL parameter. And audit events have been written since slice 3a with
`audit.read` defined, but nothing could read them: an admin could not answer "who turned that off?".

## Decisions

### A. Workspace switcher

1. **`POST /api/workspace/active` `{ organizationId }`** (in `src/auth/workspace.ts`, next to
   `/me`, which shares its session helper). Membership is read from the database for the caller
   and that organization; the body is never trusted. A workspace the caller is not in and one
   that does not exist return the same `404 {"error":"Not found"}`, so the endpoint is no oracle
   for which ids exist (same status and body, tested). Only the caller's own session row changes
   (`WHERE id = <session> AND user_id = <caller>`). CSRF is the central `requireSameOrigin`
   middleware plus a JSON content type (`415` otherwise). Rate limited to 30 a minute per user.
   A successful switch is not audited (it changes no workspace data). A refused one **is**, through the
   same path as a refused `?org=` read (`recordProbe`: an `access.denied` row against the workspace when
   it exists, none that reveals which case it was), and that path is rate limited to 20 recorded rows a
   person a minute, so scanning ids cannot flood another workspace's log or the orphan rows. The
   response is unchanged by the limit.
2. **`GET /api/workspace/me` also returns `activeOrgId`** (the workspace the response describes)
   and lists `organizations` ordered by when the person joined, so the order is stable.
3. **Query keys.** Every workspace-scoped query key is `[area, orgId, ...]`; the two that were not
   are fixed: the team list (`['team']`, which also relied on the session's active workspace) is
   now `['team', orgId]` and asks `?org=` by name. On a switch the dashboard (a) writes the
   server's answer into the `me` cache so pages re-render under the new id, (b) removes every
   cached query that is not `me`, `passkeys` or the new workspace's (`dropOtherWorkspaces`), then
   (c) refetches `me`. The rule is deliberately a deny-by-shape one: a key that names no workspace
   is removed. A unit test of the rule and page-level tests (team and audit) check that no request after the
   switch names the old workspace and that none of its rows are on screen.
4. **Component.** One control in the sidebar, built on Base UI's `Menu` (the library the dialogs
   already use), so the keyboard model is the library's: Enter/Space/Arrow opens, arrows, Home,
   End and type-ahead move, Escape closes and returns focus to the button, selecting closes.
   - Several workspaces: the button names the workspace and the person's role in it, and its
     accessible name says it switches workspace. The menu is a radio group (the current one is
     `aria-checked`) plus a separator and **Create workspace**. Items are at least 44px tall; the
     popup is an opaque surface (no glass, so no transparency fallback is needed) with a visible
     border in forced-colors mode. The list is sorted by name in the reader's language.
   - One workspace: the control collapses to a static label with a link, **Create another
     workspace**. There is nothing to switch, but a second workspace must stay discoverable.
   - None: nothing is rendered; the shell sends the person to onboarding.
   - The change is announced in a polite live region that belongs to the control, because the path
     does not change and nothing else would speak ("Switched to Bao Retail. Your role here:
     Member."). A failed switch shows an alert and refreshes `me`.
   - After a switch, a detail page of the old workspace (`/integrations/<id>`) returns to its list
     and the activity filters are cleared (an integration filter names a row of the old workspace).
5. **Creating another workspace** reuses `/onboarding`. The page no longer redirects a person who
   already has a workspace away; it then shows "Create another workspace" with a way back. After
   Better Auth creates the organization, the page calls `POST /api/workspace/active` for the new
   id (so our own endpoint re-checks the membership instead of relying on the library default),
   drops the old caches and opens the overview.
6. Accepting an invitation as an existing member is handled in A3.

### A2. Stale tabs (security review of this PR, H1)

The active workspace lives on the **session**, which every tab of a browser shares. A tab left on a
form for workspace A would, after another tab switched to B, have written into B if it relied on the
session. Two layers:

- **Server, one place.** `resolveWorkspace` (which `authorize` and every domain route use) refuses a
  `POST`, `PUT`, `PATCH` or `DELETE` from a person with **more than one membership** that does not carry
  `?org=`: `400 {"error":"org is required"}`. One membership is unambiguous, so it needs no parameter.
  `/api/workspace/active` (names its target in the body), `/api/auth/*` and the webhook and browser
  routes do not resolve a workspace this way and are unaffected; reads still fall back to the active
  workspace. `tests/api/org-required.test.ts` is a matrix over every mutating route (refused without
  it, resolved with it, untouched for a single-membership person) and checks that nothing is written.
  `web/src/workspace/org-param.test.ts` scans the dashboard's API modules so a new mutation cannot
  forget `withOrg(...)`.
- **Client.** A form, wizard or dialog binds the workspace it was opened for (`useBoundWorkspace`, the
  create wizard, source create/rotate/delete, workspace deletion, integration credential rotation) and
  sends that id on every request. `WorkspaceDriftBanner` detects an active-workspace change this tab did
  not cause (`me.activeOrgId` changed and `takeOwnSwitch` is empty), then drops the other workspace's
  cache, leaves a detail page that belonged to it, and shows a persistent `role="alert"` "Workspace
  changed in another tab" (English and Vietnamese). Forms bound to the old workspace disable their
  submit (`aria-disabled`, still focusable) and say why. `me` is refetched when a sibling tab announces a
  switch over `BroadcastChannel('noti-workspace')` and when the tab regains focus. Not bound: the
  integration settings details form and delete dialog (their ids belong to the old workspace, so the
  server answers 404; the page is left on the change).

### A3. Joining and creating

- `/invite` no longer refuses a person who already has a workspace. After a successful accept the page
  activates the invited workspace (the id from the answer, else the one new in `me`), drops the old
  caches and opens the overview. A server refusal (such as already a member of that organization) is
  shown as the server words it. `invite.alreadyMember` is removed.
- Onboarding separates the two steps: if creating the organization fails the form stays; once it exists,
  a failure of the follow-up activation is swallowed (it is already active, and a retry would create a
  duplicate), caches are dropped, `me` is refreshed and the person is taken to the overview.

### B. Audit log

7. **`GET /api/audit`** (`src/api/audit.ts`, pure mapping in `src/api/audit-view.ts`), capability
   `audit.read` (admin only; a member gets `403 {"error":"Missing capability: audit.read"}`, audited
   like every denial). Workspace-scoped by the resolved organization, newest first, cursor on
   `(created_at, id)` (the same opaque cursor shape as the delivery log), `limit` 1 to 100 (default
   25), filters `action` (a closed list), `outcome`, `from`, `to` (a date means the whole UTC day);
   anything invalid is `422` with field errors. Reads are limited to 120 a minute per user.
   `Cache-Control: no-store`. The response also carries `retentionDays`, the value in force
   (`AUDIT_RETENTION_DAYS`, `wrangler.jsonc`: 365), so the page states retention from the server and
   never from a constant.
8. **What a row discloses**, decided once in `audit-view.ts`:
   - **Actor: a name, only for a current member of this workspace.** The query joins `member` on
     (user, this organization), so a person who left, and an outsider whose probe was recorded here
     (`access.denied` with `not_a_member`), render without a name: **"Former member"** for a successful action by someone no longer in the workspace
     and **"Outside user"** for a refused request from someone who never was. Their
     name and email belong to nobody in this workspace. **Email is never returned**: admins can
     already see member emails in Team, and an audit log that repeated them would add exposure for
     no gain. `actor_id` is not returned either.
   - **`ip` and `user_agent` are excluded.** They are personal data about members, an admin does
     not need them to understand what happened, and AGENTS.md asks for minimal sensitive data in
     logs and screens. They stay in the table for incident response and are still subject to
     retention. Exposing them later would be a deliberate, documented change (and probably an
     operator-only one).
   - **`metadata_json` is parsed, never dumped.** Each action has an allow-list of keys and types
     (`SUMMARY_FIELDS`, one entry per action, enforced by a test that the two lists match). A wrong
     type, an unknown key, an unknown action (a newer release) or malformed JSON yields no detail
     for that field rather than an error. Strings are cut to 120 characters (by code point, never through
     a surrogate pair), lists to 10 items of 80, and control, line-separator, zero-width, bidi, soft
     hyphen, combining grapheme joiner, Arabic letter mark, Hangul/Mongolian fillers, variation selector,
     interlinear annotation and tag characters are removed. Metadata is built
     from values we control (ids, enum names, hostnames), but the read side does not rely on that.
   - Subject type and id are returned (ids, capability names, repository names), cut to 120.
9. **Page** (`/audit`, `web/src/audit/`): admin only. The nav item is not shown to a member; a
   member who opens the URL sees why, and no request is made. A table (labelled cards below 760px,
   like the delivery log) with filters in the URL, plain-language labels for every action id in
   `src/audit/actions.ts` (English and Vietnamese; `audit.test.tsx` fails if an action, subject
   type or allow-listed detail key has no label in both), empty (none and filtered), loading and
   error states (a failed read is an error, never an empty log), "load older events", and the
   retention sentence including that the log is an application log, not tamper-proof (migration 0008
   says the same). The table is wider than the 761 to ~900px window, so there the wrapper scrolls
   inside itself instead of squeezing a name into one letter per line.
10. **CSV export of the events on screen**, client side, because it is simple and bounded to what
    the person already loaded. It states that ("Download loaded events"). Cells that a spreadsheet
    would run as a formula (a leading `=`, `+`, `-`, `@`, tab or carriage return) are prefixed with
    an apostrophe; commas, quotes and line breaks are quoted; the file starts with a UTF-8 byte-order
    mark so Excel shows Vietnamese correctly. No new server surface; the workspace
    export (Settings) remains the complete, audited export.
11. `AuditAction` and the subject types moved to `src/audit/actions.ts` (a plain module, re-exported
    from `audit.ts`) so the dashboard can import the closed lists without the Worker types.

## Verification (2026-10-14)

- API: `tests/api/workspace-active.test.ts` (switch persisted and visible in `/me`, non-member and
  unknown organization indistinguishable, another user's session untouched, 401, CSRF origin
  refusals, 415/422, rate limit) and `tests/api/audit.test.ts` (member 403 naming the capability,
  cross-tenant isolation including cursors, ordering and cursor paging across equal timestamps,
  filters, limit cap, 422s, rate limit, retention, no email/IP/user agent, outsider and former member
  hidden, metadata allow-list, truncation and bidi stripping).
- Dashboard (jsdom, real route tree, axe): the switcher open and closed, keyboard open/close/select,
  focus return, switch refetches under the new id and never requests or shows the old workspace,
  detail-page exit, single and no workspace, creating another workspace (create then activate),
  Vietnamese; the audit page's states, URL filters, member refusal, isolation across a switch, CSV
  escaping and a byte-order mark; stale-tab simulation, onboarding retry and invitation acceptance by an
  existing member (`web/src/workspace/stale-tab.test.tsx`); axe for `/audit` (data, filtered, empty, error, member) and the multi-workspace shell, in
  English and Vietnamese.
- **Real browser (Chrome pane, `npm run dev` with local D1, one account in two workspaces,
  Vietnamese UI):** the switcher opens by keyboard and mouse, lists both workspaces with roles,
  switching changes the workspace name and the audit rows (different source ids) and closes the
  menu; the audit page rendered at 1280px and 320px with no horizontal page scroll, controls at
  least 44px tall. The real API (not the mock) was exercised with curl: switch, 404 for an unknown
  organization, audit rows with the actor's name and no email or IP.
- **Not verified:** a screen reader (NVDA, VoiceOver, TalkBack) has not been run; Firefox and Safari
  (Base UI's menu in particular); touch; the Vietnamese copy has had no native-speaker review;
  contrast of the new surfaces beyond the shared tokens; mouse clicks on the menu items worked after
  the pane had focus but the first click right after opening sometimes only highlighted the item
  under the automation tool (the keyboard path was reliable); not reproduced by hand.

## Not done

- The F222 read side beyond this slice: filtering by actor or target, a stated total, a correlation
  id, an absolute-and-relative time per row (relative with the exact time on hover is shown), a
  non-secret diff of changed fields (only the allow-listed facts), links to the target, "who" for
  installation-initiated events, member invite/remove/role events and session events (not written
  today, so not shown), and the F222 rule that an audit write failure fails the action.
- The workspace export still includes each event's raw `metadata_json` (an admin-only, existing
  behaviour); it was not moved onto the allow-list in this slice.
- A composite index on `(organization_id, created_at, id)`: the existing `(organization_id,
  created_at)` index serves the filter and order; a workspace with very many events at one second
  would sort the ties. No migration was added.
- Real-provider acceptance is unaffected: nothing here talks to a provider.
