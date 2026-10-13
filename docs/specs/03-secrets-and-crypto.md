# 03 — Secrets & Cryptography

> External references read **2026-10-13** unless a different date is stated next to the
> claim. Source of record: `docs/specs/README.md#sources` (still to be created — see F14).
> Anything I could not verify is marked **⚠️ UNVERIFIED** together with what to check.
> This file does not restate error taxonomy (F13), logging/redaction (F11/F12), queue
> message shape (F173) or tenancy (F25/F26); it depends on them.

## What exists today, stated plainly

`src/index.ts:20-23` is the entire current implementation:

```ts
async function decrypt(ciphertext:string, keyHex:string) {
  if (!/^[a-f0-9]{64}$/i.test(keyHex)) throw Error('Invalid encryption key');
  const raw = Uint8Array.from(keyHex.match(/../g)!,x=>parseInt(x,16));
  const key = await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['decrypt']);
  const bytes = Uint8Array.from(atob(ciphertext),c=>c.charCodeAt(0));
  return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(0,12)},key,bytes.slice(12)));
}
```

That is D6 in full. One AES-256-GCM key, one 12-byte IV prefixed to the ciphertext, stored
as base64 `TEXT`, with **no additional authenticated data, no key version, no row binding and
no rotation path**. The consequences that matter:

- A ciphertext copied from row A into row B **decrypts cleanly** and is delivered to the wrong
  destination. AEAD without AAD authenticates the bytes, not their *meaning*.
- There is no way to tell a v1 ciphertext from a future v2 ciphertext, so no migration can be
  written that is safe to roll back.
- Rotation would mean rewriting every `integrations` row in one release, against a database that
  processes queries one at a time (`01`, D1 limits).
- The key comes from `ENCRYPTION_KEY` while `.dev.vars.example` declares `ENCRYPTION_KEY_BASE64`
  (D1) — a migration that reads the wrong name re-encrypts nothing and destroys everything.

**One good decision to preserve** (`00-current-state.md` §3): encryption happens *before* D1.
There is no code path that writes a plaintext destination URL. Every feature below keeps that.

### ⚠️ Correction to the audit's pointers

`00-current-state.md` D6 says *"Fix: F152 (envelope encryption with AAD binding to
`integration_id`), F155 (rotation)."* Those IDs now belong to `11-grouping-and-noise.md`
(F152 = resolution notices, F155 = preset definitions). The canonical IDs for the D6 fix are
**F33–F40 in this file**. `07-destination-capabilities.md` F97 already points at **F36** for AAD
binding, and that reference is correct against this numbering.

---

## F33 — Envelope encryption core

**Priority** P0 · **Status** not started · **Fixes** D6 (core half)

**Story** As a security engineer, I want every stored credential sealed by a single audited
primitive, so that a database dump, a log line or a queue inspector yields no usable secret.

**Acceptance**
- [ ] Exactly two exported functions, `seal(plaintext, ctx)` and `open(envelope, ctx)`. Every
      secret field in the codebase goes through them. A third entry point is a review failure.
- [ ] Envelope layout is fixed and versioned (below). Parsing is strict: wrong magic, unknown
      version, truncated header or short ciphertext ⇒ `malformed_envelope`, never a partial read.
- [ ] AES-256-GCM. 96-bit (12-byte) random IV per `seal`, never derived, never reused under the
      same key. 128-bit tag (the WebCrypto default).
- [ ] The IV comes from `crypto.getRandomValues`, never from a counter, a timestamp, a UUID, or
      `Math.random`.
- [ ] Envelope stored as `BLOB`, not base64 `TEXT`. Base64 costs 33% and makes "is this
      ciphertext or is this a truncated string?" a runtime question.
- [ ] Plaintext exists only as a `Uint8Array` local and the decoded `string` return value. Never
      written to a log, an error, a queue message (F173/D5) or an `audit_events.metadata_json`.
- [ ] `seal` refuses an empty plaintext and a plaintext over 8 KiB. A webhook URL or a signing
      secret is ~100 bytes; anything larger is a bug or an attempt to store a payload.
- [ ] Failures map onto the F13 taxonomy: `destination_credentials_invalid` (non-retryable) for a
      destination credential, `config_invalid` for an unsealable KEK.

**Design** — Two layers, because one layer is the wrong shape for a multi-tenant product.
Encrypting every field directly under a single account key makes key rotation a full-table
rewrite and makes single-tenant erasure impossible. Envelope encryption inverts that:

```
KEK (Secrets Store / Worker secret, never in D1)
  └─ HKDF ──▶ tenant key TK(org_id)           [F35]
        └─ wraps ──▶ per-connection DEK (32 random bytes, stored as dek_wrapped)
              └─ AES-GCM(+AAD) ──▶ field ciphertexts: url, signing_secret, oauth_refresh …
```

Rotation of the KEK then rewrites N DEKs, not M field values, and destroying one DEK erases one
connection without touching anyone else (F40). The cost is one extra AES operation and one extra
column per row, paid on the delivery hot path where we already do a D1 read.

**Why AES-GCM and not XChaCha20-Poly1305.** The Workers runtime's Web Crypto table lists AES-GCM
as fully supported for `encrypt/decrypt`, `generateKey` and `importKey`
([workers/runtime-apis/web-crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/),
read 2026-10-13). XChaCha20 is absent from that table; using it would mean shipping and
reviewing a constant-time JS implementation ourselves, which `AGENTS.md`'s lean-dependency and
Workers-CPU rules both argue against.

**Why the DEK wrap is AES-GCM and not AES-KW.** AES-KW is supported (`wrapKey`/`unwrapKey` ✓ in
the same table) and would be the obvious wrapping primitive. It has **no AAD parameter**, so a
`dek_wrapped` value could be moved between rows undetected — exactly the defect F36 exists to
close, one layer up. AES-GCM with AAD is the only wrapping choice that keeps the property.

**Schema** — envelope byte layout (`BLOB`):

```text
offset  size  field
0       1     format_version   0x01
1       1     flags            reserved, MUST be 0
2       4     kek_version      uint32, big-endian
6       12    iv               96-bit, fresh per seal
18      n     ciphertext ‖ tag AES-GCM, 128-bit tag
```

18 bytes of header per value. D1's max row size is 2 MB (`01`), so this is irrelevant to the
limit and included only because it is free.

```ts
export interface SealContext {
  orgId: string;          // Better Auth organization.id — never client-supplied
  connectionId: string;   // our row id
  field: 'url' | 'signing_secret' | 'dek';
  purpose: 'destination' | 'source.signing';
}
export interface Envelope {
  readonly formatVersion: 1;
  readonly kekVersion: number;
  readonly iv: Uint8Array;       // 12
  readonly ciphertext: Uint8Array;
}
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Bad envelope bytes / unknown version | `destination_credentials_invalid`, permanent, alert `malformed_envelope` |
| AES-GCM tag mismatch (wrong key, or AAD mismatch) | `destination_credentials_invalid`, permanent; **never** retried — a wrong key does not become right |
| Plaintext over 8 KiB | `internal_error` in the caller; programming error, surfaces in tests |
| KEK missing / wrong length at boot | `503` from `/health`, F04 names the binding, never the value |
| `crypto.subtle` throws (platform) | `internal_error`, retryable, one attempt only per invocation |

**Security** — a 96-bit random nonce under a single key is safe up to roughly 2^32 encryptions
for that key (birthday bound); we cap a DEK at 2^32 `seal` calls and destroy it (F37) rather
than reasoning about it at 10 events/second. Plaintext lifetime inside the isolate is bounded by
one request; we do not cache `CryptoKey` objects across invocations beyond the module scope of
one invocation.

**Tests**
- `envelope_round_trips_through_seal_and_open`
- `envelope_layout_matches_the_specified_byte_offsets`
- `malformed_envelope_is_rejected_without_partial_plaintext`
- `every_seal_uses_a_fresh_iv`
- `seal_rejects_plaintext_over_the_size_cap`
- `no_secret_bearing_module_may_import_aes_gcm_directly` (static lint rule)
- `envelope_is_stored_as_blob_not_text`

**Deps** — F04 (boot assertion), F12 (redaction), F13 (taxonomy).

---

## F34 — Key storage boundary: Secrets Store holds keys, D1 holds ciphertext

**Priority** P0 · **Status** not started · **Fixes** D6 (storage half)

**Story** As a security engineer, I want the key that can read the database to live outside the
database, so that read access to D1 is not equivalent to decryption access.

**Acceptance**
- [ ] The KEK is read from a **Secrets Store binding**, declared in `wrangler.jsonc` as
      `secrets_store_secrets: [{ binding, store_id, secret_name }]` and accessed with
      `await env.<BINDING>.get()` — the account-level API documented for Workers
      ([secrets-store/integrations/workers](https://developers.cloudflare.com/secrets-store/integrations/workers/),
      read 2026-10-13).
- [ ] Fallback tier 2 is a **Worker secret** (`wrangler secret put`) for accounts without a
      Secrets Store store. Tier 3 is: refuse to serve. There is no tier 4 that reads a key from
      D1, an env var committed to the repo, or a hardcoded default.
- [ ] **A KEK is never written to D1, Queues, KV, R2, logs, analytics or error messages.**
      Enforced by a test that scans every column of every tenant table for a value equal to the
      configured KEK, not merely for something that looks key-shaped.
- [ ] One KEK per environment (F03). Staging and production KEKs are unrelated values; a Worker
      holding the other environment's KEK refuses to serve.
- [ ] `assertConfig(env)` validates the KEK as exactly 32 bytes after decoding and fails with the
      **name** of the binding, never the value (F04).
- [ ] Local development uses a locally-created Secrets Store secret (Wrangler **without**
      `--remote`) or the tier-2 Worker secret. Documented in `docs/IMPLEMENTATION.md`, because
      the Cloudflare docs state plainly that *"You cannot access production secrets … from your
      local development setup"* (same source, read 2026-10-13).
- [ ] A rotation and a break-glass runbook exists in `docs/IMPLEMENTATION.md` and names the exact
      Wrangler commands, including who is allowed to run them.

**Design** — Why Secrets Store rather than only `wrangler secret`: the dashboard states that once
a secret is saved *"the secret value will no longer be available for viewing"* — which gives us
a tamper-evident, access-logged custody story and a second copy per environment. Secrets Store is
**account-level**, "a secure, centralized location in which account-level secrets are stored"
(read 2026-10-13) and it is **in open beta**. Two consequences we accept rather than pretend
away: (a) the KEK count per Worker is small and fixed, so the feature's "not a per-tenant vault"
character is a feature for us — per-tenant material lives in D1 *wrapped*, F35; (b) if the beta
changes shape, the fallback tier keeps us shipping, so the code reads a KEK through one interface
with two adapters.

⚠️ **UNVERIFIED**: whether a large number of Secrets Store bindings counts against the 128
environment-variable limit documented for Workers (`01`). We deliberately keep KEK bindings at
two per environment (active + previous, F37), so the question does not have to be answered
correctly for the design to hold. Check `workers/platform/limits` before adding any binding.

**Errors**

| Condition | Behaviour |
| --- | --- |
| Binding absent | `503` at boot, `/health` names `KMS_ACTIVE_VERSION`, never the value |
| Secret present but not 32 bytes after decode | `503`, one `console.error` of the *length only* |
| `get()` rejects (network/permissions) | `503`, retryable; **never** fall back to an unwrapped default |
| Production-shaped secret found in a staging Worker | refuse to serve; alert `kek_environment_mismatch` |

**Security** — the KEK is the single point of total compromise for every tenant at once. It is
never logged, never returned by an endpoint, and its loss is detectable: a KEK swap makes every
`open()` fail, which is a loud, non-silent failure (F13), not a quiet data-loss event.

**Tests**
- `kek_is_never_written_to_d1` (scan every column, every table)
- `kek_is_absent_from_logs_and_queue_messages`
- `worker_refuses_to_serve_with_a_foreign_environment_kek`
- `kek_binding_missing_returns_503_with_the_name_only`
- `local_dev_documented_path_does_not_use_remote_secrets`

**Deps** — F03, F04.

---

## F35 — Tenant-scoped key derivation

**Priority** P0 · **Status** not started · **Fixes** part of D6

**Story** As a security engineer, I want keys separated by tenant *and* by purpose, so that
defeating one column type's key does not silently open another.

**Acceptance**
- [ ] `TK = HKDF-SHA-256(ikm = KEK, salt = connection.key_salt, info = purpose ‖ org_id ‖
      "lumi-noti/tk/v1")`, 256 bits, via `crypto.subtle.deriveBits` on an imported HKDF base key.
      Workers lists HKDF as supported for `deriveBits`/`deriveKey`/`importKey` (same Web Crypto
      source, read 2026-10-13).
- [ ] `key_salt` is 16 bytes from `crypto.getRandomValues`, stored **in the clear** next to the
      ciphertext. It is a salt, not a secret; hiding it buys nothing.
- [ ] `info` includes the purpose string, so `destination.url`, `source.signing_secret` and
      `dek` derive three unrelated keys from the same `(KEK, salt)` pair.
- [ ] Derived keys are `extractable: false`. Nothing in the codebase exports them.
- [ ] Derivation is **deterministic** given `(KEK, salt, info)` — required, because the DEK must
      be rewrapable during rotation without a second secret (F37).
- [ ] `org_id` enters `info` **and** the AAD (F36). Key separation and row binding are
      independent controls; neither is described as doing the other's job.

**Design** — Say plainly what per-tenant derivation does **not** buy: it does **not** limit the
blast radius of a stolen KEK, because the attacker holds the KEK and can re-derive every tenant
key. Claiming otherwise would be the kind of security theatre `00` exists to remove. What it
does buy, and all three are real:

1. **Purpose separation.** A bug that leaks `TK(purpose=destination)` does not decrypt
   `signing_secret`, and the AAD-independent key separation still holds.
2. **Cheap single-tenant erasure.** Because the DEK is *wrapped* under `TK(org)`, deleting the
   wrapped DEK erases one connection (F40) without rotating a key that serves every other tenant.
3. **No cross-tenant key reuse.** Two tenants never share a key object, so a fault that
   mis-routes a decrypt cannot silently decrypt another tenant's row.

Why HKDF and not PBKDF2: PBKDF2 exists to stretch *low-entropy* secrets (passwords). The KEK is
32 bytes of CSPRNG output; stretching it only costs iterations. HKDF (RFC 5869) is the correct
PRF-based construction for deriving subkeys from high-entropy input and is natively available in
the runtime, with no dependency and no work-factor parameter to get wrong later.

**Schema**

```sql
-- F35 (illustrative; applied as expand → backfill → contract per F05, never by editing 0001)
ALTER TABLE integrations ADD COLUMN key_salt BLOB;              -- nullable during expand
ALTER TABLE integrations ADD COLUMN dek_wrapped BLOB;           -- set on first seal
ALTER TABLE integrations ADD COLUMN kek_version INTEGER;        -- set on first seal
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| `key_salt` NULL on a row that has ciphertext | `config_invalid`, permanent; quarantine the row, alert |
| `deriveBits` rejects (bad base key) | `config_invalid`; a wrong KEK, not a transient fault |
| Salt length ≠ 16 bytes | `malformed_envelope`, permanent, alert |
| `org_id` missing from `info` | programming error; a unit test asserts the exact `info` bytes |

**Security** — the `info` string is not a secret and may appear in a debug log, but by house rule
it does not (F12 puts `key` on the denylist). Log `SHA-256(info)` if a derivation bug ever needs
to be correlated.

**Tests**
- `same_kek_salt_and_info_derive_the_same_tenant_key`
- `different_purposes_derive_different_keys`
- `derived_key_is_not_exportable`
- `org_id_is_present_in_both_hkdf_info_and_aad`
- `hkdf_matches_golden_vectors` (RFC 5869 test cases 1–3)

**Deps** — F33, F34.

---

## F36 — AAD binding of ciphertext to its row

**Priority** P0 · **Status** not started · **Fixes** D6 (the security half of D6)

**Story** As a security reviewer, I want a ciphertext to be useless anywhere but its own row, so
that a database write primitive — not a cryptographic break — is required to send a notification
somewhere it was not configured to go.

**Acceptance**
- [ ] One pure function builds the AAD; `seal` and `open` both call it. There is no second
      construction site, and no call site may pass a hand-built `BufferSource`.
- [ ] Canonical form, all components server-generated, `0x00`-separated (same rule and same reason
      as F170 — do not re-derive it):

```
aad = "lumi-noti/aad/v1" 0x00 orgId 0x00 connectionId 0x00 field 0x00 purpose
```

- [ ] `field` is one of `url | signing_secret | dek`. `purpose` is `destination | source.signing`.
      Including both means the same connection's URL and signing secret are not interchangeable.
- [ ] Swapping `webhook_ciphertext` between two `integrations` rows **fails the tag check** and
      raises `destination_credentials_invalid`; the plaintext is never produced.
- [ ] AAD is not logged. If correlation is needed, log its SHA-256.
- [ ] The builder is unit-tested against golden vectors so a future refactor cannot silently
      change the bytes and orphan every stored value.

**Design** — AES-GCM authenticates whatever additional data it is given; that data is
authenticated but not encrypted, which is exactly what is wanted — the AAD is metadata that is
already known to both ends. Without it, D6's failure mode is live: `integrations` rows are
selected by a query, updated by a job, and migrated by hand; the storage format carries nothing
that ties a ciphertext to the row it came from, so any of those paths can cross the wires.

The AAD deliberately contains **no** field value, no URL and no org-supplied string. Every
component is an identifier we minted, so there is no injection surface and no normalisation
ambiguity between "what we stored" and "what we recompute at read time".

**Errors**

| Condition | Behaviour |
| --- | --- |
| Tag mismatch caused by AAD difference | `destination_credentials_invalid`, permanent, alert `aad_mismatch` |
| Tag mismatch caused by wrong KEK | indistinguishable at the primitive; classify identically and alert both |
| `connectionId` unknown at read time | caller bug — repository functions take the id as an argument (F26) |

**Security** — the failure mode of this control is a *loud* one: a mis-migrated row stops
delivering. That is the correct trade. Silent decryption of a crossed wire is the failure mode we
are eliminating.

**Tests**
- `ciphertext_is_bound_to_its_row_via_aad`
- `aad_includes_org_id_connection_id_field_and_purpose`
- `aad_uses_zero_separators_so_no_component_can_collide`
- `aad_builder_matches_golden_vectors`
- `url_and_signing_secret_ciphertexts_are_not_interchangeable`
- `aad_is_never_present_in_logs`

**Deps** — F33, F35. **Referenced by** F97 (`07`).

---

## F37 — Key version and rotation, including the D6 migration

**Priority** P0 · **Status** not started · **Fixes** D6 (rotation half) · **Fixes** D1 (the
key-name half of it)

**Story** As an operator, I want to change keys while the service is running, so that a key
compromise is an incident with a timeline rather than a rewrite.

**Acceptance**

| Layer | What rotates | Cost | Rewrites field ciphertexts? |
| --- | --- | --- | --- |
| KEK | The account key in Secrets Store | rewrap every `dek_wrapped` | **No** |
| DEK | One connection's data key | re-encrypt that connection's fields | Yes, for one connection |
| Credential | The user's secret | on credential change only | Yes, for one connection |

- [ ] Every sealed value carries `kek_version`; `KMS_ACTIVE_VERSION` names the current one.
- [ ] `open()` resolves the key by the envelope's version, tries **only** that version, and never
      falls back silently to another.
- [ ] Rotation procedure: add the new KEK → deploy with `KMS_ACTIVE_VERSION` unchanged → flip the
      active version → run the rewrap job → verify zero rows on the old version → **destroy** the
      old KEK. Rehearsed in staging with a rollback at every step (AGENTS.md release rule).
- [ ] The rewrap job is chunked, resumable, bounded inside the cron CPU budget (`01`), and alerts
      on staleness like every other job (F190).
- [ ] **Migration of today's data.** Existing rows are v0: base64 `TEXT`, `iv‖ciphertext` under
      `ENCRYPTION_KEY`, no AAD, no version. Migration:
  1. Detect by envelope parse failure — a v0 value never begins with `0x01 0x00`, so detection is
     structural and cannot misfire.
  2. Decrypt with the **v0** key read under the **current** env name (`ENCRYPTION_KEY`, the name
     `src/index.ts` actually reads — not `ENCRYPTION_KEY_BASE64`, which is what
     `.dev.vars.example` declares; that mismatch is D1 and is why the migration asserts the
     encoding it expects).
  3. Re-seal under v1 with AAD and write `kek_version`, `key_salt`, `dek_wrapped` **in the same
     statement**, so a crash leaves either a v0 row or a v1 row and never a half row.
  4. Chunked, resumable, with row counts compared before and after; a mismatch aborts.
  5. Quarantine and alert on any row that fails to decrypt. **Never `continue`** — the current
     `try { JSON.parse(row.event_types) } catch { continue; }` (D12) is the pattern that turns a
     corrupt row into a silently skipped integration forever, and it must not be copied here.
- [ ] Until the rewrap job reports zero remaining rows, the v0 path stays readable. Code that
      removes the v0 reader before the job finishes is a release blocker.
- [ ] Destroying a key version is an audited, irreversible action and requires an explicit
      confirmation that the rewrap job is at zero for that version.

**Schema**

```sql
-- Additive only; applied as expand → backfill → contract per F05, never by editing 0001.
-- key_salt and dek_wrapped are introduced by F35; this feature adds the version columns
-- that make rotation incremental.
ALTER TABLE integrations ADD COLUMN kek_version INTEGER;   -- NULL until the row is migrated
ALTER TABLE integrations ADD COLUMN aad_version INTEGER;   -- 1; 0/absent means the v0 format

-- The rewrap job's worklist. "rows still on an old kek_version" is a query, not a guess.
CREATE INDEX IF NOT EXISTS integrations_kek_version ON integrations(kek_version);
```

**Design** — Versioning the *envelope* rather than the key is what makes rotation incremental:
a reader can tell v0 from v1 by looking at the bytes, with no schema flag to get out of sync, and
a rollback to a previous Worker version is a deployment, not a data restore. The key version lives
**inside** the envelope (4 bytes) *and* in the row (`kek_version`, for querying "what still needs
rewrapping"); the inner copy is authoritative for decryption, the outer one is authoritative for
the rewrap job, and a disagreement is an alert rather than a silent choice.

Why rewrap rather than re-encrypt everything: the whole reason for the DEK layer (F33). A KEK
rotation on a 10,000-connection product moves ~320 KB of wrapped keys, not tens of megabytes of
field ciphertext, and does not need the delivery path to be free of writes while it runs.

**Errors**

| Condition | Behaviour |
| --- | --- |
| Envelope names a version that is not configured | `config_invalid`, permanent, alert `unknown_kek_version` |
| v0 decrypt fails during migration | quarantine row, alert, **do not** advance the job's success counter |
| Rewrap job fails on a chunk | retry the chunk; the job is idempotent |
| Old KEK destroyed with rows remaining | detected by the rewrap job's zero-check; incident |
| Re-encryption interrupted mid-row | v0 or v1, never both, never neither (single-statement write) |

**Security** — rotation is only meaningful if the old key is actually destroyed; "we rotated" with
the previous KEK still in Secrets Store is a claim, not a control. The zero-check plus the
destruction audit is what makes it evidence.

**Tests**
- `open_resolves_the_key_stated_by_the_envelope_version`
- `open_never_falls_back_to_another_key_version`
- `rotation_rewraps_deks_without_re_encrypting_field_values`
- `v0_rows_are_detected_structurally_not_by_a_flag`
- `migration_is_chunked_and_resumable`
- `migration_row_counts_must_match_before_and_after`
- `failed_v0_decrypt_quarantines_the_row_and_alerts`
- `migration_never_leaves_a_half_written_row`
- `destroying_a_key_version_is_blocked_while_rows_remain`

**Deps** — F33, F34, F35, F36, F05 (migration discipline).

---

## F38 — Signing-secret generation for generic webhook sources

**Priority** P1 · **Status** not started

**Story** As a customer with a non-GitHub source, I want a signing secret I can paste straight
into my provider's webhook settings, so that my events are verified, not trusted.

**Acceptance**
- [ ] Generation is Standard Webhooks **symmetric**: "Signing secret — Random. Between 24 bytes
      (192 bits) and 64 bytes (512 bits)"; "Secret serialization — base64 encoded, prefixed with
      `whsec_`"
      ([spec/standard-webhooks.md](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md),
      read 2026-10-13). We generate **32 bytes** — inside the documented range, CSPRNG-only.
- [ ] We verify exactly what the spec describes: HMAC-SHA256 over `msg_id.timestamp.payload`,
      headers `webhook-id`, `webhook-timestamp`, `webhook-signature`.
- [ ] Constant-time comparison uses Workers' non-standard `crypto.timingSafeEqual(a, b)`
      extension — confirmed present in the runtime docs, read 2026-10-13 — and never a
      hand-rolled accumulator.
- [ ] Signature verification runs against the **raw bytes**, before `JSON.parse`, with the header
      shape validated before any comparison. This is the pattern `00` §3 says to preserve.
- [ ] `webhook-timestamp` outside our tolerance (±5 min, our parameter — the spec only requires
      "some allowable tolerance") ⇒ rejected.
- [ ] `webhook-id` feeds the dedup key derivation in F170, including its `orgid`/`connectionid`
      components.
- [ ] **Two secrets can be active at once.** The spec's signature header "is a space delimited
      list of signatures … to support zero downtime secret rotation"; we try each and accept if any
      verifies. Rotation therefore needs no downtime and no coordination with the sender.
- [ ] The secret is sealed at rest with F36 AAD binding and **never** appears in a queue message
      (F173/D5), a log (F12 denylist already carries `secret`, `sign`, `signature`), an error
      message, a test-delivery preview (F181/F98) or an export (F30).

**Design** — Adopting an existing specification rather than inventing a fourth signature dialect
is the whole point: a customer's existing tooling can verify our sends, and the sender side
already knows the scheme.

**Two ways to hand the secret to the customer, with different risk:**

| Mode | URL carries | Customer must | Risk |
| --- | --- | --- | --- |
| A (default) | the secret, as a path segment | paste one URL | URL is a bearer credential: it leaks through referrers, proxies, browser history, screenshots, support tickets |
| B (preferred where the sender supports a separate secret field) | only `connection_id` | paste URL **and** secret | two fields to misconfigure; the secret still needs a home in our UI |

We ship A because a webhook sender that accepts only a URL is the common case and setup friction
is the product's main risk, and we make B available and recommended wherever the sender allows it.
Mode A therefore inherits every rule about webhook URLs in F12, plus one more: **an inbound
webhook URL for a generic source is itself a secret** and is treated like a destination
credential in every preview, export and log path. There is no code path that echoes it back.

**Errors**

| Condition | Behaviour |
| --- | --- |
| Missing / malformed `webhook-signature` | `signature_invalid`, permanent, `401` with no body detail (no oracle) |
| No signature in the list verifies | `signature_invalid`, permanent |
| `webhook-timestamp` outside tolerance | ⚠️ **taxonomy amendment to F13**: add `timestamp_out_of_tolerance`, non-retryable. "Stale" and "forged" are different facts and the customer's fix differs; do not overload `signature_invalid`. |
| `webhook-id` seen before | `replay_detected` (F170), suppressed and counted, not an error |
| Unknown `connection_id` | `401`, no detail. Never "route to all". |

**Security** — a signing secret generated from a non-CSPRNG source, or reused across
connections, is the failure the spec names directly: *"Signing keys should be unique per
endpoint for symmetric signatures … Reusing keys across customers can lead to security issues!"*
One secret per connection, no exceptions, and a test asserts uniqueness across the fixture set.

**Tests**
- `generated_signing_secret_is_whsec_prefixed_and_24_to_64_bytes`
- `generated_signing_secret_uses_a_cryptographic_rng`
- `signing_secrets_are_unique_per_connection`
- `signature_is_verified_over_raw_bytes_before_parsing`
- `signature_comparison_is_constant_time`
- `rotation_accepts_either_of_two_active_secrets`
- `stale_timestamp_is_rejected_with_its_own_code`
- `replayed_webhook_id_is_suppressed_not_duplicated`
- `inbound_webhook_url_never_appears_in_logs_or_previews`

**Deps** — F13 (taxonomy amendment), F36, F170, F173.

---

## F39 — Credential masking and one-time display

**Priority** P0 · **Status** not started

**Story** As a customer, I want to see that a credential is connected without being able to
re-read it, so that a leaked screenshot or support session cannot hand over my webhook.

**Acceptance**
- [ ] The plaintext of a signing secret or a destination URL is returned in **exactly one**
      response: the create call. No read endpoint ever returns it again, including for an
      administrator.
- [ ] That response is `Cache-Control: no-store` and is never written to `localStorage`,
      `sessionStorage`, the URL, or a client-side log. The UI shows a copy button and a
      "shown once" banner; leaving the page discards it.
- [ ] Every later read renders a **fingerprint**, not a mask of the secret:

```
credential_fingerprint = base32( SHA-256(secret) )[0:8]
```

      A fingerprint lets a customer match a secret in their provider's console without revealing
      anything. F12's rule — "A partial secret is still a secret" — is why we do not show the
      last four characters of the value.
- [ ] "Show me the secret again" is not an affordance. Recovery is **rotate**: generate a new
      secret, show it once, retire the old one (F40).
- [ ] Masked views, exports (F30) and dead-letter payloads (F181) all render the fingerprint.
- [ ] Rotation of a destination credential re-encrypts under the same DEK, updates
      `secret_rotated_at`, and is audited (F28).

**Design** — One-time display is the only honest answer to "the customer needs to copy this
string". Every alternative (a "reveal" button, an emailed secret, a rotation-free read endpoint)
creates a second retrieval channel with a weaker control. For our destinations the value is a
webhook URL that is itself a bearer credential, so the read path is where the risk is — which is
why it is simply absent rather than gated.

**Schema**

```sql
ALTER TABLE integrations ADD COLUMN credential_fingerprint TEXT;   -- 8 chars, base32
ALTER TABLE integrations ADD COLUMN secret_rotated_at INTEGER;     -- epoch seconds
ALTER TABLE integrations ADD COLUMN secret_last_shown_at INTEGER;  -- for the UI copy, not for access control
```

**Errors**

| Condition | Behaviour |
| --- | --- |
| Request to re-read a secret | `config_invalid` with "rotate the credential instead" — not a 404, which would be confusing |
| Row has ciphertext but no fingerprint | `config_invalid`, permanent; quarantine (migration artifact) |
| Fingerprint mismatch on write | programming error; a unit test asserts the derivation |

**Security** — `secret_last_shown_at` is display state and is never consulted for authorization.
Any reviewer who sees it used as an access check should reject the change.

**Tests**
- `secret_is_returned_exactly_once_and_never_on_read`
- `create_response_is_cache_control_no_store`
- `masked_credential_shows_only_a_hash_prefix`
- `fingerprint_matches_the_generated_secret_and_nothing_else`
- `regenerating_requires_rotation_not_readback`
- `export_and_dead_letter_views_never_contain_plaintext_secrets`

**Deps** — F12, F28, F36.

---

## F40 — Revocation and cryptographic deletion

**Priority** P0 · **Status** not started

**Story** As a customer, I want to disconnect a destination and know it is unusable, so that a
credential I no longer trust stops being a credential.

**Acceptance**
- [ ] Revoke is per connection, immediate, audited (F28), and stops routing: the consumer checks
      state before it sends (F175's claim already requires reading the row, F173 sends ids only).
- [ ] A revoked connection's queued messages fail closed — `destination_revoked`, permanent, no
      retry, no decrypt. In-flight messages cannot deliver to a destination revoked after
      enqueue.
- [ ] **Cryptographic erasure.** Destroying the connection's DEK (deleting `dek_wrapped`) leaves
      every field ciphertext for that connection unrecoverable *even if the KEK later leaks*.
      This is the only deletion claim we can make honestly about data we cannot physically erase
      (see F237 for the D1 Time Travel caveat).
- [ ] The order is fixed and irreversible: revoke → drain in-flight (bounded wait) → destroy DEK
      → purge ciphertext columns → audit `key_destroyed`. Destroying the DEK first would strand
      rows we still need to purge; purging first would leave a window where the DEK still exists.
- [ ] Workspace deletion (F30, blocked by N3) composes with this: destroy every connection's DEK,
      then delete rows. DEK destruction is what makes a soft-then-hard purge meaningful.
- [ ] Key destruction records actor, reason, connection, kek_version and timestamp, and is
      irreversible — a second attempt at the same DEK is a no-op, not an error.
- [ ] Rotation of a user credential (F39) reuses this path with a new DEK, so a "rotation" is
      never a copy of the old value into a new column.

**Design** — Two distinct guarantees, often conflated: *revocation* is a control-plane decision
(stop using this credential now) and *erasure* is a cryptographic fact (nobody can read this
again, including us). Revocation alone leaves the secret decryptable in our database, which is
not what "delete my webhook" means to a customer whose endpoint may already be compromised.
Erasure alone leaves deliveries queued for a destination the customer removed. Both are required
and neither implies the other.

**Errors**

| Condition | Behaviour |
| --- | --- |
| Delivery against a revoked destination | `destination_revoked`, permanent, dead-letter |
| `dek_wrapped` missing but ciphertext present | `config_invalid`, permanent, alert `orphaned_ciphertext` |
| Destroy requested while deliveries are in flight | refused with a count; operator retries after the drain window |
| Destroy attempted twice | no-op, second attempt audited |

**Security** — after erasure, ciphertext rows are deliberately left in place (they are
unreadable) only until the purge step runs; we do not promise deletion faster than the retention
job, and we do not pretend a `DELETE` removes something from a backup (F237).

**Tests**
- `revoked_destination_never_receives_a_delivery`
- `destroying_the_dek_makes_all_its_ciphertexts_unreadable`
- `erasure_holds_even_with_the_kek_present`
- `destroy_is_blocked_while_deliveries_are_in_flight`
- `credential_rotation_never_copies_the_old_value`
- `workspace_deletion_destroys_every_connection_dek`

**Deps** — F28, F36, F37, F173, F175.

---

## Boundaries this file does not cross

- **Logging and redaction** are F11/F12. This file produces the values they must redact; it does
  not define the denylist, the sampling policy or the log shape.
- **Error codes** are F13. Every failure here is expressed in its enum, and the one addition
  proposed (`timestamp_out_of_tolerance`, F38) is marked as an amendment to F13 rather than a
  local invention.
- **Queue message contents** are F173. The rule that a sealed value never enters a queue body is
  applied here; the queue schema is not redefined.
- **Tenant isolation** is F25/F26. This file binds ciphertext to a row; it does not decide how
  that row is scoped.
- **Credential UX** is F96/F97/F98 in `07`. This file is the cryptography they depend on.