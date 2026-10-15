# 15 — Security & Compliance

> External references read **2026-10-13** unless a different date is stated inline. Anything
> that could not be verified is marked **⚠️ UNVERIFIED** together with what to check.
> This file does not restate identity and tenancy decisions (`02`), the error taxonomy (F13),
> redaction (F12), cryptography (`03`) or delivery reliability (`12`). It **points at them** and
> records what must be true before anything is called secure.
>
> **No formal security audit has been performed** — `docs/SECURITY.md` says so and so does this
> file. Nothing below is an audit result.

## The one-paragraph version

We are a relay. Untrusted payloads arrive at a public route, are stored, and are then written to
a URL a **customer** chose. That makes three things true at once: the ingress is an internet-facing
authentication surface (we must verify, not trust), the egress is an SSRF engine aimed wherever a
tenant points it, and the data in between is one tenant's private engineering information. The
single largest gap between this repository and a shippable multi-tenant product is not any
individual control below — it is that **no tenant-owned table has an organization column yet**
(D2), so every other control is defending a boundary that the schema cannot express. That is why
F233 is the release gate and not a peer.

---

## F227 — Threat model

**Priority** P0 · **Status** 🟡 `docs/THREAT_MODEL.md` has assets, adversaries, trust boundaries, STRIDE per entry point and a not-defended list; not built: the CI check that every control ID referenced exists in `docs/specs/`; `docs/SECURITY.md` was not replaced by the model (it links to it); own analysis, not an audit

**Story** As a security reviewer, I want one written model of who attacks what and which control
is supposed to stop them, so that new features are checked against a threat instead of against
good intentions.

**Acceptance**
- [ ] `docs/SECURITY.md` is replaced by this feature's tables (the current file is one paragraph,
      one sentence of controls, and "No formal security audit has been performed").
- [ ] Five columns per row: **asset** · **adversary** · **entry point** · **control** (with the
      owning feature ID) · **residual risk**.
- [ ] Adversaries are enumerated, not hand-waved: anonymous internet attacker; authenticated
      low-privilege member of a real workspace; a legitimate tenant who is hostile (this is the
      SSRF actor); a compromised destination provider or provider account; a compromised Cloudflare
      account or our own operator; a compromised dependency or CI job.
- [ ] Trust boundaries are drawn explicitly: edge → Worker; public webhook route → D1; tenant A →
      tenant B; our database → third-party destination; our database → external email recipients.
- [ ] A "what we do not defend against" section, so a later reviewer does not assume coverage:
      compromise of the Cloudflare account, a malicious upstream package with an install script,
      edge-level volumetric DDoS (Cloudflare's job), and an endpoint that returns `2xx` to
      everything.
- [ ] Every row names the feature that owns the control. A row with no owning feature is a gap
      and is listed as such.
- [ ] The model is reviewed whenever a source, destination or trust boundary is added — the same
      trigger as ADR 0003 (`01`, F14).

**Design** — `docs/SECURITY.md` today lists threats in one sentence and controls in another, with
no adversary-to-control mapping. That is not a threat model; it is a checklist. The value of
writing it out is that it makes **gaps legible**: "a legitimate tenant who is hostile → egress
allowlist → F228" is a row, and the row is where the reviewer asks "what about redirects?".

I am deliberately not using STRIDE by name. The taxonomy is a means; the asset list is what
forces the conversation about what actually matters here, which is credentials and event payloads,
not session-fixation.

**Errors** — n/a; a document.

**Security** — the model itself is internal. It contains no exploit detail beyond what our own
adversary classes imply, and it is not published to customers.

**Tests** — a CI check that every control ID referenced in `docs/SECURITY.md` exists in
`docs/specs/`, so the model cannot rot into referencing features nobody wrote.

**Deps** — F14.

---

## F228 — Egress policy is ours, not the platform's

**Priority** P0 · **Status** 🟡 one send path `sendRequest` in `src/connectors/destinations/send.ts` re-checks the URL policy, uses `redirect: 'manual'` with 3xx classified `destination_redirected`, timeout and bounded body (`tests/destinations/conformance.test.ts`, `tests/pipeline/destinations.test.ts`, ADR 0006, AR-2 in `docs/THREAT_MODEL.md`); an AST regression guard (not a proof: aliasing is not followed) that only `send.ts` and two listed control-plane files make outbound-capable calls, with their call sites pinned (`tests/security/egress.test.ts`, ADR 0026); the credential-host binding test (`credential_is_never_sent_to_a_host_other_than_its_own`: `tests/security/credential-host-binding.test.ts` over every destination path, and the GitHub install-flow invariant in `tests/github/install-flow.test.ts`; ADR 0040; no path was found that sends a credential to a host other than its own); not built: proof that no other path exists · **Fixes** part of D9

**Story** As a security engineer, I want every outbound request to pass through one policy
function in our code, so that we never assume Cloudflare is filtering egress when it is not.

**Acceptance**
- [ ] **Stated in code and in docs, in these words:** the Workers runtime's `fetch()` documentation
      specifies no destination restriction. The runtime page documents only Worker-to-Worker
      behaviour, which requires a service binding or the `global_fetch_strictly_public`
      compatibility flag
      ([workers/runtime-apis/fetch](https://developers.cloudflare.com/workers/runtime-apis/fetch/),
      read 2026-10-13). There is no allowlist, blocklist or private-range filter in the ordinary
      request path.
- [ ] Cloudflare **does** offer egress policy enforcement, and it is not ours to rely on silently:
      "Workers using a VPC Network binding with `network_id: "cf1:network"` now egress to public
      Internet destinations through Cloudflare Gateway", applying existing DNS, HTTP and Network
      policies
      ([changelog 2026-06-05](https://developers.cloudflare.com/changelog/post/2026-06-05-gateway-egress/),
      read 2026-10-13). It requires an active Cloudflare Tunnel, Mesh node or WAN on-ramp in the
      account. We record it as a **possible future platform control**, evaluated as a Zero Trust
      decision, not as a V1 dependency.
- [ ] Exactly one module may construct an outbound HTTP request to a customer-configured URL:
      `sendToDestination(url, body, credentials)`. A static test fails if `fetch(` appears
      anywhere else in `src/` outside a small, explicitly listed set (provider API calls for our
      own control-plane operations, each individually commented).
- [ ] No destination call ever follows a redirect. F189 generalises this. *Amended 2026-10-13
      ([ADR 0006](../adr/0006-destination-adapter-contract.md)):* the control is `redirect: 'manual'`, with any 3xx classified as a permanent
      `destination_redirected`. It was previously `redirect: 'error'`, which also never follows
      but is indistinguishable from a network error and would be retried.
- [ ] The policy decision (F229 allowlist) and the send are the **same function's decision**, not
      two checks in two places. There is no time-of-check/time-of-use window in which a URL passes
      validation and then gets sent somewhere else.
- [ ] A credential is attached only when the host that passed the allowlist is the host the
      credential belongs to. There is no code path that sends an `Authorization: Bearer` value to
      a host it was not issued for.

**Design** — This feature exists because "the platform handles SSRF" is the kind of assumption that
is true in some products and false in this one, and nobody notices until an incident. In Cloudflare
Workers it is false for plain `fetch()`. Concretely: a Worker is deployed on Cloudflare's network
with no private network of ours to reach, which removes the classic "read the cloud metadata
service" outcome — but it does **not** remove the ability for a tenant to use us as an HTTPS POST
relay to *any* public host, including another tenant's own endpoint or a third-party API that
treats unauthenticated POSTs as a write.

That residue is real and is handled, not waved at: the allowlist (F229) limits destinations to
provider domains, request bodies are bounded (F95), timeouts are mandatory (F189), and the
outbound rate is shaped per provider account (F187) so abuse is visible and attributable.

**Errors**

| Condition | Behaviour |
| --- | --- |
| Destination host not on the allowlist | `destination_url_rejected`, permanent, no retry (F13) |
| Non-`https` scheme, userinfo, fragment, IP-literal host | same code, same message; the message never echoes the URL |
| Redirect returned | treated as a failure; **never** followed |
| Platform-side block (e.g. Cloudflare error pages) | `destination_unavailable`, transient, classified by status |

**Security** — the allowlist is a control we implement, test and own. Anything that reduces our
dependence on it (Gateway egress, future platform filtering) is a risk reduction to be evaluated,
never a reason to weaken the application-layer check.

**Tests**
- `only_one_module_constructs_destination_requests` (static)
- `no_outbound_call_follows_a_redirect`
- `credential_is_never_sent_to_a_host_other_than_its_own`
- `ssrf_policy_does_not_depend_on_any_platform_feature`

**Deps** — F96 (`07`), F189 (`12`), F229.

---

## F229 — Allowed provider domains, and how that list is maintained

**Priority** P0 · **Status** 🟡 per-kind exact-host and path-prefix rules with doc-URL comments and lookalike-host tests (`src/connectors/destinations/url-policy.ts`, `tests/destinations/url-policy.test.ts`); typed registry with `docsUrl`, `verifiedOn`, a weekly 180-day staleness check (`npm run check:stale`, not in the PR check) and a written reason for the Teams wildcard (`src/connectors/destinations/provider-registry.ts`, `tests/destinations/provider-registry.test.ts`, ADR 0026); not built: reconnect prompt when a host is removed (F98), a CI-visible dated `verifiedOn` review that a human, not this change, performs against the live docs · **Fixes** part of D9

**Story** As an operator, I want one reviewable list of the exact hosts we will send to, so that
adding a destination is a reviewed change with a cited source rather than a regex edit.

**Acceptance**
- [ ] The list is a typed module, one entry per provider, with the citation attached:

```ts
export interface AllowedDestination {
  readonly provider: 'lark' | 'slack' | 'teams' | 'discord' | 'telegram';
  readonly hosts: readonly string[];      // exact, lowercase, no wildcard by default
  readonly pathPrefixes: readonly string[];
  readonly docsUrl: string;               // the provider's own API/webhook documentation
  readonly verifiedOn: string;            // ISO date a human read docsUrl
  readonly wildcardSubdomains?: readonly string[]; // only with a written reason
}
```

- [ ] **Every entry carries a `docsUrl` and a `verifiedOn` date.** A CI test fails the build when
      `verifiedOn` is more than **180 days** old. The house rule from F14 — "any spec that cites
      an external limit or API records the URL and the date it was read" — becomes executable
      instead of aspirational.
- [ ] Matching is case-insensitive, trailing-dot-insensitive, punycode-normalised, and exact. A
      suffix match like `endsWith('slack.com')` is forbidden because `evilslack.com` passes it. A
      wildcard subdomain requires the written reason field.
- [ ] Path prefixes are required (the existing Slack and Lark checks already do this —
      `src/index.ts:65` — and they are the strongest part of the current code; keep them).
- [ ] **Adding a host is a normal PR.** **Removing a host is a breaking change**: it requires a
      migration note, a customer-facing notice, and F98 to surface affected destinations as
      actionable rather than failing at send time.
- [ ] When a provider moves a webhook host, we do **not** silently widen the list. The affected
      destinations fail with `destination_url_rejected` and a message telling the user to reconnect.
      Quietly allowing a new host is how an allowlist becomes a wildcard.
- [ ] Initial content is verified against provider documentation on the day it is added — the
      Lark entry covers both regional hosts (`open.larksuite.com`, `open.feishu.cn`) as the current
      code does, and that dual-host behaviour is itself a cited claim, not a convenience.

**Design** — OWASP's position is unambiguous and is why this is a registry rather than a
validation function: *"Deny-lists are bypass-prone. Prefer allow-lists."*
([OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html),
read 2026-10-13). The registry adds the two things a bare allowlist usually lacks: **provenance**
(each host is traceable to a URL someone read) and **expiry** (an entry nobody has re-checked in
six months is treated as unverified).

The staleness test is deliberately cheap and deliberately annoying. It will fire, and firing is the
point: provider documentation moves, and a host list maintained by memory is a host list that
quietly rots.

**Errors**

| Condition | Behaviour |
| --- | --- |
| Host not in the registry | `destination_url_rejected`, permanent, no retry |
| Entry past its 180-day `verifiedOn` | **build failure**, not a runtime behaviour |
| Host removed from the registry while destinations use it | destinations surface as needing reconnection (F98); deliveries dead-letter with `destination_url_rejected` |

**Security** — the registry is the SSRF boundary for every destination. Reviewing it is a
security review, so the PR template asks for the doc URL and forbids "added because a customer
asked".

**Tests**
- `every_allowlist_entry_has_a_docs_url_and_a_verified_on_date`
- `no_allowlist_entry_is_older_than_180_days`
- `suffix_matching_cannot_be_bypassed_by_lookalike_hosts`
- `wildcard_subdomain_requires_a_written_reason`
- `removing_a_host_marks_affected_destinations_for_reconnection`

**Deps** — F96 (`07`), F228, F14.

---

## F230 — Send-time egress enforcement and what we cannot enforce

**Priority** P0 · **Status** ✅ URL policy re-run before every send with no network call on rejection (`src/connectors/destinations/send.ts`); IP literals, userinfo, port, fragment, path and length rejected (`tests/destinations/url-policy.test.ts`, `tests/pipeline/extended-destinations.test.ts`); DNS rebinding accepted as AR-3; bounded body; an unmapped provider reply emits a `unmapped_provider_response` log event with kind and status class (ADR 0026; log-derived, not aggregated or persisted) · **Fixes** D9 (send-time half)

**Story** As a security engineer, I want the URL checked again at the moment we send, and an
honest list of the attacks that a URL string check cannot stop.

**Acceptance**
- [ ] Write-time validation (F96) **and** send-time validation. A row can be altered by a
      migration, an admin tool, a restore or a bug; the second check is not redundant.
- [ ] Rejected without a network call: `http:`/any non-`https` scheme; userinfo (`user:pass@`);
      fragment; IP-literal hosts (`https://203.0.113.5/`, `[::1]`, decimal/octal/hex forms — parse
      with `new URL()` once and reject anything whose `hostname` is not a name); non-443 port;
      host not on the registry (F229); path outside the prefix; length over cap.
- [ ] **Parser disagreement is a rejection.** Parse once with the platform parser; any input whose
      host is read differently by two parsers is refused rather than reconciled. OWASP's worked
      example is the string `http://example.com\@evil.com`, which a WHATWG-conforming parser reads
      as host `example.com` while CPython's `urlsplit` reads `evil.com` (same source, read
      2026-10-13). One implementation cannot be tricked by a discrepancy it never reconciles.
- [ ] **DNS rebinding is stated as not preventable here.** OWASP: *"Domain allowlisting alone does
      not prevent DNS rebinding. Validate the resolved destination IP addresses against the
      application's permitted networks, then ensure the HTTP client connects only to validated
      addresses."* The Workers `fetch()` API exposes no custom address resolution — we cannot pin
      a connection to a pre-validated IP while preserving SNI and certificate verification. We
      record this as an accepted risk (F241, AR-3) and compensate by: exact-host allowlisting,
      refusal of all IP-literal destinations, no redirect following, bounded body and timeout, and
      per-account outbound rate shaping (F187) so a rebound target sees a small, attributable,
      rate-limited volume rather than an open relay.
- [ ] Response bodies are size-capped before parsing; a large error page from a provider cannot
      consume the isolate (F189).
- [ ] Provider response parsing is strict: an unrecognised success shape is a failure with a
      metric, never a silent success (F99).
- [ ] Classification of every rejection is `destination_url_rejected` and non-retryable (F13), so a
      policy rejection can never be mistaken for a provider outage (the exact confusion D9
      describes today).

**Design** — The honest framing matters more than the check. We are an application-layer allowlist
without the network-layer control OWASP recommends for Case 1 (*"Network segregation … is highly
recommended in order to block illegitimate calls directly at network level"*), because a Worker has
no firewall to configure. Standard Webhooks makes the same point from the other direction: it
recommends proxying webhook requests through a filter such as smokescreen **and** putting the
sender in a private subnet that cannot reach internal services
([spec §Server side request forgery](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md),
read 2026-10-13). Neither of those is available to us; the application-layer allowlist plus the
compensating controls above is the correct response, and saying so is better than implying a
guarantee we do not have.

**Errors**

| Condition | Behaviour |
| --- | --- |
| Any rejection rule above | `destination_url_rejected`, permanent, dead-letter, user message "This destination is not permitted." |
| Response exceeds the read cap | `payload_too_large`, permanent |
| Unrecognised provider success shape | `internal_error` + `unmapped_response_shape` metric |
| Timeout / 5xx | `destination_unavailable` or `destination_timeout`, transient (F178/F189) |

**Security** — rejection responses never include the URL (F96). The user submitted it, but the
message may be logged or read by another workspace member, and a dead-letter view renders it
(F181).

**Tests**
- `send_time_revalidation_runs_before_any_network_call`
- `ip_literal_destinations_are_always_rejected`
- `parser_disagreement_is_rejected_not_reconciled`
- `decimal_and_octal_ipv4_forms_are_rejected`
- `oversized_provider_response_is_capped_before_parsing`
- `policy_rejection_is_never_classified_as_a_provider_outage`

**Deps** — F96, F99, F189, F229.

---

## F231 — Rate limiting, quotas and abuse

**Priority** P0 · **Status** 🟡 D1 fixed-window limiter (`src/security/rate-limit.ts`) wired into GitHub ingress, generic and provider sources and the dashboard APIs with 429 plus Retry-After (`tests/security/rate-limit.test.ts`, `tests/pipeline/delivery-path.test.ts`); Better Auth limits use database storage; not built: outbound provider token bucket (F187), per-workspace quota ledger, abuse alerting, Workers binding pre-filter

**Story** As an operator, I want floods, abuse and runaway tenants bounded by policy rather than
by quota exhaustion, so that one customer's mistake cannot take the platform down.

**Acceptance**
- [ ] Four distinct limit families, each with its own key, because they answer different questions:

| Family | Key | Enforced by | Spec |
| --- | --- | --- | --- |
| Auth endpoints | endpoint + IP | Better Auth, database storage | `02` F22 |
| Webhook ingress | `(organization_id, connection_id)` | D1-backed counter | `02` F29 |
| Outbound to providers | provider **account/app**, not connection | token bucket in D1 | `12` F187 |
| Per-workspace product quota | `organization_id` | separate ledger table | this feature |

- [ ] ⚠️ Quota accounting is **never** the abuse rate-limit table. `02` F29 already states this and
      it is repeated here because mixing them makes a billing number wrong or a flood unbounded.
- [ ] The Workers Rate Limiting binding is used only as a **coarse pre-filter**, never as the
      enforcement mechanism, because Cloudflare states it is "permissive, eventually consistent, and
      intentionally designed to not be used as an accurate accounting system", and that limits are
      local to the Cloudflare location handling the request
      ([rate-limit](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/),
      read 2026-10-13).
- [ ] Its `key` is **not** an IP address. Cloudflare's own guidance: "It is not recommended to use
      IP addresses or locations, since these can be shared by many users in many valid cases"
      (same source). `cf-connecting-ip` is used for the auth limits in `02` F22 — that is a
      deliberate, documented exception for a credential-guessing defence, and it is labelled as one
      rather than presented as a general limit.
- [ ] Limits return `429` with `Retry-After` and a machine-readable reason (F50), never a bare
      refusal.
- [ ] Abuse detection, distinct from rate limiting, on: sustained `destination_url_rejected`
      (allowlist probing), sustained `unauthorized_tenant` or `signature_invalid` (credential
      probing), outbound volume far above a connection's own history, and any workspace attempting
      to exceed its destination or event quota. Each raises an alert with the `organization_id`.
- [ ] Alerts carry the `correlation_id` (F11) and are actionable — workspace, connection, the
      count, and the window.
- [ ] **Abuse by a legitimate customer is in scope**: using us to spam a third party, using a
      destination to attack a third party, or using delivery volume as a covert exfiltration
      channel. The controls are the outbound shaping (F187), the payload content restrictions
      (`07` F94/F95) and the audit trail (F236).

**Design** — Abuse control and quota accounting are separated on purpose: an abuse limit must be
enforceable during an incident when accuracy is least trustworthy, and a quota must be exact
enough to bill on. One table serving both produces a number that is wrong in one direction or the
other depending on which failure occurred.

**Errors**

| Condition | Behaviour |
| --- | --- |
| Ingress flood | `429` + `Retry-After`, per connection |
| Outbound shaping exhausted | `destination_rate_limited`, transient, delayed not dropped (F178) |
| Workspace over quota | `403` with the quota named; integration is paused, not deleted |
| Abuse threshold crossed | alert; no automatic tenant suspension in V1 (surface, let a human decide — the same principle as F183's "never auto-disable") |

**Security** — a limit that only exists per Cloudflare location can be exceeded by an attacker
spreading requests across locations. Every limit that matters for abuse is therefore backed by D1,
which is single-threaded and therefore at least globally consistent (F06).

**Tests**
- `ingress_limit_is_enforced_per_connection_across_locations`
- `abuse_limits_are_not_used_as_quota_counters`
- `coarse_binding_key_is_not_an_ip_address`
- `rate_limited_responses_carry_retry_after`
- `allowlist_probing_raises_an_abuse_alert`
- `never_auto_suspends_a_workspace`

**Deps** — F29 (`02`), F187 (`12`), F190 (`12`).

---

## F232 — Authentication and authorization: what is decided elsewhere

**Priority** P0 · **Status** ✅ `docs/AUTHORIZATION.md` (pointer table, the four rules, generated roles-by-capability and route-by-guard tables); route registry `src/auth/route-policy.ts`; `tests/security/route-capability.test.ts` compares the routes the app registers and the handler sources with it, and `tests/security/authorization-doc.test.ts` fails on drift; role table `tests/auth/permissions.test.ts`. The evidence column is honest about controls that are only partly built (session revocation, F20)

**Story** As a security reviewer, I want one page that says where the authentication and
authorization decisions live and what evidence each one needs, so that I review the right file
instead of re-deriving the policy.

**Acceptance**
- [ ] This feature is a **pointer table, not a restatement**. Every row names the owning spec.

| Question | Owner | Release evidence |
| --- | --- | --- |
| Who is the user, how are sessions stored | `02` F16, F20 | Better Auth schema migrated; session expiry configured |
| Roles and capabilities | `02` F24 | table-driven test over (role × capability) for **every** defined capability |
| Which organization does a request act on | `02` F15, F26 | membership resolved server-side; non-member ⇒ `404` |
| Session lifetime and revocation | `02` F18, F20, F23 | revoke-others works; password reset revokes (verified in `02`) |
| CSRF / origin policy | `02` F23 | our own `/api/workspace/*` routes also checked — not just Better Auth's |
| Webhook ingress authentication | `05` F58, F59, F64 | signature over raw bytes; no body-field routing (D3) |
| Domain data isolation | `02` F25, F26 | **the release gate — F233** |

- [ ] The four things nobody may assume, restated once: (1) the organization plugin is a
      membership registry, **not** a data-isolation boundary; (2) authorization comes from the
      verified credential, never from the payload; (3) cross-tenant access is `404`, not `403`;
      (4) client-side button hiding is never a control.
- [ ] Every mutating route is listed with the capability it checks, so an unmapped route is visible.
- [ ] `docs/SECURITY.md` links here instead of re-describing auth.

**Design** — Auth is specified in `02`, and duplicating it here would create two places to update
and eventually one place that is wrong. The value this file adds is the **evidence column**: for
each decision, what artefact proves it, because a decision with no evidence is a claim.

**Errors** — n/a; a document.

**Security** — a mutating route with no entry in this table is a finding, not a documentation
debt.

**Tests** — a static check that every mutating route in `src/` maps to a listed capability. This is
the highest-value cheap check in the whole file.

**Deps** — `02` F24, F26.

---

## F233 — Tenant isolation is the release gate

**Priority** P0 · **Status** 🟡 tenant comes only from the verified installation, tenant columns NOT NULL with foreign keys (`migrations/0026_tenant_contract.sql`), static every-query-filters-by-org test (`tests/security/tenant-query-scope.test.ts`), cross-workspace drill over every route on a fake D1 (`tests/drill/tenant-isolation.test.ts`, 113 tests), cross-workspace 404 tests (`tests/tenant-resolution.test.ts`, `tests/api/integrations.test.ts`, `tests/api/deliveries.test.ts`, PRs #6 #9 #11). ADR 0028 (1.23): a signed GitHub event for an unknown or suspended installation is audited as `github.webhook.refused`, once an hour per installation and at most 30 a minute platform-wide (`tests/github/ingress-codes.test.ts`), and the decision that NOT every probe is recorded is explicit: past 20 a minute per person the first suppressed probe writes one `probe_audit_capped` marker and a log line (`tests/api/org-required.test.ts`). Not built: the staging drill (runner `scripts/tenant-isolation-drill.mjs` exists and has never been run), Time Travel re-drill · **Fixes** D2, D3 · **Contributes to** N6

**Story** As a customer, I want my events and my credentials to be unreachable from another
customer's account, so that I can trust the product with private repository activity.

**Acceptance**
- [ ] Every tenant-owned table has a non-null `organization_id` with a foreign key to
      `organization(id)` — `integrations`, `deliveries`, the outbox, and every new table (`02` F25).
- [ ] The authorization decision is derived from the **verified credential / installation**, never
      from a request body. The specific inversion to delete is
      `src/index.ts:32`: `SELECT ... FROM integrations WHERE repo=? AND enabled=1`, where `repo` is
      `event.repository.full_name` — attacker- or sender-supplied content (D3).
- [ ] There is no GitHub App installation registry, so there is **no** correct way to resolve which
      organization an inbound event belongs to (N6). Until that exists the ingress route cannot be
      made safe by application code alone.
- [ ] Every repository function takes an organization id. There is no unscoped `getIntegration(id)`.
- [ ] Evidence, all of it required before public signup is enabled:
  1. Static check: every tenant query filters on `organization_id`.
  2. Staging drill: organization A attempts to read, update and delete organization B's
     integration, destination, delivery, dead letter and audit rows by guessing identifiers —
     every attempt returns `404` and every attempt is audited.
  3. Cross-tenant access denials are emitted **by the authorization layer**, not by individual
     routes (`02` F28 calls these "the highest-value row and the easiest to forget").
  4. A restore-from-Time-Travel drill (D1 keeps up to 30 days) re-run after the drill, because a
     restore can reintroduce a pre-isolation row.
- [ ] `docs/RELEASE_GATES.md` keeps "replace shared GitHub secret and repository-name-only routing
      with authorized per-source credential/installation checks before public multitenancy" as a
      blocking gate.
- [ ] **No public signup until this is green.** `00` §2 already says this for D2; this feature
      makes it a release criterion with named evidence.

**Design** — Every other control in this file assumes a tenant boundary exists. Encryption (F36)
binds a ciphertext to a row, not to a tenant; rate limits are keyed by tenant; audit rows are
tenant-scoped. If the boundary is absent, those controls are well-built decoration over a table
that anyone can read.

This is placed as F233 rather than filed under "identity" deliberately: it is a **release
decision**, and it belongs next to the release checklist (F240) so that nobody ships a security
feature list without reading the item that blocks all of them.

**Errors**

| Condition | Behaviour |
| --- | --- |
| Request naming an organization the caller is not a member of | `404` — `403` confirms existence and is an enumeration channel |
| Inbound event whose installation is unknown | `403` + audit, never "route to all" |
| Any cross-tenant read attempt | `404` to the caller, audit row retained |

**Security** — a tenant boundary implemented only in application code, with no schema support, is
one forgotten `WHERE` clause away from a breach. The schema column is the control that survives
fatigue.

**Tests**
- `every_tenant_table_has_organization_id` (static)
- `every_tenant_query_filters_by_organization_id` (static)
- `cross_organization_read_returns_404_not_403`
- `body_supplied_identifiers_are_never_authorization`
- `cross_tenant_denials_are_audited_by_the_authorization_layer`
- `time_travel_restore_does_not_reintroduce_unscoped_rows`

**Deps** — `02` F25, F26, F28; `05` F56, F57.

---

## F234 — Accepted risk: Better Auth stores session tokens in a cleartext column

**Priority** P0 · **Status** 🟡 accepted as AR-1 in `docs/THREAT_MODEL.md`; in place: 30-day idle expiry with daily refresh, a 90-day absolute lifetime, password-reset revocation, a session list with revoke-one and revoke-others that never returns a token, Better Auth's token-returning session routes closed, `scripts/revoke-all-sessions.mjs` after a restore, the installed-version check of token storage and a no-token-in-response test (ADR 0030; `tests/api/sessions.test.ts`, `tests/security/revoke-all-sessions.test.ts`), `cookieCache` off asserted in `tests/security/config-guards.test.ts`, retired `auth_tokens` guard (`tests/retired-schema.test.ts`); no-token-in-any-log test for sign-in, sessions, password reset, the restore script and webhook refusal (`tests/security/no-token-in-logs.test.ts`, `tests/security/webhook-logs.test.ts`, ADR 0040; no leak found); not built: the restore script run against a real D1 (UNVERIFIED), a `documented_risk_matches...` test beyond the two token-storage tests · **Relates to** D7, N1

**Story** As a security reviewer, I want the session-token storage risk written down plainly with
its mitigations, so that nobody later discovers it, or claims we fixed it.

**Acceptance**
- [ ] The fact, stated without hedging: Better Auth's session table stores `token`, documented as
      *"The session token. Which is also used as the session cookie."*
      ([session-management](https://www.better-auth.com/docs/concepts/session-management), read
      2026-10-13), and our migration defines it as `"token" TEXT NOT NULL UNIQUE`
      (`migrations/0005_better_auth.sql:17`). A read of that column yields a usable bearer
      credential.
- [ ] **ACCEPTED RISK, not a defect we own.** Mitigations, all implemented or scheduled:
  1. No endpoint returns a session token other than the caller's own (sign-in and `get-session` still return it to the
     person it belongs to): the column is never selected into another person's response, a log, an
     export (F30/F238) or a support tool. `token`, `session` and `cookie` are on the F12 denylist.
  2. Blast radius is bounded by time: `expiresIn` 30 days with `updateAge` 24 h
     (`src/auth/better-auth.ts:76`), and `revokeSessionsOnPasswordReset: true` (`02` F18).
  3. Blast radius is bounded by blast: a D1 read means a database compromise, not an internet
     one. D1 has no public endpoint; access is via Worker bindings and Cloudflare account
     credentials, whose custody is a Cloudflare-side concern.
  4. **`session.cookieCache` is not enabled** in our configuration, which matters: the Better Auth
     docs warn that with cookie caching "revoked sessions may remain active on other devices until
     the cookie cache expires". Without it, revocation is immediate. A test asserts it stays off.
  5. Session listing and revoke-others exist as a user action (Settings, ADR 0030), so a suspected
     compromise is a one-click remedy, not a support ticket. Better Auth's own `list-sessions` and
     `revoke-*` routes, which return tokens, are closed at the Worker.
  6. Any Time Travel restore or backup restore is treated as a **session-bearing event**: all
     sessions are revoked afterwards, because a restored row can resurrect a token the user
     believes they revoked (`scripts/revoke-all-sessions.mjs`, `docs/RUNBOOK.md` "After a restore").
  7. A 90-day absolute lifetime, so a stolen session in daily use still ends.
- [ ] **What we explicitly do not claim**: that session tokens are hashed, that a database
      compromise is contained, or that the risk is theoretical. `02` F20 already warns against
      claiming anything about Better Auth's internal token storage beyond its docs.
- [x] ⚠️ **Verified** against the installed version (`better-auth@1.7.7`, ADR 0030): the `session.token` column holds the
      token as is, and the cookie value is that token followed by a signature (`tests/api/sessions.test.ts`; the test fails
      if Better Auth starts hashing). The raw token, or the token with a missing or wrong signature, authenticates no one;
      so a read of the column alone does not yield a usable cookie. Anyone holding the column AND
      `BETTER_AUTH_SECRET` can forge one, so nothing here claims D1 is safe to leak.
- [ ] **We do not fork or patch Better Auth to hash tokens.** The trade is recorded in `02` F32:
      hand-rolled session and password code is exactly what we should not own. Re-deciding this
      requires an ADR.
- [ ] Related residue: the dead `auth_tokens` table from `migrations/0004` has **no hash column at
      all** (N1, D7). It stays in the chain because it has already been applied (F31), is labelled
      superseded, and is additionally barred from any read path — including the DSAR export path
      (F238), where dumping plaintext tokens into a customer's archive would be a self-inflicted
      incident.

**Design** — The honest position is that this is a *dependency risk we chose*, and the work is to
bound it and say so out loud rather than to pretend a fix exists. Hand-rolling session storage
would move a well-reviewed problem into code we own, which is a worse trade for a product this
size. The compensations above are cheap and real: time-bounded tokens, immediate revocation, no
read path, and no cache layer that would defeat revocation.

**Errors** — n/a (risk statement).

**Security** — the residual, stated for the register (AR-1): a full D1 read together with
`BETTER_AUTH_SECRET` compromises every unexpired session for every user (the cookie is signed, so the column alone is not
enough; tested). Detection depends on Cloudflare access logs, not on us.

**Tests**
- `session_token_never_appears_in_any_api_response_or_log` (the responses: `tests/api/sessions.test.ts`; logs: not built)
- `cookie_cache_remains_disabled_so_revocation_is_immediate`
- `dsar_export_excludes_dead_auth_tokens_table`
- `documented_risk_matches_the_installed_better_auth_behaviour` (`tests/api/sessions.test.ts`, "where the session token lives")

**Deps** — `02` F18, F20, F23, F31, F32; F12.

---

## F235 — Cloudflare Email Sending: platform constraints we did not choose

**Priority** P1 · **Status** 🟡 the limits and the current failure behaviour are recorded in `docs/EMAIL_LIMITS.md` (limits not re-read since 2026-10-13); no email-failure handling is built; auth mail goes through a `send_email` binding with a server-controlled sender (`src/auth/email.ts`) with no suppression list, quota handling or send-failure tests; DKIM and SPF requirements remain unverified

**Story** As a product owner, I want the email channel's hard limits written down with their
consequences, so that a design decision is not silently re-litigated at 3,000 emails a month.

**Acceptance** — verified constraints, all read
2026-10-13 from [email-service/platform/limits](https://developers.cloudflare.com/email-service/platform/limits/):

| Constraint | Value | Consequence for us |
| --- | --- | --- |
| Recipients before a sending domain is onboarded | **verified destination addresses only** | new signups cannot be emailed until a sending domain exists |
| Verified destination addresses per account | **200**, shared across all domains | a workspace with more than ~200 distinct people cannot onboard on verification alone |
| Sending domains | **"You can only send from your routing domains."** | the From domain is ours (`runlumi.app` or similar); we cannot send as a customer's domain |
| Outbound sending | **Workers Paid only**; 3,000/month included, then $0.35/1,000 ([pricing](https://developers.cloudflare.com/email-service/platform/pricing/)) | verification + reset + invites are a design constraint, not a detail |
| Verified-destination sends | free, do not count toward quota | encourages verifying early addresses |
| Recipients per message | 50 combined | invitation fan-out must chunk |
| Message size | 5 MiB (**25 MiB** to verified destinations only) | no attachment feature planned |
| Suppression list | 1 active entry per address and scope; 1,000/page; 10 bulk imports/min; note ≤1,000 chars | bouncing addresses must be suppressed promptly or we burn reputation |
| Domains per zone | 30 | fine for us; stated so nobody is surprised |
| `send_email` binding observability | appears as **"dropped"** in Email Routing summaries even when delivered | never build suppression or deliverability logic on Email Routing data |

- [ ] Anti-spam obligations are ours, and the docs name them: **CAN-SPAM (US), GDPR (EU), CASL
      (Canada)**, requiring "proper unsubscribe mechanisms" and honoring opt-out requests
      promptly (same page). Verification, reset and invitation mail is transactional, but anything
      recurring needs an unsubscribe and a suppression path.
- [ ] Email is on the F12 log denylist by default (tenant PII is opt-in to logs, `01` F12).
- [ ] Email is **not** an event destination in V1. If it ever is, it inherits F228's egress policy
      and the provider-domain policy does not apply — an email "destination" is a recipient address,
      which is user-supplied content sent to a third party, not an allowlisted provider.
- [ ] ⚠️ **UNVERIFIED**: DKIM/SPF record requirements for a sending domain. The page
      `email-service/configuration/sending-domains/` returned 404 on 2026-10-13. Check the current
      Email Service configuration section and record the record names and the date **before**
      writing setup documentation; do not assert them from memory.
- [ ] `02` F17's use of these figures is confirmed accurate against both pages read 2026-10-13;
      any future change to either page invalidates this table, and the 180-day staleness discipline
      in F229 is applied to it as well.

**Design** — Email is a supporting channel (verification, reset, invites, security notices), not a
notification channel, precisely because of these limits. 3,000 emails a month is roughly 100
signups a month if we send three messages each, at which point verification mail stops being a
detail and becomes the growth constraint. Saying that now is cheaper than discovering it later.

**Errors**

| Condition | Behaviour |
| --- | --- |
| Sending to an unverified address with no sending domain | send rejected upstream; treated as a failed send, not a silent success |
| Quota exhausted | the action fails with a clear message; never queued into a retry loop that will never succeed |
| Hard bounce / complaint | add to the suppression list (F237 retention applies to it too) |

**Security** — an email address is personal data. It is stored, redacted from logs by default, and
included in a DSAR export (F238) on request.

**Tests**
- `email_send_failures_are_not_silently_successful`
- `suppressed_addresses_are_never_re_sent_to`
- `quota_exhaustion_produces_an_actionable_error_not_a_retry_loop`
- `email_addresses_are_redacted_from_logs_by_default`

**Deps** — `02` F17; F12; F237.

---

## F236 — Audit events: completeness, immutability, access

**Priority** P1 · **Status** 🟡 audit rows are written with the change in one batch, typed primitives-only size-capped metadata, admin-only `audit.read` reads, tenant-scoped (`src/audit/audit.ts`, `src/api/audit.ts`, `tests/api/audit.test.ts`); not built: static no-UPDATE-or-DELETE test (retention purge deletes by age), audit of audit reads, completeness heartbeat, fail-closed destructive actions, F12 redaction of metadata · **Complements** `02` F28

**Story** As a support engineer, I want to answer "who did what, when" from records I did not
write, so that a customer dispute does not end in a guess.

**Acceptance**
- [ ] The event list is `02` F28's. This feature adds the properties that make it evidence:
      **append-only**, **who may read**, **how long it is kept**, and **how we know it was not
      edited**.
- [ ] No `UPDATE` or `DELETE` against `audit_events` anywhere in `src/` or `scripts/`; a static
      test enforces it. D1 has no per-table grants, so convention plus a test is the enforcement
      mechanism available, and that is said rather than glossed.
- [ ] Reads require the `audit.read` capability, admin-only (`02` F24), and every read of the audit
      log is itself audited. An audit log anyone can read is not an audit log.
- [ ] A completeness counter and a heartbeat exist, so a job that silently stops writing is
      detectable. The same principle as F190's staleness alerts, applied to evidence.
- [ ] Actor identity is the id; actor email is stored redacted (F12) and never authoritative.
- [ ] `metadata_json` is redacted and size-capped before storage, never on the way out.
- [ ] Cross-tenant access denials are emitted by the authorization layer itself (F233), which is
      the only place that cannot forget to record them.
- [ ] Audit records are tenant-scoped on every query, and cross-tenant access to an audit trail is
      exactly as forbidden as cross-tenant access to data (F26).

**Design** — The audit log is the artifact that turns F233's staging drill, F231's abuse alerts and
F240's release evidence into something checkable after the fact. Its weakness is not collection —
it is silent partial collection, which is why the heartbeat and the static no-mutation test are the
load-bearing parts.

**Errors**

| Condition | Behaviour |
| --- | --- |
| Audit write fails during a sensitive action | the action fails closed for destructive operations (revocation, member removal, workspace deletion); non-destructive operations record the failure and alert |
| Counter gap detected | alert `audit_gap` with the window |

**Security** — audit metadata is attacker-influenced (error strings, provider responses), so it
passes through F12 before storage.

**Tests**
- `audit_events_are_append_only_in_code`
- `audit_reads_require_the_audit_read_capability`
- `audit_read_is_itself_audited`
- `audit_heartbeat_gap_raises_an_alert`
- `audit_metadata_is_redacted_before_storage`

**Deps** — `02` F24, F28; F12; F233.

---

## F237 — Retention matrix and its enforcement

**Priority** P0 · **Status** 🟡 slice 1.22 (ADR 0044): the matrix (`src/compliance/retention.ts`) has a row for every table and every removal mechanism is checked against the code (`tests/compliance/retention.test.ts`); `docs/DATA_RETENTION.md` is generated and checked; each fixed period names a constant the purge code uses; every deleting cron job is in the cadence table that the `job_stale` alert reads (F190, F192; the alert reports a count, the names are in the summary); the expired-invitation purge is built (30 days after expiry, `tests/pipeline/expired-records.test.ts`); the session, verification and outbox rows match the code; the raw payload, normalized envelope and `semantic_dedup` rows are recorded as not stored (`NOT_STORED`). **Ledger:** 90 days by default (ADR 0011), not the workspace lifetime; the table row below is amended to say so (ADR 0044). Not built: per-workspace downward retention (it needs a column, which slice 1.22 may not add without a migration; the purge statements are tenant-agnostic and would need a per-workspace cutoff), the job name inside the `job_stale` alert, a purge for accounts whose email is never verified (documented gap), drops of the retired `auth_*` tables and `legacy_orphaned_rows` (documented gaps). Legal review of the wording is out of scope (group 3). UNVERIFIED on real D1: `meta.changes` for DELETE. · **Fixes** D15 (the magic-number half)

**Story** As a customer, I want to know how long you keep each kind of my data and to be able to
ask for it to be kept for less, so that retention is a setting rather than a surprise.

**Acceptance**
- [ ] One table, one source of truth, referenced by the privacy policy and by `docs/SECURITY.md`:

| Store | What it holds | Retention | Enforced by | Notes |
| --- | --- | --- | --- | --- |
| Raw provider payload | private repo/issue content | configurable per workspace; **default 7 days** | F51 + purge job | the highest-sensitivity store |
| Normalized envelope | the event as delivered | same as the payload | F51 | |
| Delivery ledger + attempts | what we sent, when, with which code | **90 days by default**, configurable 30 to 365 (`DELIVERY_RETENTION_DAYS`, ADR 0011); amended from "as long as the workspace exists" (ADR 0044) | F184 | customer-visible; required to answer "did you send this?" |
| `event_dedup` | transport ids and hashes | **7 days** | F171 | must exceed retry horizon + provider redelivery window |
| `semantic_dedup` | object ids | 7 days | F171 | |
| Dead-letter queue | delivery ids and codes | **14 d Paid / 24 h Free** | F180 | `01` records the Free ceiling |
| Queues (all) | ids only | ≤14 d Paid / 24 h Free | platform | F173 means this is not a PII store |
| `audit_events` | who did what | **1 year**, proposed | F236 | justify before publishing |
| Workers Logs | redacted operational fields | configured retention, documented | F12 + observability config | must be stated, not assumed |
| D1 Time Travel | the whole database | **30 d Paid**, max 10 restores / 10 min | platform | see below |

- [ ] Every retention value has a named enforcement job with a staleness alert (F190).
- [ ] **D1 Time Travel is the hard limit on erasure promises.** Cloudflare keeps up to 30 days of
      Time Travel, so a statement like "we deleted your data" must not imply deletion from
      backups. `02` F30 already states this and the privacy wording must match.
- [ ] Deleting a payload does not delete the delivery ledger, because the ledger is the record we
      owe the customer. Deleting a workspace does (F30), once N3 is resolved.
- [ ] Retention is **configurable downward per workspace** where the plan allows it, and the
      current value is visible in the UI. A customer who wants less retention must not need to ask.
- [ ] The 1 MiB webhook cap (D15) stops being a magic number: it becomes a documented policy
      constant tied to provider limits (`05` F63) and to the payload-retention decision.
- [ ] Purging is chunked and resumable, and a partial purge is never reported as complete.

**Design** — Retention is a customer promise and an operational cost, and the two pull in opposite
directions. Writing the matrix once, in one place, with an enforcement job per row, is what stops
it becoming a set of folklore numbers in three different files.

**Errors**

| Condition | Behaviour |
| --- | --- |
| Purge job fails mid-chunk | chunk retried; job is not marked complete |
| Purge job stops running entirely | staleness alert, same as any other job |
| A store has no retention row | treated as a finding; the matrix is complete or the release is blocked |

**Security** — longer retention means a larger breach surface and a longer window during which
"we no longer have it" cannot be true. Retention values should therefore be re-examined whenever a
new store is added.

**Tests**
- `every_store_in_the_matrix_has_an_enforcement_job`
- `purge_removes_only_expired_payloads`
- `purge_is_chunked_and_resumable`
- `delivery_ledger_survives_payload_retention`
- `workspace_deletion_removes_the_ledger_too`
- `documented_retention_matches_the_implemented_default`

**Deps** — F51 (`04`), F171/F180/F184 (`12`), F190 (`12`); F30.

---

## F238 — Data-subject requests

**Priority** P1 · **Status** 🟡 N3 is resolved (workspace deletion, slice W). Built in slice S3: signed-in access (`GET /api/workspace/me/data-export`) and account erasure (`DELETE /api/workspace/me`), with the decisions in `docs/DSAR.md`; operator procedure in `RUNBOOK.md`. Not done: legal basis, deadlines and roles (the operator's), correction and restriction mechanisms, a person-level search of notification content, a second factor or undo window for erasure (AR-41; a recent-sign-in step-up is built), erasure of audit IP and user agent (AR-40), any test against real Cloudflare

**Story** As a user, I want to see and delete my personal data, so that I can exercise the rights
my jurisdiction gives me without emailing support.

**Acceptance**
- [ ] Scope, stated precisely and not over-promised. The personal data we hold is: account email,
      name, session and device metadata (`session.ip_address`, `session.user_agent`), membership
      records, audit rows where that user is the actor, and — if the workspace retains payloads —
      private repository and issue content the user routed to us. **Delivery payloads are the
      workspace's data, not the individual's**, and deletion of a workspace is the mechanism that
      removes them.
- [ ] ⚠️ The legal basis and deadlines must be checked by someone qualified. Cited here as
      pointers, not as legal advice: GDPR Regulation (EU) 2016/679, Art. 15 (access), Art. 16
      (rectification), Art. 17 (erasure), Art. 20 (portability), Art. 32 (security of processing),
      Art. 33 (breach notification), Art. 35 (DPIA) — [EUR-Lex ELI](https://eur-lex.europa.eu/eli/reg/2016/679/oj).
      ⚠️ **UNVERIFIED**: that page did not render when read on 2026-10-13, so the commonly cited
      "one month" response deadline is deliberately **not** stated as fact anywhere in our docs
      until a human confirms it against the official text. What to check: the official consolidated
      text; our controller/processor roles (processor for workspace payload content, controller for
      account data); and whether a Data Processing Agreement is required per workspace.
- [ ] Requests are fulfilled **through the authenticated product**, not by email, so identity is
      already established; an emailed request is verified against the signed-in account before
      anything is disclosed.
- [ ] Export is machine-readable, **credentials redacted** (F30, F39), and excludes: session
      tokens, `dek_wrapped`, any `*_ciphertext`, and the dead `auth_tokens` table (N1/F234).
- [ ] Erasure is two-phase (F30): stop ingestion and delivery → retention window → hard purge,
      with DEK destruction (F40) making the remaining ciphertext unreadable.
- [ ] **Limits are disclosed, not hidden**: D1 Time Travel may retain the database for up to 30
      days (F237); queues retain delivery ids for up to 14 days on Paid (24 hours on Free);
      backups are outside our erasure window and are not separately addressed.
- [ ] A request is completed within the deadline **or** the user is told why it is not complete
      and when it will be. An unanswered request is a breach of trust even when it is not a legal
      breach.
- [ ] A DSR is rate-limited and requires authentication, so the endpoint cannot be used to
      enumerate accounts.

**Design** — N3 (`disableOrganizationDeletion: true` with no replacement) is the blocker: without a
deletion path, Art. 17 cannot be satisfied for a workspace and the privacy wording in
`docs/SECURITY.md` is currently aspirational. This feature is therefore written to be honest about
what does not exist yet rather than to describe a system we do not have.

**Errors**

| Condition | Behaviour |
| --- | --- |
| Request for a workspace the user is not a member of | `404` |
| Export contains a redacted field | always; the export says so rather than omitting it silently |
| Deletion blocked by an active dependency | refuse with the dependency named, so the user can act |

**Security** — the export endpoint is the highest-risk read path in the product because it
deliberately assembles a lot of data in one response. It requires authentication, re-verification
of destructive intent, rate limiting, and audit.

**Tests**
- `export_excludes_every_credential_and_token`
- `export_is_tenant_scoped_and_requires_membership`
- `deletion_removes_workspace_data_or_refuses_with_a_reason`
- `erasure_limitation_wording_matches_documented_platform_retention`
- `dsr_endpoints_are_rate_limited_and_audited`

**Deps** — N3; `02` F30; F39; F40; F237.

---

## F239 — Dependency and supply-chain hygiene

**Priority** P1 · **Status** 🟡 `npm ci`, audit gate with dated exceptions (`scripts/audit-gate.mjs`, `tests/security/audit-gate.test.ts`), SHA-pinned actions, read-only permissions, Dependabot, dev-vars drift test (`tests/config.dev_vars.test.ts`, `tests/security/config-guards.test.ts`), dependency review non-blocking; `npm audit signatures` and `--ignore-scripts` in CI, install-script review in `docs/SUPPLY_CHAIN.md`; not done: OIDC (unverified) · **Contributes to** D14

**Story** As a maintainer, I want the third-party surface small, pinned and continuously checked,
so that a compromised transitive package is a blocked PR rather than a production incident.

**Acceptance**
- [ ] A committed lockfile and `npm ci` in CI, never `npm install` (F01, F02; D14 is partly this).
- [ ] `npm audit --audit-level=high` is a **gate**, not a report. `npm audit` exits non-zero when
      advisories are found and `--audit-level` sets the failure threshold
      ([npm-audit](https://docs.npmjs.com/cli/v11/commands/npm-audit), read 2026-10-13).
- [ ] `npm audit signatures` verifies npm registry signatures **and** sigstore provenance
      attestations for downloaded packages (same source, read 2026-10-13). Run on release builds;
      investigate any package whose signature or attestation fails.
- [ ] `wrangler` pinned to the version used for migrations (F01) — a different Wrangler version can
      apply a different schema to a production database.
- [ ] **Install scripts**: prefer `--ignore-scripts` for dependency installation where the tree
      permits it; any dependency requiring a lifecycle script is listed explicitly with a reason
      and reviewed like any other supply-chain decision (npm documents `ignore-scripts` and
      `foreground-scripts`, read 2026-10-13).
- [ ] Dependency count is treated as a security property, not a style preference: `AGENTS.md`'s lean
      rule, and the concrete reason it exists — every dependency is code running in the request
      path that handles tenant credentials and payloads.
- [ ] Adding a dependency requires an ADR note when it handles credentials, payloads, signing or
      egress. Cryptography is the strictest case: we use the platform's Web Crypto (`03` F33)
      rather than a library for exactly this reason.
- [ ] CI hygiene: `permissions: contents: read`, no `pull_request_target`, secrets only from
      repository secrets on trusted branches, never from forks (F02).
- [ ] **Config drift is a supply-chain-shaped bug**: a test parses `.dev.vars.example` and asserts
      every key it declares appears in `Bindings` — the check that turns D1 (a developer following
      the example file and getting a Worker that throws) into a build failure.
- [ ] Secret rotation on suspicion: GitHub App private key, `BETTER_AUTH_SECRET`, provider tokens.
      `BETTER_AUTH_SECRET` rotation invalidates sessions; plan it as a forced re-auth, not a silent
      change.
- [ ] ⚠️ **UNVERIFIED**: whether Cloudflare Workers deployment supports GitHub OIDC federation, so CI
      needs no long-lived Cloudflare API token. Check the Workers CI/CD or deployment docs before
      promising it; until confirmed, long-lived scoped tokens are the fallback and their scope is
      reviewed.

**Design** — The supply-chain risk for this product is not "someone typos a version"; it is that a
dependency runs inside the Worker that holds every customer's webhook credentials. That argues for
a small tree (`AGENTS.md`), platform primitives over libraries where the platform has them, and
gates rather than reports.

**Errors** — n/a; process controls.

**Security** — an advisory with no available fix is triaged within a stated window and recorded in
the risk register (F241), rather than left in a log nobody reads.

**Tests** — CI is the test: each gate is verified once by deliberately violating it, exactly as F02
requires.

**Deps** — F01, F02; `03` F33.

---

## F240 — Security release checklist

**Priority** P0 · **Status** 🟡 `docs/RELEASE_GATES.md` is a living checklist naming the four gates, asserted by `tests/security/config-guards.test.ts`; every gate is partly done or not done: no real-provider run, no staging tenant-isolation drill, no KEK rotation rehearsal, no rollback rehearsal

**Story** As a maintainer, I want one checklist that decides whether a release may be called
secure, so that "production-ready" is earned by evidence rather than asserted.

**Acceptance** — the rule from `AGENTS.md`, quoted rather than paraphrased:

> Don't describe a feature as production-ready until it has passed real-provider end-to-end
> validation, tenant isolation and secret-handling review, and a rollback rehearsal.

- [ ] Four mandatory gates, each with named evidence and a named reviewer:

| Gate | Evidence | Reviewer |
| --- | --- | --- |
| Real-provider end-to-end | a staging run through the **actual** GitHub App and a real Lark/Slack/Teams destination: create → test → deliver → inspect → retry, with links to the runs | connector owner |
| Tenant isolation | the drill in F233, plus the static query checks | security reviewer |
| Secret-handling | no secret value or webhook URL in logs, dead letters, previews or exports (F12, F39); KEK custody and rotation rehearsed | security reviewer |
| Rollback rehearsal | deploy → migrate → roll back, executed, not described | maintainer |

- [ ] Plus, from `docs/RELEASE_GATES.md`, unchanged and still open: signed-webhook integration tests;
      invalid-payload and duplicate-delivery tests; D1 outbox transaction and queue
      retry/reconciliation under injected failures; permanent-failure terminal states (never left
      `retrying`); documented rollback and migrations.
- [ ] **Wording rule**: the words "production-ready", "secure" and "audited" do not appear in any
      doc, commit message or marketing page unless this table is complete for the release being
      described. `docs/SECURITY.md` keeps the line "No formal security audit has been performed"
      until that is true.
- [ ] The checklist runs per release, not per quarter, and its result is attached to the release.
- [ ] A release that changes the SSRF allowlist, the KEK, the taxonomy or the tenant predicates
      triggers a re-run of the relevant gate even if nothing else changed.
- [ ] A red gate blocks the merge; an exception requires a named owner, a written rationale and an
      entry in the risk register (F241) with a review date.

**Design** — A checklist that is advisory is a document; a checklist that gates is a control. The
"wording rule" is included because the failure mode of security programmes is vocabulary: once a
feature is described as production-ready in the README, every later reader assumes the gates were
run.

**Errors** — a missing evidence link is a failed gate, not a note.

**Security** — the checklist is the only place where "we believe it is safe" becomes "here is what
we ran".

**Tests** — n/a (process). CI can at minimum assert the checklist exists and names all four gates.

**Deps** — F233; `docs/RELEASE_GATES.md`.

---

## F241 — Known-accepted-risk register

**Priority** P0 · **Status** ✅ register is `docs/THREAT_MODEL.md` section 7 with owner and review trigger per row, and a CI check that every referenced AR id exists (`tests/security/config-guards.test.ts`); gaps: no 180-day review dates recorded, no privacy-policy link, some listed compensating controls are themselves unbuilt

**Story** As a customer, an investor or a reviewer, I want to see what we know is risky and why we
chose it, so that trust is based on disclosure rather than on absence of bad news.

**Acceptance**
- [ ] This table is the single register; it is linked from `docs/SECURITY.md` and from the privacy
      policy. Every row has an **owner** and a **review trigger**, so a stale risk is visible.
- [ ] Adding a row is a PR. Removing a row requires the compensating control to have shipped.
- [ ] Any risk here that a customer would reasonably consider unacceptable must also appear in
      customer-facing material — the register is internal, the disclosure is not.

| ID | Risk | Why accepted | Compensating controls | Owner | Review trigger |
| --- | --- | --- | --- | --- | --- |
| AR-1 | Better Auth stores session tokens as cleartext, usable credentials (F234) | hand-rolled session storage would put auth correctness in our code | time-bounded expiry, immediate revocation, no read path, `cookieCache` off, revoke-others UI | identity owner | a Better Auth release that hashes tokens, or any D1 exposure |
| AR-2 | **No platform egress filtering** — the destination allowlist is entirely ours (F228) | Workers `fetch()` documents no destination restriction; the only platform control requires a VPC/Zero Trust deployment | registry allowlist with citations and 180-day expiry (F229), send-time re-validation (F230), no redirects, per-account outbound shaping | security owner | Gateway egress adoption; any allowlist bypass report |
| AR-3 | **DNS rebinding cannot be prevented** in Workers (F230) | no custom address resolution while preserving SNI and certificate verification | exact-host allowlist, IP literals rejected, bounded body and timeout, rate-shaped egress, abuse detection | security owner | Workers exposes a pinning-capable fetch, or an incident |
| AR-4 | Keystore custody depends on Secrets Store (open beta) and/or Worker secrets (`03` F34) | no HSM at this scale or price | tiered key sources, boot assertion, no key in D1, rotation runbook, environment separation | platform owner | Secrets Store GA, or a breaking beta change |
| AR-5 | At-least-once delivery produces duplicates we cannot prevent (F185) | Queues offers no exactly-once; Slack has no server-side dedup key | per-message ack, delivery claims, client-side dedup window, duplicate surface shown to the customer | reliability owner | a destination gains real idempotency |
| AR-6 | Erasure cannot outrun D1 Time Travel (up to 30 d) or queue retention (F237) | platform-managed backups | disclosed in privacy wording, DEK destruction makes ciphertext unreadable (`03` F40), retention job + staleness alert | data owner | Cloudflare changes Time Travel or retention |
| AR-7 | Email Sending: 200 verified destinations/account, routing-domains-only, 3,000/month, Paid only (F235) | sufficient for V1; transactional mail is not our product | sending domain onboarded, quota monitored, suppression list maintained, migrate to a transactional provider before the limits bite | product owner | approaching 50% of any limit |
| AR-8 | Rate Limiting binding is per-location and "not an accurate accounting system" (F231) | it is a useful coarse pre-filter; D1 cannot absorb every auth request | D1-backed authoritative counters for everything that matters | platform owner | Cloudflare changes the locality semantics |
| AR-9 | Provider APIs change under us — retired webhooks, moved hosts, new error shapes (F229, `07`) | we do not control third-party platforms | per-destination classification, terminal-not-retry for 410/404, allowlist with citations, reconnect prompts | connector owners | a provider changelog, or an unmapped-response metric spike |
| AR-10 | Dead legacy tables remain in the migration chain, one with plaintext tokens (N1, F234) | already applied to live databases; dropping them risks more than it costs | header comment marking supersession, static test asserting no source file references them, excluded from exports | identity owner | a future migration drops them |
| AR-11 | Outbound requests reveal our egress IP to destination providers, and providers log our requests | inherent to delivering notifications | no tenant payload beyond the rendered notification; payloads bounded (F95); per-customer provider accounts where possible | product owner | a provider requires static allow-listed IPs |
| AR-12 | A hostile destination can receive a POST containing notification content | that is the product's function, bounded by AR-2/AR-3 | host allowlist, body caps, timeouts, rate shaping, abuse detection | security owner | an allowlist entry is broadened |

- [ ] Every AR row is reviewed at least every **180 days**, on the same clock as F229's staleness
      test, and the review date is recorded in the table.
- [ ] An AR row whose compensating control regresses stops being "accepted" and becomes a defect.

**Design** — An accepted risk that is not written down is a vulnerability nobody is tracking. The
review-trigger column is the load-bearing part: a risk without a trigger is a risk someone has
stopped thinking about.

**Errors** — n/a.

**Security** — this table is the closest thing to an audit result we have, and it is not one.

**Tests** — a CI check that every `AR-n` referenced elsewhere in `docs/` exists here.

**Deps** — F228, F230, F234, F235, F237, F240.

---

## F242 — Incident response and disclosure

**Priority** P1 · **Status** 🟡 root `SECURITY.md` (GitHub private vulnerability reporting, no invented address), `security.txt` (generated by the Worker, tested, deployed reachability unverified), `docs/INCIDENT_RESPONSE.md` with severity classes, a playbook for each of S1 to S4, the evidence-preservation rule and a postmortem template (never rehearsed). Not done: rehearsal, a monitored contact, response targets, an evidence hold that blocks retention jobs, sign-up kill switch, notification-deadline decisions

**Story** As a customer whose data or credentials were affected, I want a fast, honest and
documented response, so that an incident costs me less than silence would.

**Acceptance**
- [ ] Severity defined by impact, with the four scenarios this product actually has:
      **S1** cross-tenant data exposure; **S2** credential compromise (destination webhook, signing
      secret, `BETTER_AUTH_SECRET`, KEK, GitHub App private key); **S3** sustained delivery
      corruption or silent loss (violating the core product promise); **S4** degraded availability.
- [ ] A runbook per scenario, each naming the first actions. Pre-written, because improvisation
      during an incident is what turns S2 into S1:

| Scenario | First actions |
| --- | --- |
| KEK suspected leaked | rotate KEK (`03` F37), rewrap, destroy old version, audit `key_destroyed` |
| Destination credential leaked | revoke (`03` F40), destroy DEK, purge ciphertext, audit, tell the customer with the fingerprint |
| Signing secret leaked | rotate — Standard Webhooks' space-delimited signature list makes this zero-downtime (`03` F38) |
| Cross-tenant read observed | stop the route, preserve logs, disable public signup, run the F233 drill, notify affected tenants |
| Compromised dependency | pin to last-good, `npm audit signatures`, re-deploy, audit the affected code path for secret access |

- [ ] Evidence preservation is declared **before** a retention purge can destroy the record, and
      when they conflict, preservation wins for the incident window and is documented afterwards.
      A retention job and an incident are not allowed to disagree silently.
- [ ] ⚠️ **UNVERIFIED**: notification deadlines under GDPR Art. 33 (the widely cited figure is 72
      hours to the supervisory authority) and equivalent regimes. Cited as a pointer
      ([EUR-Lex ELI](https://eur-lex.europa.eu/eli/reg/2016/679/oj)) and **not** restated as fact in
      any customer-facing document until confirmed against the official text. What to check: the
      regulation text, our notification obligations as processor versus controller, and the
      jurisdiction-specific regimes for the workspaces we serve.
- [ ] A published contact path for reports — `security.txt` plus a monitored address — so that a
      researcher does not have to find a support form.
- [ ] A postmortem template, internal, for S1–S3: timeline, blast radius in tenants and rows, what
      was detected by us versus by someone else, and which controls were load-bearing.
- [ ] **No claim about an incident is published that is not backed by data we can show.** This is
      the same rule as the rest of this repository: no fabricated audits, no fabricated benchmarks,
      no invented test results.
- [ ] Every S1 and S2 incident produces a risk-register review within 14 days (F241).

**Design** — Incident response is written before it is needed because the two things an incident
consumes are judgement and access, and both are much cheaper in advance. The runbook's value is
its first actions, not its length.

**Errors** — n/a.

**Security** — incident notes are themselves sensitive and follow F12; the customer-facing summary
follows the same discipline.

**Tests**
- `every_severity_level_has_a_runbook_with_named_first_actions`
- `security_contact_path_is_published_and_monitored`
- `incident_preservation_blocks_retention_purges_for_the_window`

**Deps** — F236, F237, F241; runbooks reference `03` F37, F38, F40.