import { describe, expect, it } from 'vitest';
import {
  inWindow,
  isValidTimeZone,
  minutesOfDay,
  nextLocalClock,
  nextLocalHour,
  offsetMs,
  parseClock,
  zonedInstant,
  zonedInstants,
} from '../../src/routing/noise-time';

const utc = (iso: string): number => Date.parse(iso);
const iso = (ms: number): string => new Date(ms).toISOString();
const NY = 'America/New_York';

describe('isValidTimeZone', () => {
  it.each(['UTC', 'Asia/Ho_Chi_Minh', 'America/New_York', 'America/Argentina/Buenos_Aires', 'Etc/GMT+5'])(
    'accepts %s',
    (zone) => expect(isValidTimeZone(zone)).toBe(true),
  );
  it.each([
    '',
    'utc',
    'Mars/Phobos',
    '+05:00',
    ' Asia/Tokyo',
    'Asia/Tokyo ',
    'Asia//Tokyo',
    'x'.repeat(70),
    'Asia/Tokyo; DROP',
    5,
    null,
    undefined,
  ])('rejects %j', (zone) => expect(isValidTimeZone(zone)).toBe(false));
});

describe('parseClock', () => {
  it.each([
    ['00:00', 0],
    ['08:30', 510],
    ['23:59', 1439],
  ])('parses %s', (text, minutes) => expect(parseClock(text)).toBe(minutes));
  it.each(['24:00', '8:30', '08:60', '0830', '', 'ab:cd', 830, null])('rejects %j', (v) =>
    expect(parseClock(v)).toBeNull(),
  );
});

describe('inWindow', () => {
  it.each([
    // [minute, start, end, expected]; the start is inclusive and the end is exclusive.
    [22 * 60, 22 * 60, 8 * 60, true],
    [22 * 60 - 1, 22 * 60, 8 * 60, false],
    [8 * 60 - 1, 22 * 60, 8 * 60, true],
    [8 * 60, 22 * 60, 8 * 60, false],
    [0, 22 * 60, 8 * 60, true],
    [12 * 60, 22 * 60, 8 * 60, false],
    [13 * 60, 13 * 60, 14 * 60, true],
    [14 * 60, 13 * 60, 14 * 60, false],
  ])('minute %i in [%i,%i) is %s', (m, start, end, expected) =>
    expect(inWindow(m, start, end)).toBe(expected),
  );
});

describe('offsets and local clock', () => {
  it('reads offsets across a daylight-saving change', () => {
    expect(offsetMs(utc('2026-03-08T06:59:00Z'), NY)).toBe(-5 * 3_600_000);
    expect(offsetMs(utc('2026-03-08T07:00:00Z'), NY)).toBe(-4 * 3_600_000);
    expect(offsetMs(utc('2026-10-14T00:00:00Z'), 'Asia/Kolkata')).toBe(5.5 * 3_600_000);
    expect(minutesOfDay(utc('2026-10-14T00:00:00Z'), 'Asia/Ho_Chi_Minh')).toBe(7 * 60);
  });
});

describe('zonedInstant (daylight-saving gaps and overlaps)', () => {
  it.each([
    // A wall time that does not exist moves forward by the gap: 02:30 is 03:30 EDT.
    ['spring-forward gap', NY, [2026, 3, 8, 2, 30], '2026-03-08T07:30:00.000Z'],
    // A wall time that happens twice means its FIRST occurrence (EDT).
    ['fall-back overlap', NY, [2026, 11, 1, 1, 30], '2026-11-01T05:30:00.000Z'],
    ['ordinary winter time', NY, [2026, 1, 15, 8, 0], '2026-01-15T13:00:00.000Z'],
    ['ordinary summer time', NY, [2026, 7, 15, 8, 0], '2026-07-15T12:00:00.000Z'],
    ['London overlap', 'Europe/London', [2026, 10, 25, 1, 30], '2026-10-25T00:30:00.000Z'],
    ['London gap', 'Europe/London', [2026, 3, 29, 1, 30], '2026-03-29T01:30:00.000Z'],
    ['no daylight saving', 'Asia/Ho_Chi_Minh', [2026, 10, 14, 8, 0], '2026-10-14T01:00:00.000Z'],
    ['half-hour offset', 'Asia/Kolkata', [2026, 10, 14, 8, 0], '2026-10-14T02:30:00.000Z'],
    ['quarter-hour offset', 'Asia/Kathmandu', [2026, 10, 14, 8, 0], '2026-10-14T02:15:00.000Z'],
    ['+14 offset', 'Pacific/Kiritimati', [2026, 10, 14, 8, 0], '2026-10-13T18:00:00.000Z'],
    ['day overflow rolls over', 'UTC', [2026, 12, 31, 24, 0], '2027-01-01T00:00:00.000Z'],
  ] as const)('%s', (_name, zone, [y, mo, d, h, mi], expected) =>
    expect(iso(zonedInstant(y, mo, d, h, mi, zone))).toBe(expected),
  );

  it('lands on the requested wall time, or one hour later when that time does not exist', () => {
    // Every five minutes of the spring-forward day and the day after, in New York.
    for (const day of [8, 9]) {
      for (let minute = 0; minute < 24 * 60; minute += 5) {
        const at = zonedInstant(2026, 3, day, Math.floor(minute / 60), minute % 60, NY);
        const local = minutesOfDay(at, NY);
        const inGap = day === 8 && minute >= 120 && minute < 180;
        expect(local).toBe(inGap ? minute + 60 : minute);
      }
    }
  });
});

describe('zonedInstants', () => {
  it('has two instants in a repeated hour, one normally, and one just after a gap', () => {
    expect(zonedInstants(2026, 11, 1, 1, 30, NY).map(iso)).toEqual([
      '2026-11-01T05:30:00.000Z',
      '2026-11-01T06:30:00.000Z',
    ]);
    expect(zonedInstants(2026, 7, 15, 8, 0, NY).map(iso)).toEqual(['2026-07-15T12:00:00.000Z']);
    expect(zonedInstants(2026, 3, 8, 2, 30, NY).map(iso)).toEqual(['2026-03-08T07:30:00.000Z']);
  });
});

describe('nextLocalClock', () => {
  it.each([
    ['same day, before the time', NY, '2026-03-07T12:00:00Z', 8 * 60, '2026-03-07T13:00:00.000Z'],
    [
      'rolls to tomorrow when the time has passed',
      NY,
      '2026-03-07T14:00:00Z',
      8 * 60,
      '2026-03-08T12:00:00.000Z',
    ],
    [
      'strictly after: exactly at the time is tomorrow',
      NY,
      '2026-03-07T13:00:00Z',
      8 * 60,
      '2026-03-08T12:00:00.000Z',
    ],
    [
      'on the spring-forward day it is 08:00 EDT, not EST',
      NY,
      '2026-03-08T05:00:00Z',
      8 * 60,
      '2026-03-08T12:00:00.000Z',
    ],
    ['across spring forward overnight', NY, '2026-03-08T00:00:00Z', 2 * 60 + 30, '2026-03-08T07:30:00.000Z'],
    ['fall back day first occurrence', NY, '2026-11-01T04:00:00Z', 90, '2026-11-01T05:30:00.000Z'],
    ['Ho Chi Minh', 'Asia/Ho_Chi_Minh', '2026-10-14T00:00:00Z', 8 * 60, '2026-10-14T01:00:00.000Z'],
    [
      'Ho Chi Minh after 08:00',
      'Asia/Ho_Chi_Minh',
      '2026-10-14T02:00:00Z',
      8 * 60,
      '2026-10-15T01:00:00.000Z',
    ],
    ['UTC midnight', 'UTC', '2026-10-14T23:59:59Z', 0, '2026-10-15T00:00:00.000Z'],
    ['year end', 'UTC', '2026-12-31T23:30:00Z', 60, '2027-01-01T01:00:00.000Z'],
    ['leap day', 'UTC', '2028-02-28T12:00:00Z', 60, '2028-02-29T01:00:00.000Z'],
  ] as const)('%s', (_name, zone, after, minutes, expected) =>
    expect(iso(nextLocalClock(utc(after), minutes, zone))).toBe(expected),
  );
});

describe('nextLocalHour', () => {
  it.each([
    ['UTC', 'UTC', '2026-10-14T10:10:00Z', '2026-10-14T11:00:00.000Z'],
    ['exactly on the hour moves to the next', 'UTC', '2026-10-14T10:00:00Z', '2026-10-14T11:00:00.000Z'],
    ['half-hour zone', 'Asia/Kolkata', '2026-10-14T00:10:00Z', '2026-10-14T00:30:00.000Z'],
    ['quarter-hour zone', 'Asia/Kathmandu', '2026-10-14T00:00:00Z', '2026-10-14T00:15:00.000Z'],
    ['New York before spring forward', NY, '2026-03-08T06:10:00Z', '2026-03-08T07:00:00.000Z'],
    ['New York after spring forward', NY, '2026-03-08T07:10:00Z', '2026-03-08T08:00:00.000Z'],
    ['New York fall back', NY, '2026-11-01T05:10:00Z', '2026-11-01T06:00:00.000Z'],
  ] as const)('%s', (_name, zone, after, expected) =>
    expect(iso(nextLocalHour(utc(after), zone))).toBe(expected),
  );

  it('always advances, and by at most an hour plus a transition, over a year of New York', () => {
    let at = utc('2026-01-01T00:00:00Z');
    for (let i = 0; i < 24 * 366; i++) {
      const next = nextLocalHour(at, NY);
      expect(next).toBeGreaterThan(at);
      expect(next - at).toBeLessThanOrEqual(3_600_000);
      expect(Math.abs(offsetMs(next, NY) % 3_600_000)).toBe(0);
      expect(minutesOfDay(next, NY) % 60).toBe(0);
      at = next;
    }
  });
});
