#!/usr/bin/env node
/**
 * Operator path for a REVOKED connection whose secret the Worker will not wipe by itself (ADR 0036).
 *
 * The sweep destroys a revoked secret only once a non-secret fingerprint exists, and computing one needs the
 * secret to be openable. A row sealed before fingerprints existed under a key that is gone, with a corrupt
 * envelope, or with no `ENCRYPTION_KEY`, never gets one, so it is never wiped (`/api/observability/readiness`
 * shows `revoked_secrets_not_wiped`). This script wipes exactly that: one connection, by id AND workspace,
 * that is ALREADY revoked, and writes the `key_destroyed` audit event in the same statement group with
 * `trigger: 'operator'` and `reason: 'destroyed_without_fingerprint'`.
 *
 *   node scripts/force-destroy-revoked.mjs --integration <id> --organization <orgId> --actor <login>
 *        [--database <name>] [--remote] [--apply]
 *   node scripts/force-destroy-revoked.mjs --source <id> --organization <orgId> --actor <login> ...
 *
 * Without `--apply` it prints the statements and changes nothing. It refuses a row that is not revoked (the
 * predicate is in the SQL, so a wrong id changes nothing), and an integration with a delivery claim younger
 * than the claim lease (the drain; wait and rerun). It also wipes the kept `integrations_old` copy of migration 0026 when
 * that table exists. Irreversible; the burned value cannot afterwards be recognised if pasted again.
 *
 * UNVERIFIED: `wrangler d1 execute --command` with several statements is assumed to run them in order; each
 * statement is idempotent and guarded by the same predicate, so a partial run is repaired by running again.
 */
import { spawnSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const CLAIM_LEASE_MS = 5 * 60_000;
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ACTOR = /^[A-Za-z0-9@._-]{1,80}$/;

/**
 * @param {string} value
 * @param {string} what
 */
function assertName(value, what) {
  if (typeof value !== 'string' || !NAME.test(value))
    throw new Error(`${what} must match [A-Za-z0-9_-]{1,64}`);
  return value;
}

/**
 * @param {string} value
 * @param {string} what
 */
function assertActor(value, what) {
  if (typeof value !== 'string' || !ACTOR.test(value))
    throw new Error(`${what} must match [A-Za-z0-9@._-]{1,80}`);
  return value;
}

const INTEGRATION_HOLDS = `(dek_wrapped IS NOT NULL OR key_salt IS NOT NULL OR webhook_envelope IS NOT NULL
       OR lark_secret_envelope IS NOT NULL OR webhook_ciphertext <> '' OR lark_secret_ciphertext IS NOT NULL)`;

/**
 * The statements, in order. Every value interpolated is validated here against a closed pattern.
 * @param {{ kind: 'integration' | 'source', id: string, organizationId: string, actor: string, nowMs?: number, legacyOld?: boolean }} entry
 * @returns {string[]}
 */
export function forceDestroyStatements(entry) {
  const id = assertName(entry.id, 'id');
  const org = assertName(entry.organizationId, 'organization');
  const actor = assertActor(entry.actor, 'actor');
  const auditId = assertName(webcrypto.randomUUID(), 'audit id');
  if (entry.kind === 'integration') {
    const cutoff = Math.floor((entry.nowMs ?? Date.now()) - CLAIM_LEASE_MS);
    if (!Number.isInteger(cutoff)) throw new Error('bad clock');
    const where = `id = '${id}' AND organization_id = '${org}'
  AND credentials_quarantined_at IS NOT NULL AND credentials_quarantine_reason = 'revoked'
  AND ${INTEGRATION_HOLDS}
  AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.organization_id = '${org}' AND d.integration_id = '${id}'
                  AND d.state = 'claimed' AND d.claimed_at > ${cutoff})`;
    const statements = [
      `INSERT INTO audit_events(id,organization_id,actor_id,action,subject_type,subject_id,outcome,metadata_json)
SELECT '${auditId}', organization_id, '${actor}', 'integration.key_destroyed', 'integration', id, 'success',
  json_object('kekVersion', kek_version, 'trigger', 'operator', 'reason', 'destroyed_without_fingerprint', 'destinationHost', destination_host)
FROM integrations WHERE ${where}`,
      `UPDATE integrations
SET webhook_ciphertext = '', lark_secret_ciphertext = NULL, key_salt = NULL, dek_wrapped = NULL,
    kek_version = NULL, webhook_envelope = NULL, lark_secret_envelope = NULL, updated_at = CURRENT_TIMESTAMP
WHERE ${where}`,
    ];
    if (entry.legacyOld)
      statements.push(`UPDATE integrations_old
SET webhook_ciphertext = '', lark_secret_ciphertext = NULL, key_salt = NULL, dek_wrapped = NULL,
    kek_version = NULL, webhook_envelope = NULL, lark_secret_envelope = NULL
WHERE id = '${id}' AND organization_id = '${org}'
  AND EXISTS (SELECT 1 FROM integrations i WHERE i.id = '${id}' AND i.organization_id = '${org}'
              AND i.credentials_quarantined_at IS NOT NULL AND i.credentials_quarantine_reason = 'revoked'
              AND i.dek_wrapped IS NULL AND i.webhook_envelope IS NULL AND i.webhook_ciphertext = '')`);
    return statements;
  }
  const where = `id = '${id}' AND organization_id = '${org}' AND credentials_revoked_at IS NOT NULL
  AND credentials_revoked_at <= datetime('now', '-60 seconds')
  AND (length(dek_wrapped) > 0 OR length(key_salt) > 0 OR length(secret_envelope) > 0)`;
  return [
    `INSERT INTO audit_events(id,organization_id,actor_id,action,subject_type,subject_id,outcome,metadata_json)
SELECT '${auditId}', organization_id, '${actor}', 'source.key_destroyed', 'source', id, 'success',
  json_object('kekVersion', kek_version, 'trigger', 'operator', 'reason', 'destroyed_without_fingerprint', 'kind', kind)
FROM sources WHERE ${where}`,
    `UPDATE sources
SET secret_envelope = x'', key_salt = x'', dek_wrapped = x'', kek_version = 0, updated_at = CURRENT_TIMESTAMP
WHERE ${where}`,
  ];
}

/**
 * @param {string} sql
 * @param {{ database: string, remote: boolean }} target
 */
function wrangler(sql, target) {
  const args = ['--no-install', 'wrangler', 'd1', 'execute', target.database, '--json', '--command', sql];
  args.push(target.remote ? '--remote' : '--local');
  const result = spawnSync('npx', args, { encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error(`wrangler failed: ${result.stderr.trim().split('\n').pop() ?? ''}`);
  return JSON.parse(result.stdout)?.[0]?.results ?? [];
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a?.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
    else {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const kind =
    typeof args.integration === 'string' ? 'integration' : typeof args.source === 'string' ? 'source' : null;
  if (!kind || typeof args.organization !== 'string' || typeof args.actor !== 'string') {
    console.error(
      'usage: force-destroy-revoked.mjs (--integration <id> | --source <id>) --organization <orgId> --actor <login> [--database <name>] [--remote] [--apply]',
    );
    return 2;
  }
  const target = { database: String(args.database ?? 'lumi-noti'), remote: args.remote === true };
  const legacyOld =
    Number(
      wrangler(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'integrations_old'",
        target,
      )[0]?.n ?? 0,
    ) > 0;
  const statements = forceDestroyStatements({
    kind,
    id: String(args[kind]),
    organizationId: args.organization,
    actor: args.actor,
    legacyOld,
  });
  for (const s of statements) console.info(`  ${s.replace(/\s+/g, ' ').slice(0, 200)}`);
  if (args.apply !== true) {
    console.info(`\n${statements.length} statement(s) planned, nothing changed (add --apply)`);
    return 0;
  }
  const table = kind === 'integration' ? 'integrations' : 'sources';
  const before = Number(
    wrangler(`SELECT COUNT(*) AS n FROM audit_events WHERE action = '${kind}.key_destroyed'`, target)[0]?.n ??
      0,
  );
  for (const s of statements) wrangler(s, target);
  const after = Number(
    wrangler(`SELECT COUNT(*) AS n FROM audit_events WHERE action = '${kind}.key_destroyed'`, target)[0]?.n ??
      0,
  );
  if (after === before + 1) {
    console.info(`${table} secret destroyed and audited (destroyed_without_fingerprint).`);
    return 0;
  }
  console.error(
    'Nothing changed: the connection is not revoked, is not in that workspace, holds no secret, or a delivery claim is still live.',
  );
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(2);
    },
  );
}
