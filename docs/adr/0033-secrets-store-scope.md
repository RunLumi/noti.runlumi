# ADR 0033: Key custody: Worker secrets now, Secrets Store for wrapping keys only, ciphertext in D1

Status: Accepted · Date: 2026-10-15 · Records the scope decision behind F34 and AR-4. Complements
[ADR 0004](0004-envelope-encryption.md) and [ADR 0022](0022-credential-lifecycle-and-boot.md). **No code change, no migration.**

## Context

Destination secrets are sealed with per-row data keys (DEKs) wrapped by a key-encryption key (KEK). F34 asks that the KEK
live in a [Cloudflare Secrets Store](https://developers.cloudflare.com/secrets-store/) binding (account-level, in open beta when the spec was read), with a Worker secret as
the fallback. Today `wrangler.jsonc` has no `secrets_store_secrets` binding: KEKs are versioned Worker secrets
(`KEK_V<n>`, `src/crypto/keyring-env.ts`).

## Decision

1. **Scope.** A secrets manager, whichever one, holds **wrapping keys and platform secrets only** (KEKs, the Better Auth
   secret, the GitHub App secrets). It never holds per-tenant credentials. Per-tenant material is ciphertext in D1, wrapped
   per row, so deleting a row's wrapped DEK shreds it (ADR 0022).
2. **Tier.** Tier 2, Worker secrets, is what ships. Tier 1 (Secrets Store) is wanted but not adopted while it is beta
   (AR-4). The code reads a KEK through one interface (`keyring-env.ts`), so adoption is an adapter, not a rewrite.
3. **No tier below.** Never a key in D1, in a committed file, in a default value or in a log. A test scans every column,
   queue message and log line for the configured secrets (`tests/security/secrets-not-stored.test.ts`); boot refuses to
   serve without a valid KEK and refuses a KEK from another environment (ADR 0022).
4. **One KEK per environment**, unrelated values, with a check value so a mismatch fails closed.

## Why

- Per-tenant vaulting in a secrets product would make secret count scale with customers, against a binding model built
  for a handful of account-level values.
- D1 holding only ciphertext keeps the export, erasure and retention story in one place.
- Waiting for GA avoids building custody on a beta whose shape can change.

## Consequences

- Reading D1 alone does not decrypt anything; an operator with Worker secret access can. That is the residual in AR-4 and
  the first item in THREAT_MODEL section 6.
- Rotation is the versioned-KEK procedure in docs/IMPLEMENTATION.md; it has not been rehearsed.
- Adopting Secrets Store later changes where the KEK is read from, not the data format.

## Revisit when

- Secrets Store reaches GA (AR-4's trigger), or its binding limits and local-development behaviour are verified (spec 03 F34 lists
  these as UNVERIFIED).
- A customer requires customer-managed keys or a per-tenant key custody story.
- A KEK exposure incident.

## Sources

- [Secrets Store](https://developers.cloudflare.com/secrets-store/): "a secure, centralized location in which account-level
  secrets are stored", and the open-beta status. Read 2026-10-13, quoted in `docs/specs/03-secrets-and-crypto.md` and
  `docs/specs/01-platform-runtime.md`. The beta status is as of that read; re-verify before relying on it.
