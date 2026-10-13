import { describe, expect, it } from 'vitest';
import { ApiError } from '../lib/api';
import { en } from '../i18n';
import { NEXT_ACTIONS, STEP_IDS, parseProgress } from './api';

const body = (over: Record<string, unknown> = {}) => ({
  steps: STEP_IDS.map((id, i) => ({
    id,
    done: i < 2,
    since: i < 2 ? '2026-10-01T00:00:00.000Z' : null,
    nextAction: i < 2 ? 'none' : 'send_test',
  })),
  complete: false,
  next: 'destination_verified',
  verifiedWindowDays: 30,
  ...over,
});

describe('parseProgress', () => {
  it('reads a well-formed response', () => {
    const p = parseProgress(body());
    expect(p.steps.map((s) => s.done)).toEqual([true, true, false, false]);
    expect(p.next).toBe('destination_verified');
    expect(p.verifiedWindowDays).toBe(30);
  });

  it.each([
    ['not an object', null],
    ['no steps', { complete: false }],
    [
      'a step with an unknown id',
      body({ steps: [{ id: 'x', done: true, since: null, nextAction: 'none' }] }),
    ],
    [
      'a step with an unknown action',
      body({ steps: [{ id: 'source_connected', done: true, since: null, nextAction: 'rm_rf' }] }),
    ],
    ['complete is not a boolean', body({ complete: 'yes' })],
  ])('rejects %s instead of guessing', (_name, value) => {
    expect(() => parseProgress(value)).toThrow(ApiError);
  });

  it('falls back to a null next for an unknown step id', () => {
    expect(parseProgress(body({ next: 'zzz' })).next).toBeNull();
  });
});

describe('copy for every step and action', () => {
  it('has a title and body for each step and a label for each action', () => {
    for (const id of STEP_IDS) {
      expect(en[`setup.step.${id}` as keyof typeof en]).toBeTruthy();
      expect(en[`setup.step.${id}.body` as keyof typeof en]).toBeTruthy();
    }
    for (const action of NEXT_ACTIONS.filter((a) => a !== 'none'))
      expect(en[`setup.action.${action}` as keyof typeof en]).toBeTruthy();
  });
});
