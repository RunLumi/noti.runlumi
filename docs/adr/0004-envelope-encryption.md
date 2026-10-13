# ADR 0004: Envelope encryption for stored credentials

Status: Accepted · Date: 2026-10-13 · Implements F33–F37 (docs/specs/03-secrets-and-crypto.md) · Fixes D5, D6

## Context

Destination credentials were stored as `base64(iv‖ciphertext)` under one key, with no
additional authenticated data (AAD), no version and no rotation path (D6). A ciphertext
copied from one row to another decrypted cleanly and delivered to the wrong place. The same
ciphertext was also copied into every queue message (D5).

## Decision

1. **Three layers.** A versioned KEK, held as a Worker secret (`KEK_V<n>`), feeds HKDF-SHA-256
   with a 16-byte per-connection salt and `info = purpose ‖ 0x00 ‖ org ‖ 0x00 ‖ "lumi-noti/tk/v1"`.
   That gives a tenant key. The tenant key wraps a random 32-byte DEK per connection using
   AES-GCM with AAD. The DEK seals each credential field using AES-GCM with AAD.
2. **AAD binds every ciphertext to its row**:
   `"lumi-noti/aad/v1" 0x00 org 0x00 connection 0x00 field 0x00 purpose`. Every component is
   an id we minted, and a component containing NUL is rejected. A swapped ciphertext fails
   the tag check, so the consumer refuses it and never calls the provider.
3. **Versioned envelope** (`BLOB`): `0x01 | flags=0 | kek_version u32 BE | iv[12] | ct‖tag`.
   Parsing is strict.
4. **Where the KEK version lives.** The wrapped DEK's envelope carries the KEK version, and
   that copy is authoritative for unwrapping. Field envelopes always carry `0`, because they
   are sealed under the DEK, not a KEK. *Deviation from the spec text, which puts a KEK
   version in every envelope:* if the field envelopes carried it, every KEK rotation would
   leave them stale or force a rewrite. Rewriting only the DEK is the reason the DEK layer
   exists.
5. **Queue messages carry ids and display text only.** The consumer re-reads the integration
   with `WHERE id=? AND organization_id=?` and opens the credentials itself.
6. **Migration is structural, verified and reversible.** A row with no `webhook_envelope` is
   v0. Each cron tick re-seals up to 25 rows:
   - The new envelope is opened and compared with the plaintext before anything is written.
   - The guarded `UPDATE` matches on the v0 values that were read, so a concurrent edit is
     skipped, never overwritten with stale plaintext.
   - The v0 columns are **kept**, so rolling the Worker back still delivers. Clearing them is
     an operator-run contract step after the zero-check (`docs/IMPLEMENTATION.md`).
7. **Quarantine only for defects in a row's own bytes**, meaning `destination_credentials_invalid`
   or `malformed_envelope`. A wrong or missing key, an unknown KEK version or a platform error
   aborts the batch and fails the cron run visibly. A circuit breaker treats "every row in a
   multi-row batch failed" as a key fault: it aborts and quarantines nothing.
8. **Rotation rewraps DEKs only.** A row whose `kek_version IS NOT <active>` is rewrapped by an
   `UPDATE` guarded on `organization_id`, the version that was read and the exact wrapped bytes.
   `open` uses only the version the envelope names. There is no fallback.
9. **Key separation (deviation from F35's wording).** One HKDF tenant key per
   `(KEK, salt, org, purpose)` wraps only the DEK. Separation between fields comes from the
   per-connection DEK plus the `field` component of the AAD, not from separate HKDF keys. The
   property F35 asks for still holds: a URL ciphertext cannot be opened as a signing secret,
   and one connection's key cannot open another's.

## Consequences

- Errors carry taxonomy codes only (`malformed_envelope`, `destination_credentials_invalid`,
  `unknown_kek_version`, `config_invalid`).
- Consumer handling depends on the cause:
  - A row defect is permanent. The delivery is marked `failed` and acknowledged, and the
    provider is never called.
  - A key-configuration fault (`unknown_kek_version`, an invalid key ring) is retried, so
    fixing the deploy delivers instead of losing the message.
- Every consumer write is scoped by `id AND organization_id AND integration_id`. A redelivered
  message whose delivery is already `sent` is acknowledged without a second provider call.
  This narrows the duplicate window but does not close it.
- Migration 0007 strips legacy ciphertext from every outbox row, including dispatched ones.
  Retiring the legacy key therefore retires every copy of the ciphertext it can open.
- Job counts (`migrated`, `rewrapped`, `remaining`) are logged on every tick. They contain no
  values.
- `last_error` only ever holds codes we minted. Platform errors from `fetch` or `URL` can echo
  the destination URL, so they collapse to `transient_error`.
- `/health` returns `503` naming the misconfigured binding when the key ring is invalid.

## Not done (tracked in docs/PROGRESS.md)

- **Secrets Store binding (F34 tier 1).** Today the KEK is a Worker secret, which is tier 2.
  The key ring has one interface, so adding a Secrets Store adapter does not touch callers.
- **Environment-mismatch detection** (`kek_environment_mismatch`).
- **Audited key destruction** (F37), and **crypto-shredding on connection delete** (F40).
- Rows with no `organization_id` cannot be migrated, because the AAD needs a tenant. They
  are already unroutable and wait for the tenancy backfill in slice 3.
