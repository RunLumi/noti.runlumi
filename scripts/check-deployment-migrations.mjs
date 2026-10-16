#!/usr/bin/env node
/** Read-only release gate: schema changes need their own reviewed migration procedure. */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWrangler } from './predeploy-check.mjs';

export function pendingMigrations(local, applied) {
  const present = new Set(applied);
  return local.filter((name) => !present.has(name)).sort();
}

export async function checkMigrations({ accountId, databaseId, token, local }, fetchImpl = fetch) {
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required.');
  if (!/^[a-f0-9]{32}$/.test(accountId) || !/^[a-f0-9-]{36}$/.test(databaseId))
    throw new Error('Invalid deployment account or database ID.');
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT name FROM d1_migrations' }),
    },
  );
  // Never include the provider response/error body: it is untrusted and may contain sensitive data.
  if (!response.ok) throw new Error(`Cannot read deployment migration ledger (HTTP ${response.status}).`);
  const body = await response.json().catch(() => {
    throw new Error('Invalid deployment migration ledger response.');
  });
  const batches = body?.result;
  if (
    body?.success !== true ||
    !Array.isArray(batches) ||
    batches.length !== 1 ||
    batches[0]?.success !== true ||
    !Array.isArray(batches[0]?.results) ||
    !batches[0].results.every((row) => typeof row?.name === 'string')
  )
    throw new Error('Invalid deployment migration ledger response.');
  const pending = pendingMigrations(
    local,
    batches[0].results.map((row) => row.name),
  );
  if (pending.length) throw new Error(`Apply reviewed migrations before deploying: ${pending.join(', ')}`);
  return { applied: local.length };
}

async function main() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const config = parseWrangler(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'));
  const database = config.d1_databases?.find((db) => db.binding === 'DB');
  const local = readdirSync(join(root, 'migrations')).filter((name) => /^\d+.*\.sql$/.test(name));
  const result = await checkMigrations({
    accountId: config.account_id,
    databaseId: database?.database_id,
    token: process.env.CLOUDFLARE_API_TOKEN,
    local,
  });
  console.info(`Deployment schema: all ${result.applied} migrations are applied; no writes performed.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Deployment migration check failed.');
    process.exitCode = 1;
  });
}
