import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOISE,
  HELD_CAPACITY,
  decideNoise,
  groupKeyOf,
  inQuietHours,
  isCritical,
  nextDigestAt,
  parseNoise,
  readStoredNoise,
  serializeNoise,
  type NoiseInput,
  type NoiseSettings,
} from '../../src/routing/noise';

const utc = (iso: string): number => Date.parse(iso);
const iso = (ms: number): string => new Date(ms).toISOString();

const HCM = 'Asia/Ho_Chi_Minh';
const NY = 'America/New_York';

const settings = (over: Partial<NoiseSettings>): NoiseSettings => ({ ...DEFAULT_NOISE, ...over });
const input = (nowMs: number, over: Partial<NoiseInput> = {}): NoiseInput => ({
  critical: false,
  nowMs,
  openGroupReleaseAt: null,
  heldCount: 0,
  ...over,
});

describe('parseNoise', () => {
  it.each([null, undefined, {}, { digest: 'off' }, { groupWindowSec: 0, resolution: false }])(
    'treats %j as "no settings"',
    (value) => expect(parseNoise(value)).toEqual({ ok: true, value: null }),
  );

  it('normalises a full document', () => {
    const r = parseNoise({
      timezone: HCM,
      quietHours: { start: '22:00', end: '08:00' },
      groupWindowSec: 300,
      digest: 'daily',
      digestAt: '09:30',
      resolution: true,
    });
    expect(r).toEqual({
      ok: true,
      value: {
        timezone: HCM,
        quietHours: { start: '22:00', end: '08:00' },
        groupWindowSec: 300,
        digest: 'daily',
        digestAt: '09:30',
        resolution: true,
      },
    });
  });

  it.each([
    ['a non-object', 'quiet', 'noise'],
    ['an array', [], 'noise'],
    ['an unknown key', { cadence: 'fast' }, 'noise.cadence'],
    ['an unknown zone', { timezone: 'Mars/Phobos' }, 'noise.timezone'],
    ['a numeric zone', { timezone: 7 }, 'noise.timezone'],
    ['equal quiet start and end', { quietHours: { start: '08:00', end: '08:00' } }, 'noise.quietHours.end'],
    ['a bad quiet start', { quietHours: { start: '25:00', end: '08:00' } }, 'noise.quietHours.start'],
    ['a bad quiet end', { quietHours: { start: '22:00', end: '8am' } }, 'noise.quietHours.end'],
    ['an extra quiet key', { quietHours: { start: '22:00', end: '08:00', days: 'mon' } }, 'noise.quietHours'],
    ['a window not on the menu', { groupWindowSec: 120 }, 'noise.groupWindowSec'],
    ['a negative window', { groupWindowSec: -60 }, 'noise.groupWindowSec'],
    ['a string window', { groupWindowSec: '300' }, 'noise.groupWindowSec'],
    ['a weekly digest (not built)', { digest: 'weekly' }, 'noise.digest'],
    ['a bad digest time', { digest: 'daily', digestAt: '7' }, 'noise.digestAt'],
    ['a non-boolean resolution', { resolution: 'yes' }, 'noise.resolution'],
  ])('rejects %s', (_name, value, field) => {
    const r = parseNoise(value);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.field)).toContain(field);
  });

  it('never echoes input in a message', () => {
    const typed = 'unlikely-typed-value';
    const r = parseNoise({ timezone: typed, digest: typed, digestAt: typed });
    expect(JSON.stringify(r)).not.toContain(typed);
  });
});

describe('stored document', () => {
  it('round-trips every document serialize can produce', () => {
    const docs: NoiseSettings[] = [
      settings({ quietHours: { start: '22:00', end: '08:00' }, timezone: HCM }),
      settings({ groupWindowSec: 3600 }),
      settings({ digest: 'hourly', timezone: NY }),
      settings({ digest: 'daily', digestAt: '23:59', timezone: 'Asia/Kolkata' }),
      settings({ resolution: true }),
    ];
    for (const doc of docs) {
      const json = serializeNoise(doc);
      expect(json).not.toBeNull();
      expect(readStoredNoise(json)).toEqual({ kind: 'ok', settings: doc });
    }
  });

  it('serialises "nothing configured" as null', () => {
    expect(serializeNoise(null)).toBeNull();
    expect(serializeNoise(DEFAULT_NOISE)).toBeNull();
    expect(readStoredNoise(null)).toEqual({ kind: 'none' });
    expect(readStoredNoise('')).toEqual({ kind: 'none' });
  });

  it.each([
    ['not json', '{nope'],
    ['an array', '[]'],
    ['a missing version', JSON.stringify({ timezone: 'UTC', digest: 'hourly' })],
    ['a bad value', JSON.stringify({ v: 1, digest: 'hourly', timezone: 'Mars/Phobos' })],
  ])('reads %s as invalid', (_name, json) => expect(readStoredNoise(json)).toEqual({ kind: 'invalid' }));

  it('reads a document from a newer release as newer, not invalid', () => {
    expect(readStoredNoise(JSON.stringify({ v: 2, anything: true }))).toEqual({ kind: 'newer' });
  });
});

describe('isCritical', () => {
  it.each([
    ['failure', 'workflow_run.failure', true],
    ['failure', undefined, true],
    ['success', 'workflow_run.success', false],
    ['info', 'issues.opened', false],
    ['warning', 'deploy.slow', false],
    [undefined, 'security.advisory', true],
    ['info', 'security_alert', true],
    ['info', 'insecurity.note', false],
    // The sender chooses an event type, so no type string may bypass holds (ADR 0018).
    ['info', 'test', false],
    ['info', 'noti.test', false],
  ])('status %s, type %s -> %s', (status, type, expected) => expect(isCritical(status, type)).toBe(expected));
});

describe('decideNoise: quiet hours (Ho Chi Minh, 22:00-08:00, no daylight saving)', () => {
  const quiet = settings({ timezone: HCM, quietHours: { start: '22:00', end: '08:00' } });
  it.each([
    // Window edges: the start is inclusive, the end is exclusive.
    ['one minute before the window', '2026-10-14T14:59:00Z', 'deliver', undefined],
    ['the first minute of the window', '2026-10-14T15:00:00Z', 'hold', '2026-10-15T01:00:00.000Z'],
    ['midnight', '2026-10-14T17:00:00Z', 'hold', '2026-10-15T01:00:00.000Z'],
    ['the last minute of the window', '2026-10-15T00:59:00Z', 'hold', '2026-10-15T01:00:00.000Z'],
    ['exactly at the end', '2026-10-15T01:00:00Z', 'deliver', undefined],
    ['midday', '2026-10-15T05:00:00Z', 'deliver', undefined],
  ])('%s', (_name, now, action, releaseAt) => {
    const d = decideNoise(quiet, input(utc(now)));
    expect(d.action).toBe(action);
    if (d.action === 'hold') {
      expect(d.reason).toBe('quiet_hours');
      expect(iso(d.releaseAt)).toBe(releaseAt);
    } else {
      expect(d).toEqual({ action: 'deliver', reason: 'no_noise' });
    }
  });

  it('is evaluated in the configured zone, not UTC', () => {
    // 15:30 UTC is inside quiet hours in Ho Chi Minh (22:30) and outside them in New York (11:30).
    const at = utc('2026-10-14T15:30:00Z');
    expect(inQuietHours(quiet, at)).toBe(true);
    expect(inQuietHours({ ...quiet, timezone: NY }, at)).toBe(false);
  });

  it('handles a window that does not wrap midnight', () => {
    const lunch = settings({ timezone: 'UTC', quietHours: { start: '12:00', end: '13:00' } });
    expect(decideNoise(lunch, input(utc('2026-10-14T12:30:00Z')))).toMatchObject({
      action: 'hold',
      releaseAt: utc('2026-10-14T13:00:00Z'),
    });
    expect(decideNoise(lunch, input(utc('2026-10-14T13:00:00Z'))).action).toBe('deliver');
  });
});

describe('decideNoise: quiet hours across daylight-saving changes (New York, 22:00-07:00)', () => {
  const quiet = settings({ timezone: NY, quietHours: { start: '22:00', end: '07:00' } });
  it.each([
    // Spring forward 2026-03-08: the night is an hour short, so 07:00 EDT is 11:00Z, not 12:00Z.
    ['night the clocks go forward', '2026-03-08T05:00:00Z', '2026-03-08T11:00:00.000Z'],
    // Fall back 2026-11-01: the night is an hour long, so 07:00 EST is 12:00Z, not 11:00Z.
    ['night the clocks go back', '2026-11-01T03:00:00Z', '2026-11-01T12:00:00.000Z'],
    ['an ordinary winter night', '2026-01-15T04:00:00Z', '2026-01-15T12:00:00.000Z'],
    ['an ordinary summer night', '2026-07-15T03:00:00Z', '2026-07-15T11:00:00.000Z'],
  ])('%s', (_name, now, expected) => {
    const d = decideNoise(quiet, input(utc(now)));
    expect(d).toMatchObject({ action: 'hold', reason: 'quiet_hours' });
    if (d.action === 'hold') expect(iso(d.releaseAt)).toBe(expected);
  });
});

describe('decideNoise: a quiet window that ends inside the repeated hour', () => {
  const quiet = settings({ timezone: NY, quietHours: { start: '22:00', end: '01:30' } });
  it.each([
    // First pass (EDT) and second pass (EST) of the repeated 01:00-02:00 hour on 2026-11-01.
    ['01:10 the first time', '2026-11-01T05:10:00Z', '2026-11-01T05:30:00.000Z'],
    ['01:10 the second time', '2026-11-01T06:10:00Z', '2026-11-01T06:30:00.000Z'],
    ['the first minute of the window', '2026-11-01T02:00:00Z', '2026-11-01T05:30:00.000Z'],
  ])('%s', (_name, now, expected) => {
    const d = decideNoise(quiet, input(utc(now)));
    expect(d).toMatchObject({ action: 'hold', reason: 'quiet_hours' });
    // The delay is minutes, never a day.
    if (d.action === 'hold') {
      expect(iso(d.releaseAt)).toBe(expected);
      expect(d.releaseAt - utc(now)).toBeLessThan(4 * 3_600_000);
    }
  });
});

describe('decideNoise: critical events bypass every hold', () => {
  const everything = settings({
    timezone: HCM,
    quietHours: { start: '22:00', end: '08:00' },
    digest: 'daily',
    groupWindowSec: 900,
  });
  it.each(['2026-10-14T16:00:00Z', '2026-10-15T05:00:00Z'])('delivers a critical event at %s', (now) =>
    expect(decideNoise(everything, input(utc(now), { critical: true }))).toEqual({
      action: 'deliver',
      reason: 'critical_bypass',
    }),
  );
  it('bypasses even a full backlog and an open group', () => {
    expect(
      decideNoise(
        everything,
        input(utc('2026-10-14T16:00:00Z'), {
          critical: true,
          heldCount: HELD_CAPACITY,
          openGroupReleaseAt: utc('2026-10-14T17:00:00Z'),
        }),
      ),
    ).toEqual({ action: 'deliver', reason: 'critical_bypass' });
  });
  it('does not claim a bypass when nothing could have held it', () => {
    expect(
      decideNoise(settings({ resolution: true }), input(utc('2026-10-14T16:00:00Z'), { critical: true })),
    ).toEqual({ action: 'deliver', reason: 'no_noise' });
  });
});

describe('decideNoise: digests', () => {
  it.each([
    // Daily 08:00 in Ho Chi Minh (01:00Z).
    ['daily, before the time', 'daily', '2026-10-14T00:00:00Z', '2026-10-14T01:00:00.000Z'],
    ['daily, after the time', 'daily', '2026-10-14T05:00:00Z', '2026-10-15T01:00:00.000Z'],
    ['daily, exactly at the time', 'daily', '2026-10-14T01:00:00Z', '2026-10-15T01:00:00.000Z'],
    ['hourly', 'hourly', '2026-10-14T05:20:00Z', '2026-10-14T06:00:00.000Z'],
  ] as const)('%s', (_name, digest, now, expected) => {
    const d = decideNoise(settings({ timezone: HCM, digest }), input(utc(now)));
    expect(d).toMatchObject({ action: 'hold', reason: 'digest' });
    if (d.action === 'hold') expect(iso(d.releaseAt)).toBe(expected);
  });

  it('moves a boundary that falls inside quiet hours to the end of quiet hours', () => {
    const s = settings({
      timezone: HCM,
      digest: 'daily',
      digestAt: '23:00',
      quietHours: { start: '22:00', end: '08:00' },
    });
    // 10:00 local: the next 23:00 boundary is inside quiet hours, so the digest waits until 08:00.
    expect(iso(nextDigestAt(s, utc('2026-10-14T03:00:00Z')) ?? 0)).toBe('2026-10-15T01:00:00.000Z');
    const hourly = settings({
      timezone: HCM,
      digest: 'hourly',
      quietHours: { start: '22:00', end: '08:00' },
    });
    // 21:30 local: the 22:00 boundary is inside quiet hours.
    expect(iso(nextDigestAt(hourly, utc('2026-10-14T14:30:00Z')) ?? 0)).toBe('2026-10-15T01:00:00.000Z');
  });

  it('during quiet hours holds until the later of the quiet end and the next digest', () => {
    const s = settings({
      timezone: HCM,
      digest: 'daily',
      digestAt: '09:00',
      quietHours: { start: '22:00', end: '08:00' },
    });
    // 23:00 local: quiet ends 08:00 but the digest is at 09:00: hold to 09:00, reason quiet_hours.
    const d = decideNoise(s, input(utc('2026-10-14T16:00:00Z')));
    expect(d).toMatchObject({ action: 'hold', reason: 'quiet_hours' });
    if (d.action === 'hold') expect(iso(d.releaseAt)).toBe('2026-10-15T02:00:00.000Z');
  });

  it('returns null when no digest is configured', () => {
    expect(nextDigestAt(settings({}), 0)).toBeNull();
  });
});

describe('decideNoise: grouping', () => {
  const grouped = settings({ groupWindowSec: 300, timezone: 'UTC' });
  const now = utc('2026-10-14T10:00:00Z');

  it('opens a group that releases after the window', () => {
    const d = decideNoise(grouped, input(now));
    expect(d).toEqual({ action: 'hold', reason: 'grouped', releaseAt: now + 300_000 });
  });

  it('joins the open group and keeps its release time', () => {
    const open = now + 120_000;
    expect(decideNoise(grouped, input(now, { openGroupReleaseAt: open }))).toEqual({
      action: 'hold',
      reason: 'grouped',
      releaseAt: open,
    });
  });

  it('extends a window that would end inside quiet hours', () => {
    const s = settings({
      groupWindowSec: 3600,
      timezone: 'UTC',
      quietHours: { start: '22:00', end: '08:00' },
    });
    const d = decideNoise(s, input(utc('2026-10-14T21:30:00Z')));
    expect(d).toMatchObject({ action: 'hold', reason: 'grouped' });
    if (d.action === 'hold') expect(iso(d.releaseAt)).toBe('2026-10-15T08:00:00.000Z');
  });

  it('delivers immediately when grouping is off and quiet hours do not apply', () => {
    const s = settings({ timezone: 'UTC', quietHours: { start: '22:00', end: '08:00' } });
    expect(decideNoise(s, input(now))).toEqual({ action: 'deliver', reason: 'no_noise' });
  });
});

describe('decideNoise: bounds and defaults', () => {
  it('delivers when there are no settings or nothing holds', () => {
    expect(decideNoise(null, input(0))).toEqual({ action: 'deliver', reason: 'no_noise' });
    expect(decideNoise(settings({ resolution: true }), input(0))).toEqual({
      action: 'deliver',
      reason: 'no_noise',
    });
  });

  it('falls toward delivering when the backlog is full', () => {
    const s = settings({ groupWindowSec: 60 });
    expect(decideNoise(s, input(0, { heldCount: HELD_CAPACITY - 1 })).action).toBe('hold');
    expect(decideNoise(s, input(0, { heldCount: HELD_CAPACITY }))).toEqual({
      action: 'deliver',
      reason: 'hold_capacity',
    });
  });

  it('a hold always has a release time strictly in the future', () => {
    const every = settings({
      timezone: NY,
      quietHours: { start: '22:00', end: '07:00' },
      digest: 'hourly',
      groupWindowSec: 3600,
    });
    for (let h = 0; h < 24 * 14; h++) {
      const now = utc('2026-03-01T00:00:00Z') + h * 3_600_000 + 17 * 60_000;
      const d = decideNoise(every, input(now));
      if (d.action === 'hold') expect(d.releaseAt).toBeGreaterThan(now);
    }
  });
});

describe('groupKeyOf', () => {
  const base = {
    organizationId: 'org-a',
    integrationId: 'int-1',
    eventType: 'issue_comment.created',
    repo: 'acme/web',
    subject: '#7',
  };

  it('is a fixed-length hex digest', async () => {
    expect(await groupKeyOf(base)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is stable for the same fields', async () => {
    expect(await groupKeyOf(base)).toBe(await groupKeyOf({ ...base }));
  });

  it.each([
    ['organization', { organizationId: 'org-b' }],
    ['integration (destination)', { integrationId: 'int-2' }],
    ['event type', { eventType: 'pull_request.opened' }],
    ['repository', { repo: 'acme/api' }],
    ['pull request or issue', { subject: '#8' }],
    ['branch', { subject: 'branch:main' }],
    ['workflow run', { subject: 'run:99' }],
  ])('never spans a different %s', async (_name, change) => {
    expect(await groupKeyOf({ ...base, ...change })).not.toBe(await groupKeyOf(base));
  });

  it('cannot be forged by moving a separator between fields', async () => {
    const a = await groupKeyOf({ ...base, repo: 'acme/web', subject: '#7' });
    const b = await groupKeyOf({ ...base, repo: 'acme/web|1:#', subject: '7' });
    const c = await groupKeyOf({ ...base, repo: 'acme/we', subject: 'b#7' });
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
