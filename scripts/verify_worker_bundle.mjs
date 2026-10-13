#!/usr/bin/env node
/**
 * Guard against the pure-JS scrypt fallback reaching the deployed Worker bundle.
 *
 * Why this exists
 * ---------------
 * Better Auth hashes passwords with scrypt. `@better-auth/utils` exposes a `workerd`
 * export condition that routes to the native `node:crypto` implementation, but bundlers
 * (Wrangler / esbuild, and now Vite) have failed to honour that condition more than once
 * (better-auth#8860, #9649). When it resolves the pure-JS `@noble/hashes` fallback instead:
 *
 *   1. Sign-in burns roughly 4.5-5 seconds of CPU, which exceeds the Workers CPU limit.
 *   2. The fallback compares digests with a plain `===` rather than a constant-time
 *      comparison, so password verification is no longer timing-safe.
 *
 * The second point makes this a security check, not only a performance one.
 *
 * The Worker is built by Vite (ADR 0017), so this reads `web/dist/server`. It has to run against
 * the built artifact: the failure mode is specifically that the
 * *bundler* resolves the wrong entrypoint, so inspecting `node_modules` proves nothing.
 *
 * Sources:
 *   https://github.com/better-auth/better-auth/issues/8860
 *   https://github.com/better-auth/better-auth/issues/9649
 *   https://github.com/better-auth/utils/blob/main/package.json
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const serverDir = join(root, 'web', 'dist', 'server');
const clientDir = join(root, 'web', 'dist', 'client');

function fail(message) {
  console.error(`\n✗ worker bundle verification failed: ${message}\n`);
  process.exit(1);
}

// The Worker is built by Vite (TanStack Start + @cloudflare/vite-plugin, ADR 0017), so the
// artifact that is deployed is web/dist/server. Run `npm run build:web` first.
if (!existsSync(join(serverDir, 'wrangler.json')))
  fail(`${serverDir}/wrangler.json is missing; run \`npm run build:web\` first`);

function jsFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return jsFiles(path);
    return name.endsWith('.js') ? [path] : [];
  });
}

const files = jsFiles(serverDir);
if (files.length === 0) fail(`no .js bundle produced in ${serverDir}`);

const bundle = files.map((f) => readFileSync(f, 'utf8')).join('\n');

// The deployed config must still declare what the API needs.
const deployed = JSON.parse(readFileSync(join(serverDir, 'wrangler.json'), 'utf8'));
if (deployed.assets?.binding !== 'ASSETS') fail('the built wrangler config lacks the ASSETS binding');
if (deployed.assets?.html_handling !== 'none' || deployed.assets?.not_found_handling !== 'none')
  fail('the built wrangler config must set assets html_handling and not_found_handling to "none"');
if (!Array.isArray(deployed.triggers?.crons) || deployed.triggers.crons.length === 0)
  fail('the built wrangler config lost its cron trigger');
const consumers = (deployed.queues?.consumers ?? []).map((c) => c.queue).sort();
if (consumers.join() !== 'noti-dead-letters,noti-deliveries')
  fail(
    `the built wrangler config must consume noti-deliveries and noti-dead-letters, found: ${consumers.join() || 'none'}`,
  );

// The module's default export is the Worker. Read its object literal: it must have exactly the
// handlers the runtime calls. (The bundle is not minified, so the shape is stable text.)
const entry = readFileSync(join(serverDir, 'index.js'), 'utf8');
const exported = /export \{[^}]*?\b(\w+) as default\b[^}]*\}/.exec(entry)?.[1];
if (!exported) fail('web/dist/server/index.js has no default export');
const literal = new RegExp(`(?:var|const|let) ${exported} = \\{\\n([\\s\\S]*?)\\n\\};`).exec(entry)?.[1];
if (!literal) fail(`could not find the object literal of the default export "${exported}"`);
const handlers = [...literal.matchAll(/^\t(\w+)\s*[(:]/gm)].map((m) => m[1]).sort();
if (handlers.join() !== 'fetch,queue,scheduled')
  fail(
    `the Worker's default export must have fetch, queue and scheduled, found: ${handlers.join() || 'none'}`,
  );

// Local secrets must never ride along. The plugin copies `.dev.vars` next to the built Worker for
// `vite preview`; wrangler does not upload it, but a deploy artifact should not contain it at all.
const devVars = join(serverDir, '.dev.vars');
if (process.argv.includes('--deploy')) rmSync(devVars, { force: true });
if (existsSync(devVars) && (process.env.CI || process.argv.includes('--ci')))
  fail('web/dist/server/.dev.vars exists in CI: local secrets must not be part of a build artifact');
const assetsIgnore = join(clientDir, '.assetsignore');
if (!existsSync(assetsIgnore) || !/\.dev\.vars/.test(readFileSync(assetsIgnore, 'utf8')))
  fail('web/dist/client/.assetsignore must list .dev.vars so it is never uploaded as an asset');

// The dashboard shell is the document every navigation is answered with.
if (!existsSync(join(clientDir, '_shell.html')))
  fail('web/dist/client/_shell.html is missing: the SPA shell was not prerendered');

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
console.log(
  '✓ ASSETS binding (html_handling none), cron, both queue consumers, fetch/scheduled/queue exports and the SPA shell are present',
);
console.log('✓ constant-time comparison (timingSafeEqual) present');
