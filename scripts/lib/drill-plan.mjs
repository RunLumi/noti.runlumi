/**
 * Attack plan for the tenant-isolation drill (docs/specs/15 F233, evidence item 2).
 *
 * Pure data, no I/O, shared by two runners so they cannot disagree about what is attacked:
 *   - tests/drill/tenant-isolation.test.ts  runs it against the real Worker over a fake D1;
 *   - scripts/tenant-isolation-drill.mjs     runs it against a deployed URL (staging).
 *
 * The routes come from `ROUTE_POLICY` (src/auth/route-policy.ts), the same registry the
 * route-to-capability test uses, so a new route is attacked automatically; a route that needs
 * ids or a body this file does not know about throws instead of being skipped.
 *
 * Four vectors, all authenticated as a member of workspace A against workspace B:
 *   org-param        name B as the workspace (`?org=<B>`, or the body of the switch endpoint)
 *   foreign-id       act in A but put one of B's resource ids in the path
 *   foreign-body-id  act in A but name B's source in the request body
 *   own-scope        act in A on a collection route: the answer must contain nothing of B's
 *
 * @typedef {{ orgId: string, orgName?: string, integrationId: string, sourceId: string, deliveryId: string }} Victim
 * @typedef {{ method: string, path: string, access: { kind: string, capability?: string } }} Route
 * @typedef {{
 *   name: string, key: string, method: string, path: string, body: unknown,
 *   vector: 'org-param' | 'foreign-id' | 'foreign-body-id' | 'own-scope',
 *   expect: number[], readOnly: boolean, capability?: string
 * }} Attack
 */

/** Routes the drill attacks: everything behind a session or a capability. */
const ATTACKED_KINDS = new Set(['capability', 'member', 'session']);

/** Which victim id fills which `:placeholder`. */
const ID_FIELD = [
  [/^\/api\/integrations\/:id/, 'integrationId'],
  [/^\/api\/sources\/:id/, 'sourceId'],
  [/^\/api\/deliveries\/:id/, 'deliveryId'],
];

/**
 * A body that would SUCCEED for the owner, so a 404 for the attacker proves authorization and
 * not a malformed request. `null` means no body; every mutating route must be listed so a new
 * one cannot be forgotten.
 * @type {Record<string, unknown>}
 */
const BODIES = {
  'PATCH /api/integrations/:id': { enabled: false },
  'PATCH /api/sources/:id': { enabled: false },
  'POST /api/sources/:id/rotate': {},
  'POST /api/deliveries/:id/replay': {},
  // Bulk replay (ADR 0023): the plan and the run name a window; with no ids they act on the caller's own workspace only.
  'POST /api/deliveries/replay-plan': {},
  'POST /api/deliveries/replay': {},
  'POST /api/integrations/:id/test': {},
  'POST /api/integrations/:id/revoke-credentials': {},
  'POST /api/sources/:id/revoke-credentials': {},
  'POST /api/integrations/:id/filters/preview': { filters: { v: 1 } },
  // Typing the workspace name is the confirmation; with it the owner's request would succeed.
  'POST /api/workspace/deletion': (/** @type {Victim} */ v) => ({ confirm: v.orgName ?? v.orgId }),
  'POST /api/github/install': {},
  'POST /api/integrations': {},
  'POST /api/sources': { name: 'drill' },
  'POST /api/workspace/active': (/** @type {Victim} */ v) => ({ organizationId: v.orgId }),
  'DELETE /api/integrations/:id': null,
  'DELETE /api/sources/:id': null,
  'DELETE /api/workspace/deletion': null,
};

/** A non-member gets 404 so the workspace's existence is not confirmed. */
const NOT_FOUND = [404];

/** @param {string} path @param {Victim} victim */
function fill(path, victim) {
  if (!path.includes(':')) return path;
  const rule = ID_FIELD.find(([pattern]) => pattern.test(path));
  if (!rule) throw new Error(`drill: no victim id is defined for ${path}; teach scripts/lib/drill-plan.mjs`);
  return path.replace(/:id\b/, victim[rule[1]]);
}

/**
 * @param {readonly Route[]} routes
 * @param {Victim} victim
 * @returns {Attack[]}
 */
export function planAttacks(routes, victim) {
  /** @type {Attack[]} */
  const plan = [];
  for (const route of routes) {
    if (!ATTACKED_KINDS.has(route.access.kind)) continue;
    const key = `${route.method} ${route.path}`;
    const readOnly = route.method === 'GET';
    const capability = route.access.kind === 'capability' ? route.access.capability : undefined;
    /** @param {Omit<Attack, 'key' | 'method' | 'capability'>} a */
    const add = (a) => plan.push({ key, method: route.method, ...(capability ? { capability } : {}), ...a });

    if (route.path.startsWith('/github/')) {
      // Browser callbacks with no state bounce to the dashboard. The choice POST requires
      // a URL-encoded form, so this bodyless request must fail closed as unsupported media.
      // Neither response may echo B or change tenant data.
      add({
        name: `${key} (own-scope)`,
        path: route.path,
        body: undefined,
        vector: 'own-scope',
        expect: key === 'POST /github/choose' ? [415] : [302],
        readOnly: true,
      });
      continue;
    }

    if (!readOnly && !(key in BODIES)) {
      throw new Error(`drill: ${key} has no attack body; teach scripts/lib/drill-plan.mjs`);
    }
    const spec = BODIES[key] ?? undefined;
    const body = typeof spec === 'function' ? /** @type {(v: Victim) => unknown} */ (spec)(victim) : spec;

    if (key === 'POST /api/workspace/active') {
      // The workspace is named in the body, not the query.
      add({
        name: `${key} (org-param)`,
        path: route.path,
        body,
        vector: 'org-param',
        expect: NOT_FOUND,
        readOnly: false,
      });
      continue;
    }

    const concrete = fill(route.path, victim);
    add({
      name: `${key} (org-param)`,
      path: `${concrete}?org=${encodeURIComponent(victim.orgId)}`,
      body,
      vector: 'org-param',
      expect: NOT_FOUND,
      readOnly,
    });
    if (route.path.includes(':')) {
      add({
        name: `${key} (foreign-id)`,
        path: concrete,
        body,
        vector: 'foreign-id',
        expect: NOT_FOUND,
        readOnly,
      });
    } else if (readOnly) {
      // 403 is a member lacking the capability in their own workspace; never B-related.
      add({
        name: `${key} (own-scope)`,
        path: route.path,
        body: undefined,
        vector: 'own-scope',
        expect: [200, 403],
        readOnly: true,
      });
    }
    if (key === 'POST /api/integrations') {
      // Create a notification route in A that points at B's source.
      add({
        name: `${key} (foreign-body-id)`,
        path: route.path,
        body: {
          name: 'drill',
          sourceId: victim.sourceId,
          destination: 'slack',
          webhookUrl: 'https://hooks.slack.com/services/T000/B000/DrillAttackerTail',
        },
        vector: 'foreign-body-id',
        expect: [404, 422],
        readOnly: false,
      });
    }
  }
  return plan;
}

/**
 * Statuses an attack may legitimately get. A caller whose role lacks the route's capability is
 * refused with 403 BEFORE any id is looked up, when they act in their own workspace
 * (`foreign-id`, `foreign-body-id`): that answer is about the caller's role and reveals nothing
 * about B. Naming B as the workspace (`org-param`) is always 404, whatever the role.
 * @param {Attack} attack
 * @param {(capability: string) => boolean} holds does the attacker's role hold this capability?
 * @returns {number[]}
 */
export function allowedStatuses(attack, holds) {
  const extra =
    (attack.vector === 'foreign-id' || attack.vector === 'foreign-body-id') &&
    attack.capability &&
    !holds(attack.capability)
      ? [403]
      : [];
  return [...attack.expect, ...extra];
}

/**
 * Does `text` contain any of B's identifiers? Case-sensitive substring match on values that are
 * unique to the victim (ids, endpoint ids, names, destination tails).
 * @param {string} text @param {readonly string[]} markers
 */
export function leakedMarkers(text, markers) {
  return markers.filter((m) => m.length > 0 && text.includes(m));
}
