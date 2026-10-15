import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_NOISE, type NoiseSettings } from '../../../../src/routing/noise';
import { isValidTimeZone } from '../../../../src/routing/noise-time';
import { parseNoiseStatus } from '../../lib/api';
import {
  clockAt,
  describeNoise,
  draftFromSettings,
  emptyNoiseDraft,
  isSavedReason,
  noiseLogText,
  quietSendTime,
  FALLBACK_ZONES,
  resolutionBlocked,
  supportedZones,
  timeZoneChoices,
  validateNoiseDraft,
} from './model';

const HCM = 'Asia/Ho_Chi_Minh';
const settings = (over: Partial<NoiseSettings>): NoiseSettings => ({ ...DEFAULT_NOISE, ...over });
const EVENTS = ['workflow_run.failure', 'issue_comment.created'];

describe('draft and settings', () => {
  it('starts with everything off', () => {
    const d = emptyNoiseDraft('UTC');
    expect(d).toMatchObject({ quietOn: false, groupWindowSec: 0, digest: 'off', resolution: false });
    expect(validateNoiseDraft(d, EVENTS, false)).toEqual({ ok: true, settings: null });
  });

  it.each([
    settings({ timezone: HCM, quietHours: { start: '22:00', end: '08:00' } }),
    settings({ groupWindowSec: 900 }),
    settings({ digest: 'hourly', timezone: 'America/New_York' }),
    settings({ digest: 'daily', digestAt: '09:30' }),
    settings({ resolution: true }),
  ])('round-trips through the form: %j', (s) => {
    expect(validateNoiseDraft(draftFromSettings(s), EVENTS, false)).toEqual({ ok: true, settings: s });
  });

  it('keeps a maximum wait set through the API when the form saves, because the form has no control for it', () => {
    const s = settings({ groupWindowSec: 300, maxWaitSec: 900 });
    expect(validateNoiseDraft(draftFromSettings(s), EVENTS, false)).toEqual({ ok: true, settings: s });
  });

  it('turning grouping off is always savable, and the maximum wait goes with it', () => {
    const draft = {
      ...draftFromSettings(settings({ groupWindowSec: 300, maxWaitSec: 900 })),
      groupWindowSec: 0 as const,
    };
    expect(validateNoiseDraft(draft, EVENTS, false)).toEqual({ ok: true, settings: null });
  });
});

describe('validation uses the server parser and our own copy', () => {
  const base = emptyNoiseDraft(HCM);

  it('flags equal start and end next to the end control', () => {
    const r = validateNoiseDraft(
      { ...base, quietOn: true, quietStart: '08:00', quietEnd: '08:00' },
      EVENTS,
      false,
    );
    expect(r).toEqual({ ok: false, errors: { quietEnd: 'Start and end must be different times.' } });
  });

  it('flags a malformed time and a zone the server would refuse', () => {
    const r = validateNoiseDraft(
      { ...base, quietOn: true, quietStart: '', timezone: 'Mars/Phobos' },
      EVENTS,
      false,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.quietStart).toBe('Use a time like 22:00.');
      expect(r.errors.timezone).toBe('Choose a time zone from the list.');
    }
  });

  it('refuses resolved notices when no failing run is selected, like the API does', () => {
    const r = validateNoiseDraft({ ...base, resolution: true }, ['issue_comment.created'], false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.resolution).toContain('workflow run failed');
    expect(resolutionBlocked(['issue_comment.created'])).toBe(true);
    expect(resolutionBlocked(['workflow_run.timed_out'])).toBe(false);
  });

  it('ignores resolved notices for a source integration instead of failing', () => {
    expect(validateNoiseDraft({ ...base, resolution: true }, [], true)).toEqual({ ok: true, settings: null });
  });
});

describe('describeNoise: the preview says what ingress will do', () => {
  it('says every update is sent when nothing is set', () => {
    expect(describeNoise(null, false)).toEqual(['Every update is sent right away.']);
  });

  it('quiet hours: the summary is sent when quiet hours end', () => {
    const s = settings({ timezone: HCM, quietHours: { start: '22:00', end: '08:00' } });
    expect(describeNoise(s, false)).toEqual([
      'During quiet hours Noti will hold updates and send one summary at 08:00.',
      'Failures and other urgent updates are always sent right away, even during quiet hours.',
    ]);
  });

  it('quiet hours with a later daily summary: the later time, because that is what ingress does', () => {
    const s = settings({
      timezone: HCM,
      quietHours: { start: '22:00', end: '08:00' },
      digest: 'daily',
      digestAt: '09:00',
    });
    expect(describeNoise(s, false)[0]).toContain('at 09:00');
    expect(quietSendTime(s)).toBe('09:00');
  });

  it('is computed in the chosen zone across a daylight-saving week', () => {
    const ny = settings({ timezone: 'America/New_York', quietHours: { start: '22:00', end: '07:00' } });
    expect(quietSendTime(ny)).toBe('07:00');
    expect(
      quietSendTime(settings({ timezone: 'Asia/Kolkata', quietHours: { start: '23:30', end: '06:45' } })),
    ).toBe('06:45');
  });

  it('describes grouping, summaries and resolved notices, and omits resolved notices for a source', () => {
    const s = settings({ groupWindowSec: 300, digest: 'hourly', resolution: true });
    expect(describeNoise(s, false)).toEqual([
      'Updates about the same thing that arrive within 5 minutes are sent as one message with a count.',
      'Non-urgent updates are saved and sent as one summary every hour.',
      'When a failing workflow passes again, Noti sends a “Resolved” message.',
      'Failures and other urgent updates are always sent right away, even during quiet hours.',
    ]);
    expect(describeNoise(s, true).join(' ')).not.toContain('Resolved');
    expect(describeNoise(settings({ digest: 'daily', digestAt: '07:15' }), false)[0]).toBe(
      'Non-urgent updates are saved and sent as one summary every day at 07:15.',
    );
  });
});

describe('time zones and clocks', () => {
  it('offers UTC, the selected zone and only zones the server accepts, sorted', () => {
    const zones = timeZoneChoices('Asia/Ho_Chi_Minh');
    expect(zones).toContain('UTC');
    expect(zones).toContain('Asia/Ho_Chi_Minh');
    expect([...zones]).toEqual([...zones].sort((a, b) => a.localeCompare(b)));
    expect(new Set(zones).size).toBe(zones.length);
    expect(timeZoneChoices('Mars/Phobos')).not.toContain('Mars/Phobos');
  });

  it('formats a wall clock in a zone', () => {
    expect(clockAt(Date.parse('2026-10-14T01:00:00Z'), HCM)).toBe('08:00');
    expect(clockAt(Date.parse('2026-03-08T11:00:00Z'), 'America/New_York')).toBe('07:00');
  });
});

describe('the routing log', () => {
  it('knows which reasons mean "saved for later" and gives each a sentence', () => {
    for (const reason of ['quiet_hours', 'digest', 'grouped']) {
      expect(isSavedReason(reason)).toBe(true);
      expect(noiseLogText(reason)).toBeTruthy();
    }
    expect(isSavedReason('critical_bypass')).toBe(false);
    expect(noiseLogText('critical_bypass')).toContain('Urgent');
    expect(noiseLogText('hold_capacity')).toContain('too many updates');
    expect(noiseLogText('allowed')).toBeNull();
  });
});

describe('parseNoiseStatus', () => {
  it('accepts the documented shape', () => {
    expect(parseNoiseStatus({ held: { count: 2, nextReleaseAt: '2026-10-14T01:00:00.000Z' } })).toEqual({
      count: 2,
      nextReleaseAt: '2026-10-14T01:00:00.000Z',
    });
    expect(parseNoiseStatus({ held: { count: 0, nextReleaseAt: null } })).toEqual({
      count: 0,
      nextReleaseAt: null,
    });
  });

  it.each([null, {}, { held: null }, { held: { count: '2' } }, { held: { count: 1, nextReleaseAt: 5 } }])(
    'rejects %j',
    (body) => expect(() => parseNoiseStatus(body)).toThrow(),
  );
});

describe('the preview is pure: it takes the instant instead of reading the clock', () => {
  const s = settings({ timezone: 'America/New_York', quietHours: { start: '22:00', end: '07:00' } });
  it('gives the same answer for the same instant, and follows the daylight-saving week', () => {
    const winter = Date.parse('2026-01-15T12:00:00Z');
    const dstWeek = Date.parse('2026-03-08T00:00:00Z');
    expect(quietSendTime(s, winter)).toBe('07:00');
    expect(quietSendTime(s, winter)).toBe(quietSendTime(s, winter));
    expect(quietSendTime(s, dstWeek)).toBe('07:00');
    expect(describeNoise(s, false, winter)[0]).toContain('at 07:00');
  });
});

describe('the time-zone list without Intl.supportedValuesOf', () => {
  const original = Object.getOwnPropertyDescriptor(Intl, 'supportedValuesOf');
  afterEach(() => {
    if (original) Object.defineProperty(Intl, 'supportedValuesOf', original);
  });

  it.each([
    ['missing', undefined],
    [
      'throwing',
      () => {
        throw new Error('unsupported');
      },
    ],
    ['empty', () => []],
  ])('falls back to a built-in list when the function is %s', (_name, impl) => {
    Object.defineProperty(Intl, 'supportedValuesOf', { value: impl, configurable: true, writable: true });
    expect(supportedZones()).toBe(FALLBACK_ZONES);
    const choices = timeZoneChoices('Asia/Ho_Chi_Minh');
    expect(choices.length).toBeGreaterThan(30);
    expect(choices).toContain('UTC');
    expect(choices).toContain('Asia/Ho_Chi_Minh');
  });

  it('every built-in zone is one the server accepts', () => {
    for (const zone of FALLBACK_ZONES) expect(isValidTimeZone(zone), zone).toBe(true);
  });
});
