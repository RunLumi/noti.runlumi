# ADR 0047: V1 beta release scope, sign-up control and mail in the auth tier

Status: Accepted · Date: 2026-10-15 · Decides the V1 scope for F41 to F46, F52, F54, F62 (spec 04) and F121 to F140
(spec 10); completes the sign-up kill switch of F242 (spec 15); moves outbound mail into the auth tier of F04 (spec 01)

## Context

The owner asked for the decisions that stand between this repository and a release. Two kinds of item were
left. Some are decisions nobody had taken: which P0 features a first release needs, whether a missing mail
binding should stop the Worker, how a deployment limits who can sign up. The rest are actions only the owner
can take: registering the GitHub App, a staging Cloudflare account, real Slack, Teams and Lark runs, the
migration 0026 rehearsal, legal text. This ADR takes the first kind. It cannot take the second, and it does
not pretend to: section 5 lists them as the release gate.

`AGENTS.md` forbids describing anything as production-ready before a real-provider end-to-end run, the
tenant-isolation drill and a rollback rehearsal have passed. None has. So the release this ADR scopes is a
closed beta, not a public launch.

## Decision

### 1. The first release is an invite-only design-partner beta

Three to five teams, invited by the operator, on GitHub to Slack, Teams or Lark. Not a public sign-up and not
described as production-ready. The point of the beta is real-provider evidence and real feedback, which is
exactly what the release rule says is missing.

Rejected: a public launch now (breaks the release rule; nothing has reached a real provider); waiting until every
P0 in the specs is ✅ (many need a migration or an external account, and some are a general rule engine the
shipped product does not need, so the wait has no end that code alone can reach).

### 2. V1 scope

- Source: GitHub (the App install flow). GitLab, Stripe and the generic signed source exist but stay
  unadvertised until each has real-payload evidence.
- Destinations: Slack, Microsoft Teams and Lark webhooks. Discord and the custom webhook stay off
  (`GENERIC_WEBHOOK_ENABLED=false`; Discord is not offered in setup).
- Routing: the five closed per-integration filters of ADR 0010 and the noise controls of ADR 0016.

### 3. Deferred past V1: the general rule engine and the remainder of the canonical envelope

- Rule engine (REMAINING slice 1.13): F121 rule object, F122 rules table and versions, F123 `all`/`any` groups and
  F132 priority and conflict resolution are 🚫 deferred. They describe a general rule language; V1 routes
  with closed filters (ADR 0010), which is a smaller and safer surface for a nontechnical user. The partly built
  features F124, F125, F127, F131, F136, F137 and F140 keep their shipped half and stay 🟡; their rule-engine
  half is deferred by this ADR.
- Envelope remainder (REMAINING slice 1.12): F52 schema registry and F54 normalisation version are 🚫 deferred.
  F41 to F46 and F62 keep the validated `CanonicalEvent` of ADR 0020 and stay 🟡; the ULID id, the outcome
  enum with `rawOutcome`, published JSON Schemas and `unmapped:<raw>` capture are deferred.

Revisit trigger for both is in "Revisit when".

### 4. Two code changes the beta needs

**Outbound mail is an auth-tier binding.** `AUTH_EMAIL` and `AUTH_FROM_EMAIL` move from warnings into the auth
tier (`src/platform/config.ts`). Email verification is mandatory (`requireEmailVerification`), so without mail
nobody can get a usable account, and `createAuth` already refused to build. Before this change the boot check
said "warning" while every auth route failed inside sign-in; now `/api` and `/github` answer 503 with the
binding named to the operator, and ingress, the queue consumer and cron keep running, like any auth-tier fault.

**A sign-up switch, `SIGNUP_MODE`** (`src/auth/signup-policy.ts`):

| Value | A new account is created when |
| --- | --- |
| `open` | always; also when the variable is unset, so local development and tests are unchanged |
| `invite_only` | the address holds a pending, unexpired invitation, or is on `SIGNUP_ALLOWLIST` |
| `closed` | never: the kill switch the incident playbooks lacked (F242). Existing accounts still sign in |
| anything else | never: an unknown value fails closed, and boot names `SIGNUP_MODE` |

`wrangler.jsonc` sets `invite_only`, so a deployment is invite-only unless an operator deliberately opens it, and
boot names `SIGNUP_MODE` when a `staging` or `production` deploy leaves it unset. `SIGNUP_ALLOWLIST` holds exact
addresses (the first operator has nobody to invite them); it is personal data, so it is a secret, not a var.

The check is Better Auth's `user.create.before` database hook, which every account-creating path passes
through, rather than a guard on one route. Better Auth answers a refused password sign-up with the same 200
as a successful one (its anti-enumeration behaviour while verification is required), so a refusal reveals
nothing about whether an address holds an invitation; no account row is written and no mail is sent
(`tests/auth/signup-policy.test.ts`, through the real handler).

Rejected: `invite_only` as the code default (about 25 test environments and local development would need the
setting; the deployed default comes from `wrangler.jsonc` instead, with the boot warning as the backstop);
domain wildcards in the allowlist (one typo admits a whole domain); a separate sign-up route guard (misses
any other path that creates a user).

### 5. The release gate for the beta: what only the owner can do

In order; each is a precondition of inviting the first team. The code half of each is already in the
repository.

1. Turn on GitHub Actions for the repository and branch protection on `main` (required `verify` and
   `integration` checks, code-owner review). PR #63 merged with **no check run at all**: every CI gate in
   `docs/RELEASE_GATES.md` is advisory until this is done.
2. A staging Cloudflare account: D1, both queues, the secrets, Workers Paid for DLQ retention.
3. Register the GitHub App (`docs/GITHUB_APP.md`) and replace the `REPLACE_WITH_*` values.
4. Rehearse migration 0026 on staging and a throwaway remote D1 (`docs/RUNBOOK.md`). Blocking.
5. One real create, test, deliver, inspect, retry run to Slack, Teams and Lark.
6. Run `scripts/tenant-isolation-drill.mjs` against staging.
7. Verify the email sending domain; set `SIGNUP_ALLOWLIST` to the operator's address.
8. Privacy policy and terms (legal review), before the first invitation.

## Consequences

- The P0 count no longer includes a rule language nobody needs for the beta; what remains P0 is either built
  in part with a named gap or blocked on the actions in section 5.
- A deployment without mail now fails loudly at `/api` instead of half-working. A developer without the
  `send_email` binding locally sees a 503 on `/api` rather than an error inside sign-up.
- A refused stranger is told to check their email and nothing arrives. The sign-up page does not yet say
  "by invitation only". Acceptable for a closed beta whose users arrive through an invitation link; a
  public sign-up needs the page to read `SIGNUP_MODE` first.
- The beta is still at-least-once with possible duplicates (ADR 0035), and every alert threshold is
  unmeasured. Design partners should be told both.

## Not done

- The sign-up page message for `invite_only` and `closed`.
- Every item in section 5.

## Revisit when

- A design partner asks for routing the closed filters cannot express (for the rule engine), or a second
  source needs a shared schema to be consumed by a third party (for F52 and F54).
- The beta has three teams on real providers for two weeks with no cross-tenant leak and no untraced
  lost delivery: then plan the public launch, which needs `SIGNUP_MODE=open`, the sign-up page message and the
  section 5 items all done.
