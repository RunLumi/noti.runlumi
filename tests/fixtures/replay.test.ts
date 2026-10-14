import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { displayOf } from '../../src/events/canonical';
import { validateCanonicalEvent } from '../../src/events/validate';
import { normalize, renderAll } from '../conformance/normalize';
import { createRig } from '../conformance/rig';
import { FIXTURE_DIR, GOLDEN_DIR, goldenPath, loadFixtureJson, loadManifest, type FixtureEntry } from './load';

vi.mock('../../src/auth/better-auth', async () => (await import('../sources/harness')).mockAuth());
const { default: worker } = await import('../../src/index');

/**
 * Fixture replay (spec 05 F72, spec 06 F79): every fixture goes through the REAL ingress route
 * over the fake D1, signed at run time with a generated secret, and the outcome, the canonical
 * event, the per-integration routing result and the rendered Slack, Lark, Teams and Discord
 * payloads are compared with a committed golden file. A provider or adapter change that moves any
 * of them fails here. Goldens change only on an explicit `UPDATE_GOLDEN=1` run, and the diff is
 * the review.
 */
const UPDATE = process.env.UPDATE_GOLDEN === '1';
const manifest = loadManifest();

afterEach(() => vi.unstubAllGlobals());

interface RoutingRow {
  integration_id: string;
  outcome: string;
  reason: string;
}

function routingOf(rig: Awaited<ReturnType<typeof createRig>>): Record<string, string> {
  const out: Record<string, string> = {};
  const decisions = rig.h.db.raw
    .prepare('SELECT integration_id,outcome,reason FROM routing_decisions')
    .all() as unknown as RoutingRow[];
  for (const [name, id] of Object.entries(rig.integrations)) {
    const delivered = rig.h.db.raw
      .prepare('SELECT COUNT(*) AS n FROM deliveries WHERE integration_id=?')
      .get(id) as { n: number };
    const decision = decisions.find((d) => d.integration_id === id && d.outcome === 'filtered');
    out[name] = delivered.n > 0 ? 'delivered' : decision ? `filtered:${decision.reason}` : 'not_considered';
  }
  return out;
}

async function replay(entry: FixtureEntry): Promise<Record<string, unknown>> {
  const json = loadFixtureJson(entry);
  const repo = (json.repository as { full_name?: string } | undefined)?.full_name;
  const rig = await createRig(entry.provider, worker, repo ? { repo } : {});
  const res = await rig.post(rig.encode(json), { headers: entry.headers });
  const body = await res.json().catch(() => null);
  const canonical = normalize(entry.provider, entry.headers, json);
  const messages = rig.messages();
  const strip = ({ id: _i, integrationId: _g, organizationId: _o, ...rest }: (typeof messages)[number]) => rest;

  if (canonical) {
    // The route validated this event and derived the queue message from it.
    expect(validateCanonicalEvent(canonical).ok).toBe(true);
    for (const m of messages) expect(strip(m)).toEqual(displayOf(canonical));
  }
  const first = messages[0];
  return {
    fixture: entry.id,
    provenance: entry.provenance,
    response: { status: res.status, body },
    canonical,
    routing: entry.provider === 'github' ? routingOf(rig) : undefined,
    delivered: messages.length,
    message: first ? strip(first) : null,
    rendered: first ? await renderAll(first) : null,
  };
}

function outcomeOf(result: Record<string, unknown>): FixtureEntry['expect'] {
  const response = result.response as { status: number; body: Record<string, unknown> | null };
  if (response.body?.ping) return 'ping';
  if (response.body?.lifecycle) return 'lifecycle';
  return (result.delivered as number) > 0 ? 'delivered' : 'ignored';
}

describe('fixture replay', () => {
  it.each(manifest.map((e) => [e.id, e] as const))('%s', async (_id, entry) => {
    const actual = JSON.parse(JSON.stringify(await replay(entry))) as Record<string, unknown>;
    // Accepted, never an error: every positive fixture is acknowledged with a 2xx.
    expect((actual.response as { status: number }).status).toBeLessThan(300);
    expect(outcomeOf(actual)).toBe(entry.expect);
    const file = goldenPath(entry);
    if (UPDATE) {
      writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
      return;
    }
    if (!existsSync(file)) throw new Error(`No golden for ${entry.id}. Review the output, then run UPDATE_GOLDEN=1.`);
    expect(actual).toEqual(JSON.parse(readFileSync(file, 'utf8')));
  });
});

describe('fixture corpus gate (F79)', () => {
  it('every manifest entry has a fixture file, provenance, a read date and a golden', () => {
    for (const e of manifest) {
      expect(existsSync(`${FIXTURE_DIR}/${e.file}`), e.id).toBe(true);
      expect(e.source.length, e.id).toBeGreaterThan(0);
      expect(e.readOn, e.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (!UPDATE) expect(existsSync(goldenPath(e)), e.id).toBe(true);
      if (e.provenance === 'derived') expect(e.derive, e.id).toBeDefined();
    }
  });

  it('every fixture file is in the manifest and every golden belongs to an entry', () => {
    const files = new Set(manifest.map((e) => e.file));
    for (const provider of ['github', 'gitlab', 'stripe', 'generic'])
      for (const f of readdirSync(`${FIXTURE_DIR}/${provider}`)) expect(files.has(`${provider}/${f}`), f).toBe(true);
    const goldens = new Set(manifest.map((e) => goldenPath(e).split('/').pop()));
    for (const f of readdirSync(GOLDEN_DIR)) expect(goldens.has(f), f).toBe(true);
  });

  it('ids are unique and the replay has no skipped fixture', () => {
    expect(new Set(manifest.map((e) => e.id)).size).toBe(manifest.length);
  });

  it('every catalogued event type is covered by a delivered fixture of its provider', () => {
    const goldens = manifest
      .filter((e) => e.expect === 'delivered' && existsSync(goldenPath(e)))
      .map((e) => JSON.parse(readFileSync(goldenPath(e), 'utf8')) as { canonical: { type: string } | null });
    const covered = new Set(goldens.map((g) => g.canonical?.type));
    return import('../../src/events/catalog').then(({ EVENT_CATALOG }) => {
      const missing: string[] = [];
      for (const [provider, list] of Object.entries(EVENT_CATALOG))
        for (const d of list)
          if (!covered.has(`io.lumi.noti.${provider}.${d.type}`)) missing.push(`${provider}.${d.type}`);
      // Named, not hidden: types whose documented example does not exist and that no fixture
      // derives yet. Shrinking this list is progress; growing it is a regression.
      expect(missing.sort()).toEqual(KNOWN_UNCOVERED);
    });
  });
});

const KNOWN_UNCOVERED: string[] = [];
