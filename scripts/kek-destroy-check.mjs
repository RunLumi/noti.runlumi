#!/usr/bin/env node
/**
 * KEK operator tooling (docs/specs/03-secrets-and-crypto.md F34, F37; docs/RUNBOOK.md).
 *
 *   check-value  --environment <production|staging|development> [--kek-env KEK_HEX]
 *       Print the key check value to store in KEK_CHECK_V<n>. The KEK is read from the process
 *       environment variable named by --kek-env (default KEK_HEX), NEVER from an argument, so it
 *       does not land in shell history or `ps`.
 *   destroy-check --version <n> [--active <n>] [--database <name>] [--remote]
 *       Refuse (exit 1) while any integration or source row is still wrapped under KEK version <n>.
 *       Exit 0 means: zero rows, safe to destroy.
 *   record-destruction --version <n> --active <n> --actor <who> --reason <retired|compromised|other>
 *                      [--database <name>] [--remote]
 *       Run the check AND write one `key.destroy` audit event in a single SQL statement, so the
 *       event exists only if no row remained at that instant. Run it immediately before deleting
 *       the secret. Exit 1 if rows remain or the event was not written. The event records that
 *       destruction was AUTHORISED at that instant; deleting the secret is a separate manual step the
 *       script cannot perform or verify. `--active` is KMS_ACTIVE_VERSION as DEPLOYED: read it from the
 *       deployed configuration, do not guess. The script cannot read it and refuses only a version
 *       equal to the value you pass.
 *
 * The pure functions are exported for tests/security/kek-destroy-check.test.ts, which runs the
 * SQL against the real migrations.
 */
import { spawnSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const KEK_CHECK_LABEL = 'lumi-noti/kcv/v2:';
export const KEK_CHECK_HEX_CHARS = 32;
export const ENVIRONMENTS = ['production', 'staging', 'development'];
export const DESTROY_REASONS = ['retired', 'compromised', 'other'];

/**
 * Same construction as `kekCheckValue` in src/crypto/fingerprint.ts (a test asserts they agree).
 * @param {string} kekHex 64 hex characters
 * @param {string} environment
 */
export async function checkValue(kekHex, environment) {
  if (!/^[0-9a-f]{64}$/i.test(kekHex)) throw new Error('KEK must be 64 hex characters');
  if (!ENVIRONMENTS.includes(environment))
    throw new Error(`environment must be one of ${ENVIRONMENTS.join(', ')}`);
  const raw = Uint8Array.from(kekHex.match(/../g) ?? [], (h) => parseInt(h, 16));
  // HKDF-SHA-256(ikm = KEK, salt = empty, info = label + environment): the KEK is never a MAC key.
  const base = await webcrypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits']);
  const bits = await webcrypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(KEK_CHECK_LABEL + environment),
    },
    base,
    KEK_CHECK_HEX_CHARS * 4,
  );
  return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** @param {unknown} v */
function assertVersion(v) {
  if (!Number.isInteger(v) || /** @type {number} */ (v) < 1 || /** @type {number} */ (v) > 1000)
    throw new Error('version must be a small positive integer');
  return /** @type {number} */ (v);
}

/**
 * A row depends on a KEK version if its `kek_version` column says so OR the version stored inside
 * the wrapped-key envelope (bytes 3..6, big endian; the envelope is authoritative, F37) does. A
 * disagreement between the two is itself a finding, so either one blocks destruction.
 * @param {string} table
 * @param {number} version
 */
function dependents(table, version) {
  const hex = version.toString(16).toUpperCase().padStart(8, '0');
  return `(SELECT COUNT(*) FROM ${table} WHERE kek_version = ${version}
            OR (dek_wrapped IS NOT NULL AND hex(substr(dek_wrapped, 3, 4)) = '${hex}'))`;
}

/**
 * Counts of rows still wrapped under `version`, per table. Read-only; the version is validated as
 * an integer, so nothing user-controlled is interpolated.
 * @param {number} version
 */
export function destroyCheckSql(version) {
  const v = assertVersion(version);
  return `SELECT ${dependents('integrations', v)} AS integrations, ${dependents('sources', v)} AS sources`;
}

/**
 * @param {{ integrations?: number | null, sources?: number | null } | undefined} row
 * @returns {{ safe: boolean, integrations: number, sources: number }}
 */
export function evaluateDestroyCheck(row) {
  const integrations = Number(row?.integrations ?? Number.NaN);
  const sources = Number(row?.sources ?? Number.NaN);
  // An unreadable answer is never "safe".
  if (!Number.isFinite(integrations) || !Number.isFinite(sources))
    return { safe: false, integrations: Number.NaN, sources: Number.NaN };
  return { safe: integrations === 0 && sources === 0, integrations, sources };
}

/**
 * One statement that checks and records together: the audit row is inserted only if no integration
 * or source row depends on `version` at that instant. A destroyed-version event carries no
 * workspace (`organization_id` NULL): it is a platform event, never shown in a workspace's log.
 * Everything interpolated is validated here: an integer, an allow-listed reason, a restricted actor.
 * @param {{ version: number, active: number, actor: string, reason: string, id?: string }} entry
 */
export function destroyAuditSql(entry) {
  const version = assertVersion(entry.version);
  const active = assertVersion(entry.active);
  if (version === active) throw new Error('refusing to destroy the ACTIVE KEK version');
  if (!DESTROY_REASONS.includes(entry.reason))
    throw new Error(`reason must be one of ${DESTROY_REASONS.join(', ')}`);
  if (!/^[A-Za-z0-9@._-]{1,80}$/.test(entry.actor)) throw new Error('actor must match [A-Za-z0-9@._-]{1,80}');
  const id = entry.id ?? webcrypto.randomUUID();
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('bad id');
  const metadata = JSON.stringify({ kekVersion: version, reason: entry.reason, activeVersion: active });
  return `INSERT INTO audit_events(id,organization_id,actor_id,action,subject_type,subject_id,outcome,metadata_json)
SELECT '${id}',NULL,'${entry.actor}','key.destroy','key','kek_v${version}','success','${metadata}'
WHERE ${dependents('integrations', version)} = 0 AND ${dependents('sources', version)} = 0`;
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
  const parsed = JSON.parse(result.stdout);
  return parsed?.[0]?.results ?? [];
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
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const target = { database: String(args.database ?? 'lumi-noti'), remote: args.remote === true };
  if (command === 'check-value') {
    const kek = process.env[String(args['kek-env'] ?? 'KEK_HEX')] ?? '';
    console.info(await checkValue(kek, String(args.environment ?? '')));
    return 0;
  }
  if (command === 'destroy-check') {
    const version = assertVersion(Number(args.version));
    if (args.active !== undefined && Number(args.active) === version) {
      console.error(`KEK v${version} is the active version: refusing.`);
      return 1;
    }
    const verdict = evaluateDestroyCheck(wrangler(destroyCheckSql(version), target)[0]);
    console.info(JSON.stringify({ version, ...verdict }));
    if (!verdict.safe)
      console.error(`Refusing: rows remain wrapped under KEK v${version}. Run the rewrap job to zero first.`);
    return verdict.safe ? 0 : 1;
  }
  if (command === 'record-destruction') {
    const sql = destroyAuditSql({
      version: Number(args.version),
      active: Number(args.active),
      actor: String(args.actor ?? ''),
      reason: String(args.reason ?? ''),
    });
    const before = wrangler("SELECT COUNT(*) AS n FROM audit_events WHERE action='key.destroy'", target)[0]
      ?.n;
    wrangler(sql, target);
    const after = wrangler("SELECT COUNT(*) AS n FROM audit_events WHERE action='key.destroy'", target)[0]?.n;
    if (Number(after) === Number(before) + 1) {
      console.info(
        'key.destroy audit event written (destruction authorised). Now delete the KEK secret yourself.',
      );
      return 0;
    }
    console.error('Not recorded: rows remain wrapped under that KEK version.');
    return 1;
  }
  console.error(
    'usage: kek-destroy-check.mjs check-value|destroy-check|record-destruction (see file header)',
  );
  return 2;
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
