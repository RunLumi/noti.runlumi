# ADR 0014: Extended destinations (Discord and the signed customer webhook)

Status: Accepted (custom webhook **off by default**, see decision 18) · Date: 2026-10-13 · Implements slice 8a (F107, F109 in part; F108 in part;
F115, F116, F117 in part), as listed under "Deliberately not done"

## Context

Spec 09 adds destinations beyond Lark, Slack and Teams. Two of them fit the platform today and
are built here; two do not, and are not built.

- **Discord** is a documented webhook with a documented failure mode that is a property of our
  shared egress, not of one delivery (spec 09 "three findings", F108).
- **A customer-chosen HTTPS webhook** is the only destination where we fetch a URL an attacker
  may choose. It is the highest SSRF risk in the product (F115) and is also the first place
  Noti is a webhook *producer*, so it signs what it sends (F116).
- **Telegram**: not built. The reference (section 5) records that a bot token belongs to one
  person and one bot lives in one workspace, which no multi-tenant app model can express.
  F110 recommends against it; this ADR follows that recommendation.
- **Email**: not built (see "Email" below).

All provider facts come from `docs/DESTINATION_API_REFERENCE.md`. Anything it marks unverified
is unverified here, and the code comments say so.

## Decisions

### Shared

1. **Teams' path, unchanged.** Each destination is an adapter under
   `src/connectors/destinations/<kind>/` (`render`, `classify`, `adapter`), registered in the
   two `switch`es of `index.ts`, with its URL rules in `url-policy.ts`, its config in
   `config.ts`, and its capabilities in `capabilities.ts`. The consumer, the API and the
   dashboard learn the new kinds from `DESTINATION_KINDS`; none of them has a destination
   branch except where the behaviour genuinely differs (listed below).
2. **Migration 0018 widens one CHECK and nothing else.** `integrations` is rebuilt (SQLite
   cannot alter a CHECK) carrying every column, index and trigger added since 0012, including
   `filters_json` with its own CHECK (0015) and `source_id` with its three triggers and index
   (0017). `tests/migration-0018.test.ts` diffs `sqlite_master` before and after and fails on
   any difference other than the kind list, so a later column cannot be silently dropped by
   the next rebuild without that test being updated. One non-obvious requirement was found by
   running it: `sources_delete_integrations` is a trigger on `sources` that names
   `integrations`, and SQLite refuses to rename the new table into place while it exists
   ("no such table: main.integrations"), so it is dropped first and recreated last.
3. **Capabilities describe our adapter, not the provider.** Discord can update, delete and
   reply to messages it returned an id for, and takes a per-message username and avatar. We do
   not persist message ids (F156 is not built) or expose identity settings, so
   `canUpdate`, `canDelete`, `canReply` and `canCustomizeIdentity` are `false` until they
   work. Spec 09 F107 lists them as `true`; reporting them would be a fake capability (F93).
4. **`DeliveryMeta` on `buildRequest`.** The pure renderer cannot know the delivery id; a signed
   request must carry it as `webhook-id`. `buildRequest(message, config, now, meta?)` gains an
   optional fourth argument, `prepareDelivery` forwards `options.meta`, the consumer passes the
   delivery id and workspace id. Other adapters ignore it.

### Discord

5. **`wait=true` is always sent**, on the documented `/api/v10/webhooks/{id}/{token}` endpoint.
   A `200` is therefore a delivery; a `204` (what `wait=false` returns) is `accepted`, because
   it proves nothing. A malformed body on a `200` is still `delivered`: the message exists,
   and spec 09's `destination_unavailable` would retry and duplicate it.
6. **Mentions cannot ping, in two layers.** Every payload on every rung carries
   `allowed_mentions: {"parse": []}` (a constant, so no code path builds a payload without
   it), and the text is neutralised so it also *reads* as inert (`<` to a fullwidth form, `@`
   followed by a zero-width space, `[` `]` neutralised, markdown operators backslash-escaped in
   message content and embed descriptions; titles and footers are not backslash-escaped
   because a backslash would be shown literally).
7. **Exactly one embed per message.** Discord deduplicates embeds by URL; two events from one
   repository would otherwise collapse. Field limits (256 / 4096 / 2048 / 2000, 6000 combined)
   are enforced at render time; a test asserts the worst case sums below 6000.
8. **Accepted URL forms** are only `https://discord.com/api/webhooks/{id}/{token}` and the
   `/api/v10/` form, with at most `?thread_id=<digits>`. `discordapp.com`, `canary.` and `ptb.`
   are rejected because the reference does not record them (UNVERIFIED, not guessed). The
   stored URL is normalised (no version, no `wait`).
9. **A webhook that is gone pauses the integration; nothing else does.** A `404` or `410` is
   permanent with zero retries (the generic mapping; asserted because it is the most
   consequential row in the spec). A `401` or `403` is a dead webhook **only** if the JSON body
   carries Discord's own code for one, `10015` (Unknown Webhook) or `50027` (Invalid Webhook
   Token); the classifier parses the 2 KB prefix `send.ts` already read, keeps only the code
   (our own table, never the body) and nothing reaches a log. Any other `401`/`403` (an egress
   restriction, an edge block page, a transient auth fault) is **retryable** with our own
   provider code `http_401`/`http_403`, capped at two attempts
   (`DISCORD_UNAUTHORIZED_MAX_ATTEMPTS`) because each spends the shared invalid-request budget,
   and never pauses anything. For a dead webhook the consumer sets `enabled = 0` and writes
   `integration.auto_pause` (actor `null`) in **one `batch`**, the audit row guarded on the
   update having changed a row, and the update is tied to the credential the failed delivery
   used (`webhook_envelope IS ?` and `webhook_ciphertext = ?` with the bytes it opened). If the
   customer replaced the webhook while the request was in flight, nothing is paused and nothing
   is audited. That is what stops the *next* event for the same dead webhook from making the
   same request, which is what Discord's "temporary restriction" warning is about. Tests cover
   the in-flight rotation race on both a legacy-format and a sealed credential, and a plain
   `403` that must not pause. (UNVERIFIED: that `10015` and `50027` are the codes Discord
   returns for these cases; they are not in the reference.)
10. **Rate limits are read from the response.** `429` uses the body's `retry_after` (float
    seconds), then `Retry-After`, clamped to one hour; `global: true` is recorded as a
    provider code. Nothing but the documented global 50 requests/second is a number in code,
    and that one is not enforced either (see below).

### Customer webhook (`generic_webhook`)

11. **Policy, in one function.** `checkDestinationUrl('generic_webhook', url)` is the only
    implementation; `validateDestinationConfig` (write time, API and consumer) and `sendRequest`
    (before every send) both call it. It requires `https:`, no userinfo, no fragment, port 443,
    total length at most 2048 and hostname at most 253, and rejects:
    - every IP notation. The WHATWG parser normalises decimal, octal, hexadecimal, short,
      percent-encoded and fullwidth forms to dotted quad before the policy sees them; all are
      then `ip_literal`, and a name whose last label is not alphabetic is `host`;
    - single-label names (`metadata`, `intranet`), trailing-dot names, and the final labels
      `localhost`, `local`, `localdomain`, `internal`, `intranet`, `private`, `home`, `lan`,
      `corp`, `test`, `example`, `invalid`, `onion`, `arpa`;
    - public wildcard-DNS services that exist to turn a name into an IP (`nip.io`, `sslip.io`,
      `xip.io`, `localtest.me`, `lvh.me`, `vcap.me`, `lacolhost.com`, `traefik.me`), a
      best-effort and incomplete list;
    - our own domain: `runlumi.app`, **and** the host of `APP_ORIGIN` plus its parent domain
      with every subdomain (`ownHostsOf`), passed into the policy at save time (API), at send
      time (`sendRequest`'s `urlPolicy`) and by the consumer, so a destination cannot loop back
      into our ingress whatever the deployment is called;
    - Cloudflare-hosted infrastructure: `workers.dev`, `pages.dev` and `cfargotunnel.com`
      with every subdomain. A tenant's Worker or tunnel is not an excuse to aim a destination
      at infrastructure that Cloudflare routes differently from the public internet, and a
      sibling tenant's or our own `*.workers.dev` hostname is exactly that. `workers_dev` is
      also set to `false` in `wrangler.jsonc`, so the default `*.workers.dev` URL does not
      expose our own Worker on a second hostname (nothing in the docs or config depends on it;
      production is served from the custom domain in `APP_ORIGIN`; `wrangler dev` is
      unaffected).
12. **No redirect is ever followed** (`redirect: 'manual'`, 3xx is a permanent
    `destination_url_rejected`), requests are bounded by the 10-second outbound timeout, the
    body by a 64,000-byte budget, and customers cannot add headers. `send.ts` reads at most a
    2 KB prefix of the response body for every destination kind (to let classifiers read a
    short code); the custom-webhook classifier ignores it entirely, nothing from it is stored
    or logged, and it is cancelled after the prefix.
13. **Save-time DNS verification, honestly scoped.** On create and credential rotation the API
    resolves the host's A and AAAA records through Cloudflare's DNS-over-HTTPS JSON endpoint
    and refuses it if any address is private or reserved (`address-policy.ts`: RFC 6890 IPv4,
    and IPv6 deny-by-default outside `2000::/3`, including IPv4-mapped, NAT64, 6to4 and
    Teredo). It fails closed: a failed lookup refuses the save with "try again". A blocked
    address is decisive even if the other family failed. A public name whose answer chain
    contains a CNAME to a blocked name (internal suffix, wildcard-DNS service, Cloudflare
    infrastructure, our own host, an IP literal) is refused on the alias, whatever it finally
    resolves to. The same shape and DNS checks run again when a custom webhook is **re-enabled**
    (`PATCH enabled: true`), against the stored host, because the record may have changed since
    it was saved.
    **This does not defeat DNS rebinding.** Workers `fetch` resolves at the edge and cannot be
    pinned to an address; the answer we check is a point-in-time answer from a different
    resolver path. A customer who controls their zone can answer with a public address now and
    a private one later. Nothing at send time inspects the connected address. The residual risk
    is AR-30 in the threat model. What is **not** built, and what would reduce it most:
    - the per-workspace host allowlist (F115): it removes the attacker's choice of host and is
      the strongest control available;
    - periodic re-resolution of stored hosts with disable-and-alert on a change, and recording
      the resolved addresses (needs a column or table; `docs/specs/09` F115);
    - testing whether Workers egress can reach `169.254.169.254` or RFC 1918 space at all (the
      spec says to assume it can until shown otherwise; this slice assumes it can).
14. **Standard Webhooks, producer side.** `webhook-id` is the delivery id, stable across our own
    retries; `webhook-timestamp` is unix seconds of the attempt (a retry is signed afresh);
    `webhook-signature` is `v1,` plus base64 HMAC-SHA256 over `id.timestamp.body`, computed
    with the same `sign` the generic-source verifier tests against, so what we send is what we
    verify. The body is a small versioned JSON envelope (`version`, `type`, `id`, `time`,
    `workspaceId`, `notification{title,eventType,url?,repo?,actor?,status?,summary?}`), with
    text bounded and control and bidi characters stripped but not escaped (it is data for a
    program). Headers are `webhook-*`, `x-noti-delivery-id`, `x-noti-event-type` (only if it
    matches the catalog shape) and `user-agent`.
15. **Never unsigned.** `generic_webhook` configuration without a well-formed `whsec_` secret
    does not validate; `buildRequest` throws on a bad secret or a delivery id that is not
    Standard Webhooks-safe; the consumer records an `internal_error`/`config_invalid` outcome
    and no request is made. The secret is generated by the server (`whsec_` + 32 CSPRNG
    bytes), sealed in the existing `lark_secret_envelope` column under field `signing_secret`
    (no new column), returned exactly once in the `201` (and in the `200` of a credential
    rotation, which always issues a new one) with `Cache-Control: no-store`, and never read
    back, listed, exported, logged or audited. A caller cannot supply it.
16. **Classification is total and from the status code alone** (`generic-webhook/classify.ts`):
    2xx delivered (202 `accepted`), 3xx permanent, 400/422 permanent `payload_rejected`,
    401/403 `destination_unauthorized`, 404/410/405/501 `destination_revoked`, 413
    `payload_too_large`, 408/425/429/5xx retryable (`Retry-After` honoured), any other 4xx
    permanent and flagged `unmapped`. The body is never read. There is deliberately no
    "expected success status" setting: spec 09 F117 allows one, but its own warning (a `302`
    configured as success turns a broken endpoint into a silent black hole) is reason enough
    to ship without it.

### Release gate, quotas and what a tenant sees

18. **`GENERIC_WEBHOOK_ENABLED` (default `"false"`) gates the custom webhook.** Declared in
    `wrangler.jsonc` and `.dev.vars.example` (the configuration-contract test covers both).
    Only the exact string `true` enables it. While it is off:
    - the API refuses to create one (also from a source) with the single message
      "This destination type is not available yet." on `destination`, checked in
      `parseDestination` **before** anything about the URL is looked at, so the gate is not an
      oracle for what the policy accepts;
    - the API refuses to re-enable one or rotate its credentials (the same message), while
      pausing, renaming and deleting still work;
    - the consumer refuses to send to a stored row: permanent `config_invalid`, diagnostic
      `destination_type_disabled`, no network call, even for a row that was stored while the
      flag was on (turning it on and redelivering sends);
    - `GET /api/integrations` returns `capabilities: {genericWebhook: boolean}` and the
      dashboard wizard hides the option (and treats an unloaded list as "off").
    **Criteria to turn it on in production**, all of them: (1) the per-workspace host
    allowlist, prompted for the first custom webhook in a workspace; (2) periodic
    re-resolution of stored hosts with disable-and-alert on a change into a blocked range, and
    recorded resolved addresses; (3) a canary test from a deployed Worker proving what its
    egress can and cannot reach (a canary endpoint on a private address, `169.254.169.254`, and
    a rebinding hostname) with the result recorded here; (4) a Worker-side check that the
    DNS-over-HTTPS lookup works as designed; (5) the threat-model review of AR-30 repeated with
    those in place. Until then it is a feature that exists in the code and cannot be reached.
19. **`global_fetch_strictly_public` was researched and is NOT added.** It exists
    (https://developers.cloudflare.com/workers/configuration/compatibility-flags/, read
    2026-10-13; disable flag `global_fetch_private_origin`), but the documented behaviour is
    that `fetch()` "will strictly route requests as if they were made on the public Internet",
    so that a request to the Worker's own zone loops back to Cloudflare's front door instead of
    going to the origin. That is a routing semantic, not a documented restriction of
    `fetch()` to public IP addresses, and the page lists no flag that is. It must not be
    counted as an SSRF control, and it changes how same-zone requests are routed for the whole
    Worker, so it is left out. UNVERIFIED: whether it has any effect on private-address
    reachability; test it in the canary (criterion 3) before relying on it.
20. **Caps and the tenant-visible reason.** A workspace may have at most 10 custom webhooks
    (`MAX_GENERIC_WEBHOOKS_PER_WORKSPACE`, `409`), on top of the per-user mutation limit.
    Connection failures to a customer endpoint (timeout, refused, DNS, TLS, reset) are all
    recorded as `destination_unavailable` with the diagnostic `destination_unreachable`, so a
    tenant cannot tell what answers on a private address by choosing hosts and reading the
    reason. HTTP statuses stay visible (the customer needs them to fix their own endpoint).

### Dashboard

17. Two new entries in `DESTINATIONS` with numbered steps, notes and a docs link; copy in a
    separate catalogue (`messages.destinations.en.ts`, the filters pattern). The custom
    webhook's secret is revealed once after the save (create wizard) or after a rotation
    (credentials section) by `IssuedSecret`, with the same copy-and-confirm behaviour as a
    source's secret. The chat picker on a source (`ConnectChat`) does not offer the custom
    webhook yet, because that flow has no reveal step. The client reuses the server's
    `url-policy.ts` unchanged, so client and server verdicts cannot drift (a test compares
    them).

## Deliberately not done

- **Email.** Spec 09 F112 rejects Cloudflare Email Sending for notifications (verified
  destination gate, 200-recipient cap, own-routing-domains-only, Beta, unpublished quota) and
  recommends a bring-your-own-key transactional provider (Resend), per-customer sender domain
  verification, a stable `Message-ID`, and one-click unsubscribe (F150, a legal requirement).
  The task's "only if the P0/P1 core fits" condition is not met: the `AUTH_EMAIL` binding is
  the rejected option for this use, and the recommended one needs a provider account, a
  verified-recipient flow and an unsubscribe surface that do not exist. Not built.
- **Telegram** (F110, F111): not built, by the spec's own recommendation.
- **Discord**: the cross-workspace persistent circuit breaker and customer notification of
  F108 (the per-integration pause above is a partial, tenant-local substitute); honouring
  `X-RateLimit-Remaining` to delay the next send; update-in-place and message-id capture
  (F109, F156); `username`, `avatar_url` and programmatic webhook creation; a numeric
  per-route limit (UNVERIFIED in the reference, so none is invented).
- **Customer webhook**: the *enabling criteria* of decision 18 (the host allowlist, periodic
  re-resolution, a Worker egress canary); the workspace host allowlist, periodic re-resolution, recording of
  resolved addresses, the payload template (`GenericMapping`, F78 is not built), multi-secret
  rotation overlap (F77), `x-noti-event-id` and `x-noti-correlation-id` headers (the queued
  message carries neither), a "send a test" action (F98), the optional response-body excerpt,
  an expected-status setting (see 16), per-destination rate limiting and the circuit breaker
  (F183, F187).
- Generic-webhook destinations from a source's chat picker (see 17).
- Registry-driven registration (F105): destinations are still two `switch`es.

## UNVERIFIED provider and platform facts

- Discord: the numeric per-route limit of Execute Webhook; whether `discordapp.com`, `canary.`
  and `ptb.` webhook hosts are valid (rejected); token and id lengths and character classes
  (accepted loosely: 15-25 digits, 1-256 of `[A-Za-z0-9._-]`); which markdown subset embed
  titles and footers render; the exact `400` body for an over-limit embed; that `404` still
  carries the restriction behaviour described in the docs (taken from the docs, not tested).
- Whether `global_fetch_strictly_public` restricts anything about private addresses
  (decision 19: documented only as routing; not added).
- Discord: that `10015` and `50027` are the error codes for a deleted webhook and a wrong token.
- Cloudflare: that `cloudflare-dns.com/dns-query` answers a Worker the way it answered a
  developer machine on 2026-10-13 (the response shape was confirmed there only); Workers
  egress reachability of metadata and private ranges; whether a Worker may `fetch` a
  customer endpoint on the same zone (blocked now by the own-host rule; `workers.dev`,
  `pages.dev` and `cfargotunnel.com` are blocked outright).
- No real Discord webhook or customer endpoint was contacted; every response is a fixture.

## Consequences

- A customer can send to Discord and to their own signed endpoint end to end, with tests over
  the real migrations and consumer.
- The customer webhook is the largest new attack surface in the product. It ships **disabled**
  (decision 18) with a stated residual risk (AR-30), not a claim of safety. The next security step is the
  workspace host allowlist plus periodic re-resolution.
- Rolling the Worker back keeps working against the new schema but cannot deliver the new kinds;
  disable them first (the migration's header says how to restore the old CHECK).
- `buildRequest`'s fourth parameter is optional, so adapters outside this slice are unchanged.
