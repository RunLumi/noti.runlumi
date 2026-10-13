import {
  DEFAULT_NOISE,
  GROUP_WINDOWS,
  decideNoise,
  noiseCoverageIssue,
  parseNoise,
  type DigestMode,
  type GroupWindow,
  type NoiseSettings,
} from '../../../../src/routing/noise';
import { isValidTimeZone, localParts, nextLocalClock, parseClock } from '../../../../src/routing/noise-time';
import type { FieldError } from '../../lib/api';
import { t, type MessageId } from '../../i18n';

/**
 * The form model for quiet hours, grouping, summaries and resolved notices (ADR 0016). Parsing
 * and the "what will this do" preview use the server's own functions (`parseNoise`,
 * `decideNoise`), so the form accepts exactly what the API accepts and the preview describes
 * exactly what ingress will do. Pure: no React, no clock except where a function takes `nowMs`.
 */

export interface NoiseDraft {
  readonly quietOn: boolean;
  readonly quietStart: string;
  readonly quietEnd: string;
  readonly timezone: string;
  readonly groupWindowSec: GroupWindow;
  readonly digest: DigestMode;
  readonly digestAt: string;
  readonly resolution: boolean;
}

export type NoiseControl = 'quietStart' | 'quietEnd' | 'timezone' | 'digestAt' | 'resolution' | 'form';
export type NoiseErrors = Partial<Record<NoiseControl, string>>;

/** The viewer's own zone when the runtime knows it and the server would accept it. */
export function browserTimeZone(): string {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(zone) ? zone : DEFAULT_NOISE.timezone;
  } catch {
    return DEFAULT_NOISE.timezone;
  }
}

export function emptyNoiseDraft(timezone: string = browserTimeZone()): NoiseDraft {
  return {
    quietOn: false,
    quietStart: '22:00',
    quietEnd: '08:00',
    timezone,
    groupWindowSec: 0,
    digest: 'off',
    digestAt: DEFAULT_NOISE.digestAt,
    // Off until chosen: spec 11 F152 asks for "default on", but a missing setting must never
    // change what an existing integration sends (ADR 0016 "Not done").
    resolution: false,
  };
}

export function draftFromSettings(settings: NoiseSettings | null): NoiseDraft {
  if (!settings) return emptyNoiseDraft();
  const fresh = emptyNoiseDraft(settings.timezone);
  return {
    ...fresh,
    quietOn: settings.quietHours !== null,
    quietStart: settings.quietHours?.start ?? fresh.quietStart,
    quietEnd: settings.quietHours?.end ?? fresh.quietEnd,
    groupWindowSec: settings.groupWindowSec,
    digest: settings.digest,
    digestAt: settings.digestAt,
    resolution: settings.resolution,
  };
}

/** What a save sends: the draft as a document the server's parser accepts. */
function documentOf(draft: NoiseDraft, isSource: boolean): Record<string, unknown> {
  return {
    timezone: draft.timezone,
    quietHours: draft.quietOn ? { start: draft.quietStart, end: draft.quietEnd } : null,
    groupWindowSec: draft.groupWindowSec,
    digest: draft.digest,
    digestAt: draft.digestAt,
    // Resolved notices need workflow runs, which only a repository integration has.
    resolution: isSource ? false : draft.resolution,
  };
}

const FIELD_TO_CONTROL: Readonly<Record<string, NoiseControl>> = {
  'noise.timezone': 'timezone',
  'noise.quietHours': 'quietStart',
  'noise.quietHours.start': 'quietStart',
  'noise.quietHours.end': 'quietEnd',
  'noise.digestAt': 'digestAt',
  'noise.resolution': 'resolution',
};

function messageFor(control: NoiseControl, draft: NoiseDraft): string {
  switch (control) {
    case 'timezone':
      return t('noise.error.timezone');
    case 'resolution':
      return t('noise.error.resolution');
    case 'quietEnd':
      return parseClock(draft.quietEnd) !== null && draft.quietStart === draft.quietEnd
        ? t('noise.error.sameTime')
        : t('noise.error.time');
    case 'quietStart':
    case 'digestAt':
      return t('noise.error.time');
    case 'form':
      return t('noise.error.generic');
  }
}

/** Server or local issues, shown next to the control they concern, in our own copy. */
export function errorsFromIssues(issues: readonly FieldError[], draft: NoiseDraft): NoiseErrors {
  const errors: NoiseErrors = {};
  for (const issue of issues) {
    const control = FIELD_TO_CONTROL[issue.field] ?? 'form';
    errors[control] ??= messageFor(control, draft);
  }
  return errors;
}

export type NoiseCheck =
  | { readonly ok: true; readonly settings: NoiseSettings | null }
  | { readonly ok: false; readonly errors: NoiseErrors };

export function validateNoiseDraft(
  draft: NoiseDraft,
  eventTypes: readonly string[],
  isSource: boolean,
): NoiseCheck {
  const parsed = parseNoise(documentOf(draft, isSource));
  if (!parsed.ok) return { ok: false, errors: errorsFromIssues(parsed.errors, draft) };
  const coverage = isSource ? null : noiseCoverageIssue(parsed.value, eventTypes);
  if (coverage) return { ok: false, errors: errorsFromIssues([coverage], draft) };
  return { ok: true, settings: parsed.value };
}

/** True when resolved notices cannot work with these selected updates (GitHub integrations only). */
export function resolutionBlocked(eventTypes: readonly string[]): boolean {
  return !eventTypes.includes('workflow_run.failure') && !eventTypes.includes('workflow_run.timed_out');
}

// --- time zones and clocks --------------------------------------------------------------------

/** Every zone the runtime knows and the server accepts, with the chosen one always present. */
export function timeZoneChoices(selected: string): readonly string[] {
  const set = new Set(['UTC', ...supportedZones().filter(isValidTimeZone)]);
  if (isValidTimeZone(selected)) set.add(selected);
  return [...set].sort((a, b) => a.localeCompare(b));
}

function supportedZones(): string[] {
  try {
    const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    return supported ? supported('timeZone') : [];
  } catch {
    return [];
  }
}

/** `HH:MM` on the wall clock of `timeZone` at the instant `ms`. */
export function clockAt(ms: number, timeZone: string): string {
  const p = localParts(ms, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/**
 * The wall-clock time at which updates held in quiet hours are sent, computed by the same
 * decision ingress makes: an update arriving just after quiet hours begin. With a summary
 * schedule that ends later than quiet hours, this is the later time.
 */
export function quietSendTime(settings: NoiseSettings): string | null {
  if (!settings.quietHours) return null;
  const start = parseClock(settings.quietHours.start);
  if (start === null) return null;
  const probe = nextLocalClock(Date.now(), start, settings.timezone) + 30_000;
  const decision = decideNoise(settings, {
    critical: false,
    nowMs: probe,
    openGroupReleaseAt: null,
    heldCount: 0,
  });
  return decision.action === 'hold' ? clockAt(decision.releaseAt, settings.timezone) : null;
}

const WINDOW_LABEL: Readonly<Record<GroupWindow, MessageId>> = {
  0: 'noise.group.w0',
  60: 'noise.group.w60',
  300: 'noise.group.w300',
  900: 'noise.group.w900',
  3600: 'noise.group.w3600',
};

export const GROUP_WINDOW_CHOICES: readonly { readonly value: GroupWindow; readonly label: MessageId }[] =
  GROUP_WINDOWS.map((value) => ({ value, label: WINDOW_LABEL[value] }));

export const windowLabel = (w: GroupWindow): string => t(WINDOW_LABEL[w]);

/** The plain-language sentences shown under the controls: exactly what ingress will do. */
export function describeNoise(settings: NoiseSettings | null, isSource: boolean): string[] {
  if (!settings) return [t('noise.preview.none')];
  const lines: string[] = [];
  const quietTime = quietSendTime(settings);
  if (quietTime) lines.push(t('noise.preview.quiet', { time: quietTime }));
  if (settings.groupWindowSec > 0)
    lines.push(t('noise.preview.group', { window: windowLabel(settings.groupWindowSec) }));
  if (settings.digest === 'hourly') lines.push(t('noise.preview.digestHourly'));
  if (settings.digest === 'daily') lines.push(t('noise.preview.digestDaily', { time: settings.digestAt }));
  if (settings.resolution && !isSource) lines.push(t('noise.preview.resolution'));
  if (quietTime || settings.groupWindowSec > 0 || settings.digest !== 'off')
    lines.push(t('noise.preview.urgent'));
  return lines.length > 0 ? lines : [t('noise.preview.none')];
}

// --- the routing log --------------------------------------------------------------------------

const LOG_TEXT: Readonly<Record<string, MessageId>> = {
  quiet_hours: 'noise.log.quiet_hours',
  digest: 'noise.log.digest',
  grouped: 'noise.log.grouped',
  critical_bypass: 'noise.log.critical_bypass',
  hold_capacity: 'noise.log.hold_capacity',
};

/** The sentence for a delivered row whose reason is a noise-control code, or null for any other row. */
export function noiseLogText(reason: string): string | null {
  const id = LOG_TEXT[reason];
  return id ? t(id) : null;
}

/** True when the update was saved for later rather than sent at once. */
export function isSavedReason(reason: string): boolean {
  return reason === 'quiet_hours' || reason === 'digest' || reason === 'grouped';
}
