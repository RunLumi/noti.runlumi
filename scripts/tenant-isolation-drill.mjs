#!/usr/bin/env node
/**
 * Tenant-isolation drill against a DEPLOYED Worker (docs/specs/15 F233, evidence item 2).
 *
 * Authenticated as a member of workspace A, it tries to read, change, delete and invoke
 * workspace B's data on every route in src/auth/route-policy.ts, by naming B or guessing B's
 * ids. Every attempt must be 404 (or 403 only where A's own role lacks the capability), must
 * leak none of B's identifiers, and nothing may be sent to B's destinations. The attack plan is
 * scripts/lib/drill-plan.mjs, the same one tests/drill/tenant-isolation.test.ts runs over a
 * fake D1, so the two cannot drift.
 *
 * STATUS: UNVERIFIED. It has not been run against a deployment: no staging environment exists
 * yet (docs/specs/REMAINING.md group 3). The fake-D1 suite proves the application; this script
 * is what proves the deployed Worker, real D1 and real Better Auth sessions.
 *
 * Prepare (by hand, on staging, with two throwaway accounts that you own):
 *   1. Workspace A and workspace B, each with one source, one integration bound to it, one
 *      delivery (post a signed test event) and one pending invitation (sent to an address you
 *      own and left unaccepted). Use a Slack destination you control for B.
 *   2. Sign in as the A member in a browser, copy the `Cookie` request header of any /api call.
 *   3. Write B's identifiers into a JSON file (never commit it):
 *        { "orgId": "...", "orgName": "...", "integrationId": "...", "sourceId": "...",
 *          "deliveryId": "...", "invitationId": "...",
 *          "markers": ["<B's names, endpoint id, destination tail, invitee address>"] }
 *
 * Run (Node 22.6+ strips the TypeScript policy files; the flag is needed on 22.x):
 *   DRILL_BASE_URL=https://staging.example \
 *   DRILL_COOKIE='...' DRILL_VICTIM_FILE=./victim.json DRILL_ATTACKER_ROLE=admin \
 *   node --experimental-strip-types scripts/tenant-isolation-drill.mjs
 *
 * Without DRILL_ALLOW_DESTRUCTIVE=1 only the read attacks are sent. With it, the write attacks
 * (PATCH, DELETE, rotate, replay, deletion request...) are sent too: if isolation is BROKEN they
 * will change B's staging data, which is the point of a drill and why they are opt-in. Run the
 * script as A, then again as B against A for the reverse direction.
 *
 * Exit code 0 only when every attempt behaved. It prints one line per attempt and never prints
 * a cookie, a response body or any of B's identifiers.
 */
import { readFileSync } from 'node:fs';
import { planAttacks, allowedStatuses, leakedMarkers } from './lib/drill-plan.mjs';

const need = (name) => {
  const v = process.env[name];
  if (!v) {
    console.error(`missing ${name}; see the header of scripts/tenant-isolation-drill.mjs`);
    process.exit(2);
  }
  return v;
};

const base = new URL(need('DRILL_BASE_URL'));
if (base.protocol !== 'https:') {
  console.error('DRILL_BASE_URL must be https; a drill is never pointed at an unencrypted host');
  process.exit(2);
}
const cookie = need('DRILL_COOKIE');
const victim = JSON.parse(readFileSync(need('DRILL_VICTIM_FILE'), 'utf8'));
const role = process.env.DRILL_ATTACKER_ROLE ?? 'admin';
const destructive = process.env.DRILL_ALLOW_DESTRUCTIVE === '1';
for (const field of ['orgId', 'integrationId', 'sourceId', 'deliveryId', 'invitationId']) {
  if (typeof victim[field] !== 'string' || victim[field] === '') {
    console.error(`victim file is missing "${field}"`);
    process.exit(2);
  }
}
const markers = [
  victim.orgId,
  victim.integrationId,
  victim.sourceId,
  victim.deliveryId,
  victim.invitationId,
  ...(victim.markers ?? []),
];

let policy;
let permissions;
try {
  policy = await import('../src/auth/route-policy.ts');
  permissions = await import('../src/auth/permissions.ts');
} catch (e) {
  console.error('could not load the TypeScript route policy; run with `node --experimental-strip-types`');
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
}

const attacks = planAttacks(policy.ROUTE_POLICY, victim).filter((a) => destructive || a.readOnly);
const holds = (capability) => permissions.can(role, capability);
const origin = base.origin;

let failed = 0;
for (const attack of attacks) {
  const url = new URL(attack.path, base);
  const headers = { cookie, accept: 'application/json', origin };
  const init = { method: attack.method, headers, redirect: 'manual' };
  if (attack.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(attack.body);
  }
  let status = 0;
  let text;
  try {
    const res = await fetch(url, init);
    status = res.status;
    text = `${await res.text()}\n${res.headers.get('location') ?? ''}`;
  } catch (e) {
    text = e instanceof Error ? e.message : String(e);
  }
  const allowed = allowedStatuses(attack, holds);
  const leaked = leakedMarkers(text, markers);
  const ok = allowed.includes(status) && leaked.length === 0;
  if (!ok) failed++;
  // Only the attempt, the status and how many identifiers leaked: never the identifiers.
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${attack.name}  status=${status} allowed=${allowed.join('/')} leaked=${leaked.length}`,
  );
}

console.log(
  `\n${attacks.length} attempts, ${failed} failed${destructive ? '' : ' (read-only; set DRILL_ALLOW_DESTRUCTIVE=1 for writes)'}`,
);
if (failed > 0) {
  console.log('ISOLATION FAILED: stop the route, preserve logs, run the incident steps in docs/SECURITY.md.');
  process.exit(1);
}
