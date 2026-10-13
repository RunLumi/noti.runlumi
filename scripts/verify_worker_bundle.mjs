#!/usr/bin/env node
/**
 * Guard against the pure-JS scrypt fallback reaching the deployed Worker bundle.
 *
 * Why this exists
 * ---------------
 * Better Auth hashes passwords with scrypt. `@better-auth/utils` exposes a `workerd`
 * export condition that routes to the native `node:crypto` implementation, but Wrangler /
 * esbuild has failed to honour that condition more than once
 * (better-auth#8860, #9649). When it resolves the pure-JS `@noble/hashes` fallback instead:
 *
 *   1. Sign-in burns roughly 4.5-5 seconds of CPU, which exceeds the Workers CPU limit.
 *   2. The fallback compares digests with a plain `===` rather than a constant-time
 *      comparison, so password verification is no longer timing-safe.
 *
 * The second point makes this a security check, not only a performance one.
 *
 * It has to run against the built artifact: the failure mode is specifically that the
 * *bundler* resolves the wrong entrypoint, so inspecting `node_modules` proves nothing.
 *
 * Sources:
 *   https://github.com/better-auth/better-auth/issues/8860
 *   https://github.com/better-auth/better-auth/issues/9649
 *   https://github.com/better-auth/utils/blob/main/package.json
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = mkdtempSync(join(tmpdir(), 'noti-bundle-'));

function fail(message) {
  console.error(`\n✗ worker bundle verification failed: ${message}\n`);
  process.exit(1);
}

console.log('Building Worker bundle (dry run)…');
const build = spawnSync(
  process.execPath,
  [join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'deploy', '--dry-run', '--outdir', outDir],
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);

if (build.status !== 0) {
  console.error(build.stdout ?? '');
  console.error(build.stderr ?? '');
  fail('wrangler dry-run build did not succeed');
}

const files = readdirSync(outDir).filter((f) => f.endsWith('.js'));
if (files.length === 0) fail(`no .js bundle produced in ${outDir}`);

const bundle = files.map((f) => readFileSync(join(outDir, f), 'utf8')).join('\n');

// A single check over the whole bundle rather than per-file: esbuild may split modules.
const pureJsScrypt = (bundle.match(/noble\/hashes\/scrypt/g) ?? []).length;
if (pureJsScrypt > 0) {
  fail(
    `the pure-JS @noble/hashes scrypt fallback is in the bundle (${pureJsScrypt} reference(s)).\n` +
      '  Password hashing would be non-constant-time and would exceed the Workers CPU limit.\n' +
      '  Pin @better-auth/utils to a version whose `workerd` export condition resolves, or pass an\n' +
      '  explicit native scrypt implementation via emailAndPassword.password.{hash,verify}.',
  );
}

if (!bundle.includes('timingSafeEqual')) {
  fail(
    'timingSafeEqual is absent from the bundle, so constant-time comparison cannot be happening.\n' +
      '  This usually means the native node:crypto path was not resolved.',
  );
}

console.log(`✓ no pure-JS scrypt fallback (checked ${files.length} bundle file(s))`);
console.log('✓ constant-time comparison (timingSafeEqual) present');

rmSync(outDir, { recursive: true, force: true });
