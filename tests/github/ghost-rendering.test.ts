import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ADAPTERS,
  DESTINATION_KINDS,
  capabilitiesFor,
  type DestinationKind,
  type RenderFormat,
} from '../../src/connectors/destinations';
import type { DeliveryMessage } from '../../src/env';
import { toNotification } from '../../src/pipeline/consumer';
import { renderGroup, type HeldItem } from '../../src/routing/noise-render';
import { DEFAULT_NOISE, serializeNoise } from '../../src/routing/noise';
import { createRig, type Rig } from '../conformance/rig';
import { loadFixtureJson, loadManifest, type FixtureEntry } from '../fixtures/load';

vi.mock('../../src/auth/better-auth', async () => (await import('../sources/harness')).mockAuth());
const { default: worker } = await import('../../src/index');

/**
 * F60: GitHub's `ghost` placeholder for a deleted account is never presented as a person, in any
 * destination's card or in any of its text fallbacks. GitHub's words (spec 05 F60): "Sometimes GitHub
 * can't resolve a specific user… `sender` is populated with the `ghost` user… Don't assume `sender`
 * always identifies the person who caused an event".
 *
 * The fixture is the manifest's `github/pull_request.opened_by_ghost` (the documented example with
 * `sender.login` set to `ghost`); the case variants are derived from it the same way. Each message
 * goes through the real route (signature, mapping, `displayOf`, the durable outbox write), then every
 * registered destination kind renders it at every rung of its ladder (card, markdown, plain), so a
 * fallback that adds an attribution line cannot slip past.
 */
const entry = (id: string): FixtureEntry => {
  const e = loadManifest().find((m) => m.id === id);
  if (!e) throw new Error(id);
  return e;
};
const ghost = entry('github/pull_request.opened_by_ghost');
const person = entry('github/pull_request.opened');

afterEach(() => vi.unstubAllGlobals());

async function routed(
  json: Record<string, unknown>,
  e: FixtureEntry,
): Promise<{ rig: Rig; m: DeliveryMessage }> {
  const rig = await createRig('github', worker);
  const res = await rig.post(rig.encode(json), { headers: e.headers });
  expect(res.status).toBe(202);
  const m = rig.messages()[0];
  if (!m) throw new Error('nothing queued');
  return { rig, m };
}

/** Every (kind, rung) payload a queued message can become, as text. */
function renderings(m: DeliveryMessage): { kind: DestinationKind; format: RenderFormat; text: string }[] {
  return DESTINATION_KINDS.flatMap((kind) => {
    const caps = capabilitiesFor(kind);
    return caps.formats.map((format) => {
      const out = ADAPTERS[kind].render(toNotification(m), caps, { startAt: format });
      if (!out.ok) throw new Error(`${kind}/${format}: ${out.reason}`);
      // The ladder starts at the requested rung; a short message fits it, so this IS that rung.
      expect(out.message.format, `${kind}/${format}`).toBe(format);
      return { kind, format, text: JSON.stringify(out.message.payload) };
    });
  });
}

describe('F60 ghost sender in every destination rendering', () => {
  it('renders every kind and rung (the matrix is not empty)', () => {
    const kinds = DESTINATION_KINDS.map((k) => [k, capabilitiesFor(k).formats.length] as const);
    expect(kinds.length).toBeGreaterThanOrEqual(5);
    for (const [kind, n] of kinds) expect(n, kind).toBeGreaterThan(0);
  });

  it('control: a real sender IS shown in every kind and rung, so the check below can see attribution', async () => {
    const { m } = await routed(loadFixtureJson(person), person);
    expect(m.actor).toBe('Codertocat');
    for (const r of renderings(m)) expect(r.text, `${r.kind}/${r.format}`).toContain('Codertocat');
  });

  it.each(['ghost', 'Ghost', 'GHOST'])(
    'a %s sender is attributed to nobody, in every kind and rung',
    async (login) => {
      const json = loadFixtureJson(ghost) as { sender: Record<string, unknown> };
      const { m } = await routed({ ...json, sender: { ...json.sender, login } }, ghost);
      expect(m.actor).toBeUndefined();
      for (const r of renderings(m)) {
        expect(r.text.toLowerCase(), `${r.kind}/${r.format}`).not.toContain('ghost');
        // No dangling "by " attribution with an empty name either.
        expect(r.text, `${r.kind}/${r.format}`).not.toMatch(/\bby\s*(["\\]|$)/);
        // The event itself is still delivered in full: title, repository and link.
        expect(r.text, `${r.kind}/${r.format}`).toContain('Update the README with new information.');
        expect(r.text, `${r.kind}/${r.format}`).toContain('Codertocat/Hello-World');
      }
    },
  );

  it('a held (combined) ghost update stores no attribution, and its combined notification shows none', async () => {
    const rig = await createRig('github', worker);
    const all = rig.integrations.all ?? '';
    rig.h.db.raw
      .prepare('UPDATE integrations SET noise_json=? WHERE id=?')
      .run(serializeNoise({ ...DEFAULT_NOISE, groupWindowSec: 300 }), all);
    const res = await rig.post(rig.encode(loadFixtureJson(ghost)), { headers: ghost.headers });
    expect(res.status).toBe(202);
    const held = rig.h.db.raw
      .prepare(
        'SELECT title,url,repo,actor,status,summary,event_type FROM held_events WHERE integration_id=?',
      )
      .all(all) as {
      title: string;
      url: string;
      repo: string;
      actor: string;
      status: HeldItem['status'];
      summary: string;
      event_type: string;
    }[];
    expect(held).toHaveLength(1);
    const row = held[0];
    if (!row) throw new Error('not held');
    expect(row.actor).toBe('');
    const item: HeldItem = {
      id: 'held-1',
      holdReason: 'grouped',
      groupKey: 'k'.padEnd(32, '0'),
      heldAt: 1,
      eventType: row.event_type,
      title: row.title,
      url: row.url,
      repo: row.repo,
      actor: row.actor,
      status: row.status,
      summary: row.summary,
      resolved: false,
    };
    const group = renderGroup([item, { ...item, id: 'held-2', heldAt: 2 }]);
    expect(group.actor).toBeUndefined();
    const message: DeliveryMessage = {
      id: 'd',
      integrationId: 'i',
      organizationId: 'o',
      title: group.title,
      url: group.url,
      ...(group.eventType ? { eventType: group.eventType } : {}),
      ...(group.repo ? { repo: group.repo } : {}),
      ...(group.status ? { status: group.status } : {}),
      ...(group.summary ? { summary: group.summary } : {}),
    };
    for (const r of renderings(message))
      expect(r.text.toLowerCase(), `${r.kind}/${r.format}`).not.toContain('ghost');
  });
});
