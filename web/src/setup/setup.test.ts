import { describe, expect, it } from 'vitest';
import { capabilitiesFor } from '../../../src/connectors/destinations/capabilities';
import { ApiError } from '../lib/api';
import { en } from '../i18n';
import { ABILITIES } from './abilities';
import { BLOCKED_REASONS, NEXT_ACTIONS, STEP_IDS, parseProgress } from './api';
import { BLOCKED_COPY } from './blocked';
import { SETUP_PAGES, SETUP_SLUGS, STEP_TITLE, slugForStep } from './model';
import { SETUP_PROGRESS } from '../a11y/testing/fixtures';

const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...(JSON.parse(JSON.stringify(SETUP_PROGRESS)) as Record<string, unknown>),
  ...over,
});

describe('parseProgress (v2)', () => {
  it('reads a well-formed response', () => {
    const p = parseProgress(body());
    expect(p.steps.map((s) => s.id)).toEqual([...STEP_IDS]);
    expect(p.steps[5]).toMatchObject({ state: 'doing', nextAction: 'send_test' });
    expect(p.resume).toEqual({
      step: 'test_delivered',
      integrationId: 'int_1',
      point: 'v2:test_delivered:int_1',
    });
    expect(p.next).toBe('test_delivered');
  });

  it.each([
    ['not an object', null],
    ['the old version', body({ version: 1 })],
    ['no steps', body({ steps: undefined })],
    ['a step with an unknown state', body({ steps: [{ ...SETUP_PROGRESS.steps[0], state: 'wat' }] })],
    ['a step with an unknown action', body({ steps: [{ ...SETUP_PROGRESS.steps[0], nextAction: 'rm_rf' }] })],
    ['no resume point', body({ resume: undefined })],
    ['complete is not a boolean', body({ complete: 'yes' })],
  ])('rejects %s instead of guessing', (_name, value) => {
    expect(() => parseProgress(value)).toThrow(ApiError);
  });

  it('drops an unknown blocked reason and falls back to a null next', () => {
    const steps = SETUP_PROGRESS.steps.map((s, i) => (i === 1 ? { ...s, blockedBy: 'zzz' } : s));
    const p = parseProgress(body({ steps, next: 'zzz' }));
    expect(p.steps[1]?.blockedBy).toBeNull();
    expect(p.next).toBeNull();
  });
});

describe('copy and pages for every step', () => {
  it('has a title and body for each step, a label for each action and a sentence for each block', () => {
    for (const id of STEP_IDS) {
      expect(en[STEP_TITLE[id]]).toBeTruthy();
      expect(en[`setup.step.${id}.body` as keyof typeof en]).toBeTruthy();
    }
    for (const action of NEXT_ACTIONS.filter((a) => a !== 'none'))
      expect(en[`setup.action.${action}` as keyof typeof en], action).toBeTruthy();
    for (const reason of BLOCKED_REASONS) {
      expect(en[BLOCKED_COPY[reason].title]).toBeTruthy();
      expect(en[BLOCKED_COPY[reason].body]).toBeTruthy();
    }
  });

  it('maps every page to a distinct server step and every step to a page (the first is display-only)', () => {
    expect(new Set(SETUP_SLUGS.map((s) => SETUP_PAGES[s].step)).size).toBe(SETUP_SLUGS.length);
    for (const id of STEP_IDS.filter((s) => s !== 'workspace_created'))
      expect(SETUP_PAGES[slugForStep(id)].step).toBe(id);
    expect(slugForStep('workspace_created')).toBe('github');
  });
});

describe('destination abilities match the verified capability matrix', () => {
  for (const [kind, ability] of Object.entries(ABILITIES)) {
    it(kind, () => {
      const caps = capabilitiesFor(kind as keyof typeof ABILITIES);
      expect(ability.links).toBe(caps.supportsLinks);
      expect(ability.mentions).toBe(caps.supportsMentions);
      expect(ability.confirmation).toBe(caps.successSemantics);
      expect(ability.plainFallback).toBe(caps.formats.includes('plain'));
      expect(ability.signed).toBe(caps.signing !== 'none');
      expect(ability.redactsContactDetails).toBe(caps.redactsContactDetails);
      expect(ability.layout).toBe(caps.mode === 'signed_https' ? 'json' : 'card');
      if (ability.layout === 'card') expect(caps.formats[0]).toBe('card');
    });
  }
});
