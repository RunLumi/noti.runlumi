# ADR 0002: Apply the shared Lumi design language to Noti

## Decision

Use repository `DESIGN.md` as the visual authority and original SVGs from `brand/`
for the app identity and favicon. Vite bundles and fingerprints the imported assets.
Self-host Geist through `@fontsource-variable/geist` (Latin and Vietnamese included),
and use Tabler Outline functional icons with their standard geometry. Third-party
license notices are retained in `brand/THIRD_PARTY_LICENSES.txt`.

Noti adapts the landing-oriented document's material and accessibility rules to an
application: warm paper canvas, opaque white work sheets, navy headings, blue actions,
8px controls, 12px sheets, readable body text, visible focus and responsive navigation.
No glass is needed for the current app. The landing's company narrative and email CTA
do not override Noti's workflows or feature availability.

## Acceptance criteria

- Original Lumi logo and favicon load from a production build.
- Geist loads locally; no font CDN requests are required.
- Authentication, onboarding, team, settings and preview screens retain their behavior.
- Desktop and 320px mobile layouts reflow; keyboard focus remains visible.
- No invented metrics, completed setup status or working-connector claims are introduced.
- Formatting, lint, Worker/web type checks, unit tests, auth schema checks and web build pass.

## Consequences

The font and icon packages are explicit dependencies in the committed lockfile.
Existing connector limitations remain visible; this visual update is not evidence of
real-provider acceptance or production readiness.

## Verification evidence and remaining limits

Local formatting, lint, Worker/web type checks, the provider unit tests,
production web build and SQLite auth schema checks passed on 2026-10-13.
The production build emits the supplied SVG favicon and self-hosted Vietnamese
and Latin Geist subsets. `.gitignore` checks confirm local environments, Wrangler
state, web builds and browser artifacts are excluded while examples and source
assets remain eligible for version control.

Browser visual/keyboard review could not run: the session exposes no browser,
and the Playwright package launcher is blocked by the environment's install policy.
Responsive and preference styles were inspected in source; that is not rendered
320px, Vietnamese typography or WCAG acceptance evidence. Real-provider delivery,
Worker/D1/Queues integration and rollback rehearsal remain outside this UI change
and unverified. This merge does not constitute a production release.
