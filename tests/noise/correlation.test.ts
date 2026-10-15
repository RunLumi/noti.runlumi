import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../../src/env';
import { releaseHeldEvents, type ReleaseDeps } from '../../src/pipeline/noise-release';
import { DEFAULT_NOISE, type NoiseSettings } from '../../src/routing/noise';
import {
  comment,
  count,
  createHarness,
  heldRows,
  insertIntegration,
  outboxMessages,
  postGithub,
  setNow,
  type Harness,
  postGithubWithId,
} from './harness';

/**
 * F193 for held events (ADR 0046). A held event stores no ingress correlation id, so a released
 * notification gets a fresh one, and links back to the held rows through the ledger's own ids:
 * `held_events.id` is the originating event's delivery id (equal to the released notification's id
 * for a lone event), and `held_events.released_in` names the notification that covered each row.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const settings = (over: Partial<NoiseSettings>): NoiseSettings => ({ ...DEFAULT_NOISE, ...over });
const quiet = settings({ timezone: 'Asia/Ho_Chi_Minh', quietHours: { start: '22:00', end: '08:00' } });
const grouped = settings({ groupWindowSec: 300 });
const NIGHT = '2026-10-14T16:00:00Z';
const MORNING = '2026-10-15T01:05:00Z';

let h: Harness;
let tokens = 0;
const clock = (iso: string): ReleaseDeps => ({
  now: () => Date.parse(iso),
  token: () => `token-${++tokens}`,
});

beforeEach(() => {
  h = createHarness();
  tokens = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function deliveries(): { id: string; correlation_id: string | null }[] {
  return h.db.raw.prepare('SELECT id, correlation_id FROM deliveries ORDER BY id').all() as {
    id: string;
    correlation_id: string | null;
  }[];
}

describe('a held event that is released', () => {
  it('keeps no ingress correlation id on the held row (a column would need a migration; ADR 0046)', () => {
    const cols = (
      h.db.raw.prepare("SELECT name FROM pragma_table_info('held_events')").all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).not.toContain('correlation_id');
  });

  it('releases a lone event under its ledger id, with a fresh correlation id that is not the ingress one', async () => {
    insertIntegration(h, 'i1', 'org-a', grouped);
    setNow('2026-10-14T10:00:00Z');
    const ingress = await postGithubWithId(h, 'issue_comment', comment(7), 'gh-1');
    expect(ingress.requestId).toMatch(UUID);
    const [held] = heldRows(h);

    await releaseHeldEvents(h.env, clock('2026-10-14T10:05:00Z'));
    const [delivery] = deliveries();
    // The link back to the originating event, in the ledger: the same id, and the held row names it.
    expect(delivery?.id).toBe(held?.id);
    expect(heldRows(h)[0]?.released_in).toBe(delivery?.id);
    // A fresh id: the ingress request's id is not reused, and the outbox row and the message carry
    // the delivery's id.
    expect(delivery?.correlation_id).toMatch(UUID);
    expect(delivery?.correlation_id).not.toBe(ingress.requestId);
    expect(outboxMessages(h)[0]?.correlationId).toBe(delivery?.correlation_id);
    expect(h.db.raw.prepare('SELECT correlation_id AS c FROM notification_outbox').get()).toEqual({
      c: delivery?.correlation_id,
    });
  });

  it('a combined notification gets one fresh id, and every held row it covers names it as released_in', async () => {
    insertIntegration(h, 'i1', 'org-a', grouped);
    setNow('2026-10-14T10:00:00Z');
    const ingress: string[] = [];
    for (const n of [1, 2, 3]) {
      const r = await postGithubWithId(h, 'issue_comment', comment(7), `gh-${n}`);
      ingress.push(r.requestId);
    }
    await releaseHeldEvents(h.env, clock('2026-10-14T10:05:00Z'));
    const [delivery] = deliveries();
    expect(count(h, 'deliveries')).toBe(1);
    expect(delivery?.correlation_id).toMatch(UUID);
    expect(ingress).not.toContain(delivery?.correlation_id);
    expect(heldRows(h).every((r) => r.state === 'released' && r.released_in === delivery?.id)).toBe(true);
  });

  it('a retry after a failed release mints a new id; the failed attempt logged under the id it used', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    insertIntegration(h, 'i1', 'org-a', quiet);
    setNow(NIGHT);
    await postGithub(h, 'issue_comment', comment(1), 'gh-1');
    const db = h.env.DB;
    let failed = false;
    const flaky = {
      ...h.env,
      DB: {
        prepare: db.prepare.bind(db),
        exec: db.exec.bind(db),
        batch: (statements: D1PreparedStatement[]) => {
          if (!failed) {
            failed = true;
            return Promise.reject(new Error('D1 unavailable'));
          }
          return db.batch(statements);
        },
      } as unknown as D1Database,
    } as Bindings;

    await expect(releaseHeldEvents(flaky, clock(MORNING))).rejects.toThrow(/noise release failed/);
    const failedLines = (errors.mock.calls as unknown[][])
      .map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)
      .filter((l) => l.msg === 'noise_release_failed');
    expect(failedLines).toHaveLength(1);
    const failedId = failedLines[0]?.correlation_id;
    expect(failedId).toMatch(UUID);
    expect(failedLines[0]).toHaveProperty('delivery_id');
    expect(count(h, 'deliveries')).toBe(0);

    await releaseHeldEvents(flaky, clock('2026-10-15T01:06:10Z'));
    const [delivery] = deliveries();
    expect(delivery?.correlation_id).toMatch(UUID);
    expect(delivery?.correlation_id).not.toBe(failedId);
  });
});
