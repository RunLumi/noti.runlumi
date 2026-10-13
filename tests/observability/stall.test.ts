import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sqliteTimestamp } from '../../src/delivery/claim';
import {
  CLAIM_STALL_MS,
  decideStall,
  detectStalls,
  OUTBOX_STALL_MS,
  QUIET,
  RENOTIFY_MS,
  RETRY_OVERDUE_MS,
  type StallCounts,
} from '../../src/observability/stall';
import { createFakeD1, seedOrganization, type FakeD1 } from '../support/d1';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const NONE: StallCounts = { outboxPending: 0, claimedStale: 0, retryOverdue: 0 };
let db: FakeD1;

function outbox(id: string, state: string, ageMs: number, notBefore: number | null = null): void {
  db.raw
    .prepare(
      'INSERT INTO notification_outbox(id,payload_json,state,organization_id,created_at,not_before) VALUES(?,?,?,?,?,?)',
    )
    .run(id, '{}', state, 'org-a', sqliteTimestamp(NOW - ageMs), notBefore);
}

function delivery(id: string, state: string, claimedAt: number | null, nextAt: number | null): void {
  db.raw
    .prepare(
      `INSERT INTO deliveries(id,integration_id,organization_id,state,claimed_at,next_attempt_at,created_at)
       VALUES(?,?,?,?,?,?,?)`,
    )
    .run(id, 'i', 'org-a', state, claimedAt, nextAt, sqliteTimestamp(NOW - 86_400_000));
}

beforeEach(() => {
  db = createFakeD1();
  seedOrganization(db.raw, 'org-a');
});
afterEach(() => vi.restoreAllMocks());

describe('decideStall (pure)', () => {
  it('stays quiet when healthy and was healthy', () => {
    expect(decideStall(NONE, QUIET, NOW)).toEqual({ action: 'none', next: QUIET });
  });

  it('raises on entry', () => {
    const d = decideStall({ ...NONE, outboxPending: 2 }, QUIET, NOW);
    expect(d.action).toBe('raise');
    expect(d.next).toEqual({ firing: true, since: NOW, notifiedAt: NOW });
  });

  it('does not repeat before the re-notify interval, then repeats once', () => {
    const counts = { ...NONE, claimedStale: 1 };
    const first = decideStall(counts, QUIET, NOW);
    const soon = decideStall(counts, first.next, NOW + RENOTIFY_MS - 1);
    expect(soon.action).toBe('none');
    expect(soon.next.notifiedAt).toBe(NOW);
    const later = decideStall(counts, soon.next, NOW + RENOTIFY_MS);
    expect(later.action).toBe('renotify');
    expect(later.next).toMatchObject({ since: NOW, notifiedAt: NOW + RENOTIFY_MS });
  });

  it('logs recovery once and resets', () => {
    const firing = decideStall({ ...NONE, retryOverdue: 1 }, QUIET, NOW).next;
    const rec = decideStall(NONE, firing, NOW + 1);
    expect(rec).toEqual({ action: 'recover', next: QUIET });
    expect(decideStall(NONE, rec.next, NOW + 2).action).toBe('none');
  });
});

describe('detectStalls (cron hook)', () => {
  function spies() {
    return {
      warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      info: vi.spyOn(console, 'info').mockImplementation(() => undefined),
    };
  }

  it('is silent on a healthy system and writes no state', async () => {
    const s = spies();
    outbox('fresh', 'pending', OUTBOX_STALL_MS - 1000);
    delivery('d-ok', 'claimed', NOW - 1000, null);
    expect(await detectStalls({ DB: db.d1 }, NOW)).toBe('none');
    expect(s.warn).not.toHaveBeenCalled();
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM ops_state').get()).toEqual({ n: 0 });
  });

  it('warns once per stall with counts only, then stays quiet on later ticks', async () => {
    const s = spies();
    outbox('stuck', 'pending', OUTBOX_STALL_MS + 1000);
    delivery('d-stale', 'claimed', NOW - CLAIM_STALL_MS - 1000, null);
    delivery('d-late', 'retrying', null, NOW - RETRY_OVERDUE_MS - 1000);
    const env = { DB: db.d1 };
    expect(await detectStalls(env, NOW)).toBe('raise');
    expect(await detectStalls(env, NOW + 60_000)).toBe('none');
    expect(await detectStalls(env, NOW + 120_000)).toBe('none');
    expect(s.warn).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(s.warn.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(line).toMatchObject({
      msg: 'delivery_stall',
      level: 'warn',
      outbox_pending_over_threshold: 1,
      claimed_stale: 1,
      retry_overdue: 1,
    });
    // Counts only: no ids, payloads or tenant identifiers.
    const text = JSON.stringify(line);
    expect(text).not.toContain('stuck');
    expect(text).not.toContain('org-a');
  });

  it('re-notifies after the interval and logs recovery when the backlog clears', async () => {
    const s = spies();
    outbox('stuck', 'pending', OUTBOX_STALL_MS + 1000);
    const env = { DB: db.d1 };
    expect(await detectStalls(env, NOW)).toBe('raise');
    expect(await detectStalls(env, NOW + RENOTIFY_MS)).toBe('renotify');
    db.raw.prepare("UPDATE notification_outbox SET state='dispatched'").run();
    expect(await detectStalls(env, NOW + RENOTIFY_MS + 60_000)).toBe('recover');
    expect(await detectStalls(env, NOW + RENOTIFY_MS + 120_000)).toBe('none');
    expect(s.warn).toHaveBeenCalledTimes(2);
    expect(s.info).toHaveBeenCalledTimes(1);
  });

  it('ignores a parked outbox row that is not yet due', async () => {
    outbox('parked', 'pending', OUTBOX_STALL_MS + 1000, NOW + 10 * 60_000);
    expect(await detectStalls({ DB: db.d1 }, NOW)).toBe('none');
  });

  it('survives a corrupt state row by treating it as quiet', async () => {
    db.raw.prepare("INSERT INTO ops_state(key,value,updated_at) VALUES('stall_detector','not json',1)").run();
    outbox('stuck', 'pending', OUTBOX_STALL_MS + 1000);
    expect(await detectStalls({ DB: db.d1 }, NOW)).toBe('raise');
  });
});
