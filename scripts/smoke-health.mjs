#!/usr/bin/env node
/**
 * Post-deploy smoke check (docs/RUNBOOK.md, "After a deploy"; ADR 0022). `npm run deploy` runs it
 * after `wrangler deploy`: it asks the freshly deployed Worker for `/health` and `/health/ready`.
 *
 *   node scripts/smoke-health.mjs [origin]      (default: APP_ORIGIN from wrangler.jsonc)
 *
 * A misconfigured deployment answers 503 and names the bindings (never values). That is a failed
 * deploy: this exits 1 and prints the rollback instruction. It sends only two GETs and no secret.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWrangler } from './predeploy-check.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * @param {string} origin
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<{ ok: boolean, lines: string[] }>}
 */
export async function smoke(origin, fetchImpl = fetch) {
  const lines = [];
  let ok = true;
  for (const path of ['/health', '/health/ready']) {
    try {
      const res = await fetchImpl(new URL(path, origin), { headers: { accept: 'application/json' } });
      const body = await res.text();
      const detail = body.length <= 300 ? body : `${body.slice(0, 300)}...`;
      lines.push(`${path} -> ${res.status} ${detail}`);
      if (res.status !== 200) ok = false;
    } catch (e) {
      ok = false;
      lines.push(`${path} -> unreachable (${e instanceof Error ? e.message : 'error'})`);
    }
  }
  return { ok, lines };
}

async function main() {
  const config = parseWrangler(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'));
  const origin = process.argv[2] ?? String(config.vars?.APP_ORIGIN ?? '');
  const { ok, lines } = await smoke(origin);
  for (const line of lines) console.info(line);
  if (!ok) {
    console.error(
      'Smoke check FAILED. Roll back now: `wrangler rollback`, then read /health for the binding names.',
    );
    process.exit(1);
  }
  console.info('smoke: ok');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
