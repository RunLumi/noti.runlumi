/**
 * Wall-clock arithmetic in an IANA time zone, with no dependency (docs/adr/0016).
 *
 * Everything is derived from `Intl.DateTimeFormat`, which the Workers runtime ships with full
 * time-zone data. The only hard cases are daylight-saving transitions:
 *
 *   - a wall time that does not exist (spring forward) moves forward by the length of the gap,
 *     so "02:30" on the night the clocks skip 02:00-03:00 is 03:30 local;
 *   - a wall time that happens twice (fall back) has two instants; `zonedInstant` is the first,
 *     and `nextLocalClock` considers both, so a schedule neither skips nor fires early.
 *
 * Gaps follow the "compatible" disambiguation of the Temporal proposal. The result is that a
 * scheduled release is never skipped; in a repeated hour a daily time can come round twice that
 * day, which is harmless because an empty digest is never sent (the second one exists only if
 * something arrived in between).
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** A zone name we accept: a region/city shape or `UTC`, accepted by the runtime. */
const ZONE_SHAPE = /^(?:UTC|[A-Za-z][A-Za-z_]{1,30}(?:\/[A-Za-z0-9_+-]{1,40}){1,2})$/;

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64 || !ZONE_SHAPE.test(value)) return false;
  try {
    formatter(value).format(0);
    return true;
  } catch {
    return false;
  }
}

export interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

export function localParts(ms: number, timeZone: string): LocalParts {
  const out: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(ms)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    year: out.year ?? 0,
    month: out.month ?? 0,
    day: out.day ?? 0,
    // `h23` yields 0-23, but guard the historical "24" some engines emit at midnight.
    hour: (out.hour ?? 0) % 24,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  };
}

/** Offset of the zone from UTC, in milliseconds, at the instant `ms`. */
export function offsetMs(ms: number, timeZone: string): number {
  const p = localParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

export function minutesOfDay(ms: number, timeZone: string): number {
  const p = localParts(ms, timeZone);
  return p.hour * 60 + p.minute;
}

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `"08:30"` to minutes since local midnight, or null. */
export function parseClock(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = HH_MM.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * Every instant at which `timeZone`'s wall clock reads y-m-d hh:mm, earliest first (see the file
 * header). Normally one; two in the repeated hour of a fall-back change; and in a spring-forward
 * gap the single instant just after the transition. `month` is 1-12; day overflow rolls over.
 */
export function zonedInstants(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number[] {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // Offsets on either side of any transition within a day of the wall time.
  const before = offsetMs(wall - DAY_MS, timeZone);
  const after = offsetMs(wall + DAY_MS, timeZone);
  const valid: number[] = [];
  for (const o of new Set([before, after])) {
    const candidate = wall - o;
    if (offsetMs(candidate, timeZone) === o) valid.push(candidate);
  }
  // None valid is a gap: apply the offset in force before the transition, which lands just after it.
  return valid.length > 0 ? valid.sort((a, b) => a - b) : [wall - before];
}

/** The first instant the wall clock reads y-m-d hh:mm (a gap resolves to just after it). */
export function zonedInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  return (
    zonedInstants(year, month, day, hour, minute, timeZone)[0] ?? Date.UTC(year, month - 1, day, hour, minute)
  );
}

/**
 * The next instant strictly after `afterMs` at which the local clock reads `minutes` (0-1439).
 * In the repeated hour of a fall-back change a wall time occurs twice and BOTH count, so a window
 * that ends at 01:30 ends 20 minutes from 01:10 (second pass), not a day later.
 */
export function nextLocalClock(afterMs: number, minutes: number, timeZone: string): number {
  const today = localParts(afterMs, timeZone);
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  for (let add = 0; add <= 2; add++) {
    const next = zonedInstants(today.year, today.month, today.day + add, hour, minute, timeZone).find(
      (at) => at > afterMs,
    );
    if (next !== undefined) return next;
  }
  // Unreachable for real zones (a day is never skipped twice); fail forward, never stall.
  return afterMs + DAY_MS;
}

/** The next local top of the hour strictly after `afterMs` (zones with a :30 or :45 offset included). */
export function nextLocalHour(afterMs: number, timeZone: string): number {
  let off = offsetMs(afterMs, timeZone);
  let candidate = Math.floor((afterMs + off) / HOUR_MS) * HOUR_MS + HOUR_MS - off;
  // A transition inside the hour changes the offset; settle on the new one once.
  const settled = offsetMs(candidate, timeZone);
  if (settled !== off) {
    off = settled;
    candidate = Math.floor((afterMs + off) / HOUR_MS) * HOUR_MS + HOUR_MS - off;
    if (candidate <= afterMs) candidate += HOUR_MS;
  }
  return candidate;
}

/** Whether local minute-of-day `m` is inside [start, end), where the window may wrap midnight. */
export function inWindow(m: number, start: number, end: number): boolean {
  return start < end ? m >= start && m < end : m >= start || m < end;
}
