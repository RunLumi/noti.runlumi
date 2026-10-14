#!/usr/bin/env node
/**
 * Evaluates the output of scripts/migration-0026-preflight.sql (docs/adr/0021, docs/RUNBOOK.md).
 *
 *   wrangler d1 execute lumi-noti --remote --json --file scripts/migration-0026-preflight.sql > preflight.json
 *   node scripts/migration-0026-preflight.mjs preflight.json [--ack-orphans <exact count>]
 *
 * Exit 0 means "nothing here blocks applying"; it is not a promise the migration will succeed
 * (it has never run on a real D1). Exit 1 lists every blocker.
 *
 * Blocks unless acknowledged:  any row the migration will quarantine (orphans, including ids that
 *   differ only by case or point at a deleted organization). Their credentials and payloads leave
 *   the live tables and are recoverable only through Time Travel, so the operator must have read
 *   the list and pass the exact total as --ack-orphans.
 * Always blocks:               a table above the size ceiling (one statement per table; D1 documents
 *   a 30 second limit per query). Purge deliveries by retention first, or backfill by hand in chunks.
 * Reported for review:         cross-tenant anomalies the migration keeps.
 */
import { readFileSync } from 'node:fs';

/** Rows per table above which a single INSERT ... SELECT is not trusted to finish in 30 seconds. */
export const ROW_CEILING = 100_000;

/** @param {unknown} raw wrangler's `--json` output, or an array of { check, n } rows */
export function rowsOf(raw) {
  const batches = Array.isArray(raw) ? raw : [];
  const flat = batches.flatMap((b) => (b && typeof b === 'object' && 'results' in b ? b.results : [b]));
  return flat
    .filter((r) => r && typeof r.check === 'string')
    .map((r) => ({ check: r.check, n: Number(r.n) }));
}

/**
 * @param {{ check: string, n: number }[]} rows
 * @param {{ ackOrphans?: number | null }} [options]
 */
export function evaluate(rows, options = {}) {
  const byPrefix = (prefix) => rows.filter((r) => r.check.startsWith(prefix));
  const orphans = byPrefix('orphan:');
  const orphanTotal = orphans.reduce((sum, r) => sum + r.n, 0);
  const blockers = [];
  const review = [];
  if (rows.length === 0)
    blockers.push('no preflight rows were read: the file is empty or not wrangler --json output');
  for (const r of byPrefix('blocker:')) {
    if (r.n > 0)
      blockers.push(
        r.check === 'blocker:foreign_keys_off'
          ? 'PRAGMA foreign_keys is not 1 on this connection; migration 0026 trips on it'
          : `${r.n} <table>_old table(s) already exist: finalize (scripts/migration-0026-finalize.mjs) or restore (scripts/migration-0026-recover.mjs) first`,
      );
  }
  for (const r of byPrefix('total:')) {
    if (r.n > ROW_CEILING)
      blockers.push(
        `${r.check.slice(6)} has ${r.n} rows, above the ceiling of ${ROW_CEILING}; reduce it first (docs/RUNBOOK.md)`,
      );
  }
  if (orphanTotal > 0 && options.ackOrphans !== orphanTotal) {
    blockers.push(
      `${orphanTotal} row(s) will be quarantined (${orphans
        .filter((r) => r.n > 0)
        .map((r) => `${r.check.slice(7)}=${r.n}`)
        .join(', ')}); ` + `review them and re-run with --ack-orphans ${orphanTotal}`,
    );
  }
  const caseMismatch = byPrefix('case_mismatch:').filter((r) => r.n > 0);
  if (caseMismatch.length > 0) {
    review.push(
      `ids that differ from a real organization only by case (quarantined, never corrected): ${caseMismatch.map((r) => `${r.check.slice(14)}=${r.n}`).join(', ')}`,
    );
  }
  for (const r of byPrefix('review:')) if (r.n > 0) review.push(`${r.check.slice(7)}: ${r.n} (kept, review)`);
  return { ok: blockers.length === 0, blockers, review, orphanTotal };
}

function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const ackAt = args.indexOf('--ack-orphans');
  const ack = ackAt >= 0 ? Number(args[ackAt + 1]) : null;
  if (!file) {
    console.error('usage: node scripts/migration-0026-preflight.mjs <preflight.json> [--ack-orphans N]');
    process.exit(2);
  }
  const rows = rowsOf(JSON.parse(readFileSync(file, 'utf8')));
  for (const r of rows) console.log(`${String(r.n).padStart(9)}  ${r.check}`);
  const result = evaluate(rows, { ackOrphans: Number.isInteger(ack) ? ack : null });
  for (const line of result.review) console.log(`REVIEW  ${line}`);
  for (const line of result.blockers) console.log(`BLOCKER ${line}`);
  console.log(
    result.ok
      ? '\npreflight: nothing blocks applying (this does not prove the migration will succeed)'
      : '\npreflight: DO NOT APPLY',
  );
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
