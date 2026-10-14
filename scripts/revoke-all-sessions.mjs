#!/usr/bin/env node
/**
 * Ends EVERY session and every pending one-time link (docs/specs/15 F234 mitigation 6, docs/adr/0028,
 * docs/RUNBOOK.md "After a restore"). Run it after any D1 Time Travel restore or backup restore, and after
 * any suspected leak of the session table.
 *
 *   node scripts/revoke-all-sessions.mjs --database lumi-noti --remote --reason restore            # plan only
 *   node scripts/revoke-all-sessions.mjs --database lumi-noti --remote --reason restore --apply
 *
 * Why: Better Auth stores the session token as is (AR-1). A restore can bring back a row for a session the
 * person ended, or for one a password reset ended, and that row works again. Deleting every session after a
 * restore means nothing that came back can be used; everyone signs in again. The `verification` table (email
 * verification, password-reset and passkey-challenge records) is cleared too: a restored, already-used reset
 * link would otherwise be usable again until it expires.
 *
 * It writes one `session.revoke_all` audit event (no workspace, no actor, the count and the reason). Do it with
 * the site in maintenance mode (`MAINTENANCE_MODE`, docs/RUNBOOK.md), so no session is created between the count
 * and the delete. The count is read BEFORE the delete and the three statements are not one transaction, so under
 * traffic the recorded count can be stale; hence `--i-froze-writes`, which you pass to say writes ARE frozen. The delete comes first and the audit row second, so a failure between them leaves the safe
 * state (sessions gone) and a non-zero exit. `wrangler d1 execute --file` has never been run by this script
 * against a real D1 (UNVERIFIED, docs/RELEASE_GATES.md).
 */
import { wranglerExecutor } from './lib/migration-0026.mjs';

export const REASONS = ['restore', 'incident'];

/**
 * @param {{ query(sql: string): Promise<Record<string, unknown>[]>, run(statements: string[]): Promise<void> }} executor
 * @param {{ reason: string }} options
 * @returns {Promise<{ sessions: number, verifications: number, statements: string[] }>}
 */
export async function planRevokeAll(executor, { reason }) {
  if (!REASONS.includes(reason)) throw new Error(`reason must be one of ${REASONS.join(', ')}`);
  const count = async (table) => {
    const rows = await executor.query(`SELECT COUNT(*) AS n FROM ${table}`);
    const n = Number(rows[0]?.n);
    if (!Number.isInteger(n) || n < 0) throw new Error(`could not count ${table}`);
    return n;
  };
  const revoked = await count('"session"');
  const verifications = await count('verification');
  const metadata = JSON.stringify({ revoked, reason });
  return {
    sessions: revoked,
    verifications,
    statements: [
      'DELETE FROM "session"',
      'DELETE FROM verification',
      `INSERT INTO audit_events(id,organization_id,actor_id,action,subject_type,subject_id,outcome,metadata_json)
SELECT lower(hex(randomblob(16))),NULL,NULL,'session.revoke_all','session',NULL,'success','${metadata}'`,
    ],
  };
}

async function main() {
  const args = process.argv.slice(2);
  const at = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const database = at('--database');
  const reason = at('--reason');
  if (args.includes('--apply') && !args.includes('--i-froze-writes')) {
    console.error(
      'refusing to --apply without --i-froze-writes: put the Worker in maintenance mode first (docs/RUNBOOK.md)',
    );
    process.exit(2);
  }
  if (!database || !reason || (!args.includes('--remote') && !args.includes('--local'))) {
    console.error(
      `usage: node scripts/revoke-all-sessions.mjs --database <name> (--remote|--local) --reason <${REASONS.join('|')}> [--apply --i-froze-writes]`,
    );
    process.exit(2);
  }
  const executor = wranglerExecutor({ database, remote: args.includes('--remote') });
  const plan = await planRevokeAll(executor, { reason });
  console.log(`sessions to end: ${plan.sessions}; one-time records to clear: ${plan.verifications}`);
  if (!args.includes('--apply')) {
    console.log(
      'revoke-all: nothing changed (add --apply --i-froze-writes, with the site in maintenance mode)',
    );
    return;
  }
  await executor.run(plan.statements);
  console.log(`revoke-all: ended ${plan.sessions} session(s) and recorded session.revoke_all (${reason})`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
