#!/usr/bin/env node
/**
 * Dependency audit gate (docs/specs/15-security-and-compliance.md F239).
 *
 * `npm audit --omit=dev --audit-level=high` is the policy. This wrapper applies the same
 * policy but lets a small, dated, reasoned exception list through (currently empty), so a known advisory in
 * a package that never reaches the Worker bundle does not train everyone to ignore a red
 * CI. Anything not listed, or listed past its expiry, still fails the build.
 *
 * Exceptions live HERE, in reviewable code, and are mirrored in docs/SECURITY.md.
 * Adding one is a PR with a reason and an expiry (<= 90 days out).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** @type {ReadonlyArray<{ id: string, expires: string, reason: string }>} */
export const EXCEPTIONS = [];

const FAIL_LEVELS = new Set(['high', 'critical']);

/**
 * @param {{ vulnerabilities?: Record<string, { name: string, via: unknown[] }> }} report parsed `npm audit --json`
 * @param {ReadonlyArray<{ id: string, expires: string }>} exceptions
 * @param {Date} now
 * @returns {{ failures: string[], excepted: string[] }}
 */
export function evaluateAudit(report, exceptions = EXCEPTIONS, now = new Date()) {
  const allowed = new Map(exceptions.map((e) => [e.id, e]));
  const failures = [];
  const excepted = [];
  const seen = new Set();
  for (const vuln of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vuln.via) {
      // String entries are transitive pointers to another package's advisory.
      if (typeof via !== 'object' || via === null) continue;
      const adv = /** @type {{ url?: string, title?: string, severity?: string, name?: string }} */ (via);
      if (!FAIL_LEVELS.has(adv.severity ?? '')) continue;
      const id =
        String(adv.url ?? '')
          .split('/')
          .pop() || String(adv.title);
      if (seen.has(id)) continue;
      seen.add(id);
      const label = `${id} (${adv.severity}) ${adv.name}: ${adv.title}`;
      const exception = allowed.get(id);
      if (exception && new Date(`${exception.expires}T23:59:59Z`) >= now) excepted.push(label);
      else failures.push(exception ? `${label} [exception expired ${exception.expires}]` : label);
    }
  }
  return { failures, excepted };
}

function runAudit() {
  // The registry can hiccup; retry so a transient network error is not a red build.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    try {
      const report = JSON.parse(res.stdout);
      if (report && typeof report === 'object' && !('error' in report)) return report;
    } catch {
      /* fall through to retry */
    }
    console.error(`npm audit produced no usable report (attempt ${attempt}/3)`);
  }
  throw new Error('npm audit failed to produce a report after 3 attempts');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { failures, excepted } = evaluateAudit(runAudit());
  for (const line of excepted) console.warn(`audit exception (see docs/SECURITY.md): ${line}`);
  if (failures.length > 0) {
    console.error('High or critical advisories without a valid exception:');
    for (const line of failures) console.error(`  - ${line}`);
    process.exit(1);
  }
  console.log('audit gate passed: no unexcepted high or critical advisories in production dependencies');
}
