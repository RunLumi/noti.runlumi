import { asRecord } from '../lib/json';
import {
  inWindow,
  isValidTimeZone,
  minutesOfDay,
  nextLocalClock,
  nextLocalHour,
  parseClock,
} from './noise-time';

/**
 * Per-integration noise settings and the pure decision about one event
 * (docs/adr/0016-noise-control.md, docs/specs/11-grouping-and-noise.md F141-F146, F152).
 *
 * Nothing here does I/O or reads a clock: ingress passes `nowMs` and what it read from D1, and
 * the decision is a total function of those. The invariant the whole slice rests on is that a
 * decision is `deliver` or `hold`, never `drop`: a held event always has a release time.
 */

export const NOISE_VERSION = 1;
export const NOISE_MAX_BYTES = 2048;

/** The four labelled choices of F142 ("Off / 1 min / 5 min / 15 min / 1 hour"), in seconds. */
export const GROUP_WINDOWS = [0, 60, 300, 900, 3600] as const;
export type GroupWindow = (typeof GROUP_WINDOWS)[number];

export const DIGEST_MODES = ['off', 'hourly', 'daily'] as const;
export type DigestMode = (typeof DIGEST_MODES)[number];

export interface NoiseSettings {
  /** IANA zone. Quiet hours, the daily digest time and the hourly boundary are all local to it. */
  readonly timezone: string;
  /** Local window during which non-critical updates are held. May wrap midnight. */
  readonly quietHours: { readonly start: string; readonly end: string } | null;
  /** 0 = off. Otherwise: wait this long, then send what arrived as one notification. */
  readonly groupWindowSec: GroupWindow;
  readonly digest: DigestMode;
  /** Local `HH:MM`, used by the daily digest. */
  readonly digestAt: string;
  /** Send a "resolved" notice when a failing workflow succeeds again (GitHub only). */
  readonly resolution: boolean;
}

export const DEFAULT_NOISE: NoiseSettings = {
  timezone: 'UTC',
  quietHours: null,
  groupWindowSec: 0,
  digest: 'off',
  digestAt: '08:00',
  resolution: false,
};

export interface NoiseIssue {
  readonly field: string;
  readonly message: string;
}
export type NoiseParse =
  | { readonly ok: true; readonly value: NoiseSettings | null }
  | { readonly ok: false; readonly errors: NoiseIssue[] };

const ALLOWED = new Set(['timezone', 'quietHours', 'groupWindowSec', 'digest', 'digestAt', 'resolution']);

/** Whether the settings change anything at all. */
export function isActive(s: NoiseSettings): boolean {
  return s.quietHours !== null || s.groupWindowSec > 0 || s.digest !== 'off' || s.resolution;
}

/** Whether any setting can HOLD an update (resolution only adds a notice). */
export function holdsUpdates(s: NoiseSettings): boolean {
  return s.quietHours !== null || s.groupWindowSec > 0 || s.digest !== 'off';
}

/**
 * Validate a client document (`noise` in the API). `null`, `undefined` and `{}` mean "none".
 * Messages name the field and the rule and never echo input.
 */
export function parseNoise(value: unknown, path = 'noise'): NoiseParse {
  if (value === null || value === undefined) return { ok: true, value: null };
  const r = asRecord(value);
  if (!r) return { ok: false, errors: [{ field: path, message: 'Expected an object.' }] };
  const errors: NoiseIssue[] = [];
  for (const key of Object.keys(r))
    if (!ALLOWED.has(key)) errors.push({ field: `${path}.${key}`, message: 'This setting does not exist.' });

  let timezone = DEFAULT_NOISE.timezone;
  if (r.timezone !== undefined) {
    if (isValidTimeZone(r.timezone)) timezone = r.timezone;
    else errors.push({ field: `${path}.timezone`, message: 'Choose a time zone such as Asia/Ho_Chi_Minh.' });
  }

  let quietHours: NoiseSettings['quietHours'] = null;
  if (r.quietHours !== undefined && r.quietHours !== null) {
    const q = asRecord(r.quietHours);
    const start = q ? parseClock(q.start) : null;
    const end = q ? parseClock(q.end) : null;
    if (!q || Object.keys(q).some((k) => k !== 'start' && k !== 'end')) {
      errors.push({ field: `${path}.quietHours`, message: 'Use a start and an end time.' });
    } else if (start === null) {
      errors.push({ field: `${path}.quietHours.start`, message: 'Use a time like 22:00.' });
    } else if (end === null) {
      errors.push({ field: `${path}.quietHours.end`, message: 'Use a time like 08:00.' });
    } else if (start === end) {
      errors.push({
        field: `${path}.quietHours.end`,
        message: 'Start and end must differ; equal times would hold every update.',
      });
    } else {
      quietHours = { start: q?.start as string, end: q?.end as string };
    }
  }

  let groupWindowSec: GroupWindow = 0;
  if (r.groupWindowSec !== undefined) {
    const found = GROUP_WINDOWS.find((w) => w === r.groupWindowSec);
    if (found === undefined)
      errors.push({
        field: `${path}.groupWindowSec`,
        message: `Choose one of ${GROUP_WINDOWS.join(', ')} seconds.`,
      });
    else groupWindowSec = found;
  }

  let digest: DigestMode = 'off';
  if (r.digest !== undefined) {
    const found = DIGEST_MODES.find((m) => m === r.digest);
    if (found === undefined)
      errors.push({ field: `${path}.digest`, message: `Choose one of ${DIGEST_MODES.join(', ')}.` });
    else digest = found;
  }

  let digestAt = DEFAULT_NOISE.digestAt;
  if (r.digestAt !== undefined) {
    if (parseClock(r.digestAt) === null)
      errors.push({ field: `${path}.digestAt`, message: 'Use a time like 08:00.' });
    else digestAt = r.digestAt as string;
  }

  let resolution = false;
  if (r.resolution !== undefined) {
    if (typeof r.resolution === 'boolean') resolution = r.resolution;
    else errors.push({ field: `${path}.resolution`, message: 'Must be true or false.' });
  }

  if (errors.length > 0) return { ok: false, errors };
  const settings: NoiseSettings = { timezone, quietHours, groupWindowSec, digest, digestAt, resolution };
  return { ok: true, value: isActive(settings) ? settings : null };
}

/**
 * Resolved notices need the integration to follow failing workflow runs: without
 * `workflow_run.failure` or `.timed_out` there is never a failure to resolve, so the setting
 * would silently do nothing (ADR 0016). Refused at save time, like an unenforceable filter.
 * Shared with the dashboard so the form and the API give the same answer.
 */
export function noiseCoverageIssue(
  noise: NoiseSettings | null,
  eventTypes: readonly string[],
): NoiseIssue | null {
  if (!noise?.resolution) return null;
  if (eventTypes.includes('workflow_run.failure') || eventTypes.includes('workflow_run.timed_out'))
    return null;
  return {
    field: 'noise.resolution',
    message: 'Resolved notices need "workflow run failed" or "timed out" among the selected updates.',
  };
}

/** The stored form; `null` (the column default) when nothing is configured. */
export function serializeNoise(s: NoiseSettings | null): string | null {
  return s && isActive(s) ? JSON.stringify({ v: NOISE_VERSION, ...s }) : null;
}

export type StoredNoise =
  | { readonly kind: 'none' }
  | { readonly kind: 'ok'; readonly settings: NoiseSettings }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'newer' };

/**
 * Re-validate a stored document. Unlike routing filters (which fail closed because a deny rule
 * may be a privacy control), noise settings only DELAY updates, so an unusable document fails
 * OPEN: ingress delivers normally and the API reports `noiseInvalid`/`noiseNewer`. Delivering
 * is the direction that cannot lose an alert.
 */
export function readStoredNoise(json: string | null): StoredNoise {
  if (json === null || json === '') return { kind: 'none' };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { kind: 'invalid' };
  }
  const r = asRecord(raw);
  if (!r) return { kind: 'invalid' };
  if (typeof r.v === 'number' && Number.isInteger(r.v) && r.v > NOISE_VERSION) return { kind: 'newer' };
  if (r.v !== NOISE_VERSION) return { kind: 'invalid' };
  const { v: _version, ...rest } = r;
  const parsed = parseNoise(rest);
  if (!parsed.ok) return { kind: 'invalid' };
  return parsed.value ? { kind: 'ok', settings: parsed.value } : { kind: 'none' };
}

// --- the decision -----------------------------------------------------------------------------

/** Per-integration cap on events waiting to be released. Beyond it new events are delivered. */
export const HELD_CAPACITY = 500;

/**
 * Critical updates bypass quiet hours, digests and grouping (F146, F148). Derived from the
 * canonical status the source mapped (never from a free-form payload field), so a failed
 * workflow, a generic `error`/`critical` event and a provider failure all qualify. No security
 * event type is subscribable yet; the prefix rule is here so that the first one that is cannot
 * be held by accident.
 */
export function isCritical(status: string | undefined, eventType: string | undefined): boolean {
  return status === 'failure' || (eventType !== undefined && /^security[._]/.test(eventType));
}

export type HoldReason = 'quiet_hours' | 'digest' | 'grouped';
export type DeliverReason = 'no_noise' | 'critical_bypass' | 'hold_capacity';

export type NoiseDecision =
  | { readonly action: 'deliver'; readonly reason: DeliverReason }
  | { readonly action: 'hold'; readonly reason: HoldReason; readonly releaseAt: number };

export interface NoiseInput {
  readonly critical: boolean;
  readonly nowMs: number;
  /** Earliest release time of a still-held group row with this event's group key, if any. */
  readonly openGroupReleaseAt: number | null;
  /** Events currently waiting for this integration. */
  readonly heldCount: number;
}

function quietEnd(s: NoiseSettings, atMs: number): number | null {
  if (!s.quietHours) return null;
  const start = parseClock(s.quietHours.start);
  const end = parseClock(s.quietHours.end);
  if (start === null || end === null) return null;
  if (!inWindow(minutesOfDay(atMs, s.timezone), start, end)) return null;
  return nextLocalClock(atMs, end, s.timezone);
}

/** If `releaseAt` would land inside quiet hours, move it to the end of that window. */
function outOfQuiet(s: NoiseSettings, releaseAt: number): number {
  // One step is enough: the end of a window is outside it. Re-check once for a DST oddity.
  let at = releaseAt;
  for (let i = 0; i < 2; i++) {
    const end = quietEnd(s, at);
    if (end === null) return at;
    at = end;
  }
  return at;
}

/** True when `nowMs` is inside the settings' quiet window. */
export function inQuietHours(s: NoiseSettings, nowMs: number): boolean {
  return quietEnd(s, nowMs) !== null;
}

/**
 * The next scheduled digest boundary strictly after `nowMs`, or null when no digest is on.
 * Boundaries inside quiet hours are moved to the end of quiet hours.
 */
export function nextDigestAt(s: NoiseSettings, nowMs: number): number | null {
  if (s.digest === 'off') return null;
  const boundary =
    s.digest === 'hourly'
      ? nextLocalHour(nowMs, s.timezone)
      : nextLocalClock(nowMs, parseClock(s.digestAt) ?? 480, s.timezone);
  return outOfQuiet(s, boundary);
}

/**
 * Deliver now, or hold until a known time. Precedence, most specific first:
 *
 *  1. no holding feature on                         deliver (`no_noise`)
 *  2. critical                                      deliver (`critical_bypass`), always
 *  3. integration already has HELD_CAPACITY waiting deliver (`hold_capacity`): the cap bounds
 *                                                   storage and fails toward delivering
 *  4. inside quiet hours                            hold until quiet hours end, or the next
 *                                                   digest boundary after that if a digest is on
 *  5. a digest is on                                hold until the next digest boundary
 *  6. a group window is on                          join the open group, or open one
 *
 * A group window that would end inside quiet hours is extended to the end of quiet hours.
 */
export function decideNoise(settings: NoiseSettings | null, input: NoiseInput): NoiseDecision {
  if (!settings || !holdsUpdates(settings)) return { action: 'deliver', reason: 'no_noise' };
  if (input.critical) return { action: 'deliver', reason: 'critical_bypass' };
  if (input.heldCount >= HELD_CAPACITY) return { action: 'deliver', reason: 'hold_capacity' };

  const quiet = quietEnd(settings, input.nowMs);
  if (quiet !== null) {
    const digestAt = nextDigestAt(settings, input.nowMs);
    return { action: 'hold', reason: 'quiet_hours', releaseAt: Math.max(quiet, digestAt ?? 0) };
  }
  const digestAt = nextDigestAt(settings, input.nowMs);
  if (digestAt !== null) return { action: 'hold', reason: 'digest', releaseAt: digestAt };

  // Only quiet hours and/or a digest were configured and neither applies right now.
  if (settings.groupWindowSec === 0) return { action: 'deliver', reason: 'no_noise' };
  const windowMs = settings.groupWindowSec * 1000;
  const base = input.openGroupReleaseAt ?? input.nowMs + windowMs;
  return { action: 'hold', reason: 'grouped', releaseAt: outOfQuiet(settings, base) };
}

// --- the group key ----------------------------------------------------------------------------

const encoder = new TextEncoder();

/**
 * F141/F165: the key is derived from normalised fields, begins with the organization and the
 * integration (hence the destination), and is hashed to a fixed 32 hex characters. Each part
 * is length-prefixed so ("ab","c") and ("a","bc") cannot collide. Different repositories,
 * pull requests, issues, branches, runs and event types are different keys by construction.
 */
export async function groupKeyOf(parts: {
  readonly organizationId: string;
  readonly integrationId: string;
  readonly eventType: string;
  readonly repo: string;
  readonly subject: string;
}): Promise<string> {
  const text = [parts.organizationId, parts.integrationId, parts.eventType, parts.repo, parts.subject]
    .map((p) => `${p.length}:${p}`)
    .join('|');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
  return Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}
