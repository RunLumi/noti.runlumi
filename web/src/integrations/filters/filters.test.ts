import { describe, expect, it } from 'vitest';
import { REASON_CODES, evaluateFilters, type FilterConfig } from '../../../../src/routing/filters';
import { parseCreateIntegration } from '../../../../src/api/integration-input';
import { parseIntegration, parseRoutingLog, ApiError } from '../../lib/api';
import { en } from '../../i18n/messages.en';
import { t } from '../../i18n';
import { fromServer } from '../validation';
import {
  EMPTY_DRAFT,
  earliestStep,
  stepOf,
  toBody,
  validateAll,
  validateStep,
  STEPS,
  type Draft,
} from '../wizard/draft';
import {
  coverageNotes,
  eventsCoverageError,
  describeDecision,
  describeFilterCount,
  draftFromConfig,
  EMPTY_FILTER_DRAFT,
  EMPTY_SAMPLE,
  errorsFromServer,
  FILTER_NAME,
  nthNonBlankLine,
  rawFilters,
  REASON_TEXT,
  runSample,
  splitLines,
  validateFilterDraft,
  type FilterDraft,
} from './model';

const draft = (over: Partial<FilterDraft>): FilterDraft => ({ ...EMPTY_FILTER_DRAFT, ...over });
const ok = (d: FilterDraft): FilterConfig => {
  const r = validateFilterDraft(d);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.config;
};

describe('filter draft model', () => {
  it('an untouched draft means no filters', () => {
    expect(ok(EMPTY_FILTER_DRAFT)).toEqual({});
    expect(describeFilterCount({})).toBe('None');
  });

  it('turns lines into the API shape, ignoring blank lines and surrounding space', () => {
    const config = ok(
      draft({
        branchAllow: ' main \n\n release/** \n',
        peopleDeny: 'dependabot[bot]',
        bots: 'exclude',
        skipDrafts: true,
        labelsInclude: 'bug\r\nregression',
      }),
    );
    expect(config).toEqual({
      branch: { allow: ['main', 'release/**'], deny: [] },
      actor: { allow: [], deny: ['dependabot[bot]'], bots: 'exclude' },
      draft: 'exclude',
      labels: { include: ['bug', 'regression'], exclude: [] },
    });
    expect(describeFilterCount(config)).toBe('4 filters on');
  });

  it('round-trips a saved config back into the form', () => {
    const config = ok(
      draft({ branchAllow: 'main', baseDeny: 'legacy', labelsExclude: 'wontfix', skipDrafts: true }),
    );
    expect(ok(draftFromConfig(config))).toEqual(config);
    expect(draftFromConfig({})).toEqual(EMPTY_FILTER_DRAFT);
  });

  it('puts each error on its own control with the line the person typed', () => {
    const r = validateFilterDraft(
      draft({
        branchAllow: 'main\n\nbad?name',
        peopleAllow: 'octocat\nnot a name',
        labelsInclude: 'x'.repeat(101),
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Line 3 in the box (the blank second line is skipped by the parser but counted by the person).
    expect(r.errors.branchAllow).toContain('Line 3');
    expect(r.errors.peopleAllow).toContain('Line 2');
    expect(r.errors.labelsInclude).toContain('Line 1');
  });

  it('never echoes what was typed in an error message', () => {
    const r = validateFilterDraft(draft({ branchAllow: 'super-secret?branch' }));
    expect(JSON.stringify(r)).not.toContain('super-secret');
  });

  it('refuses the deleted-user placeholder in a deny list, as the server does', () => {
    const r = validateFilterDraft(draft({ peopleDeny: 'ghost' }));
    expect(r.ok).toBe(false);
  });

  it('flags a list over the limit and an over-large config', () => {
    const many = Array.from({ length: 33 }, (_, i) => `b${i}`).join('\n');
    const r = validateFilterDraft(draft({ branchAllow: many }));
    expect(!r.ok && r.errors.branchAllow).toContain('at most 32');
    const total = Array.from({ length: 32 }, (_, i) => `${i}`).join('\n');
    const big = validateFilterDraft(
      draft({
        branchAllow: total,
        branchDeny: total,
        baseAllow: total,
        baseDeny: total,
        labelsInclude: total,
      }),
    );
    expect(!big.ok && big.errors.form).toContain('128');
  });

  it('maps server 422 paths onto controls', () => {
    const d = draft({ branchDeny: 'a\nb' });
    const errors = errorsFromServer(
      [
        { field: 'filters.branch.deny[1]', message: 'server words' },
        { field: 'filters.labels.include', message: 'server words' },
        { field: 'name', message: 'not a filter field' },
        { field: 'filters', message: 'server words' },
      ],
      d,
    );
    expect(errors.branchDeny).toContain('Line 2');
    expect(errors.labelsInclude).toContain('at most 32');
    expect(errors.form).toContain('too many');
    expect(JSON.stringify(errors)).not.toContain('server words');
  });

  it('counts lines in what was typed, not in the cleaned list', () => {
    expect(nthNonBlankLine('a\n\n\nb\nc', 2)).toBe(5);
    expect(splitLines('a\r\n\r\n b ')).toEqual(['a', ' b ']);
  });

  it('sends the same raw shape the API validates', () => {
    expect(rawFilters(draft({ skipDrafts: true })).draft).toBe('exclude');
    expect(rawFilters(EMPTY_FILTER_DRAFT).draft).toBeNull();
  });
});

describe('"Try it" uses the ingress evaluator', () => {
  const config = ok(draft({ branchAllow: 'main', bots: 'exclude', skipDrafts: true }));

  it('answers like evaluateFilters on the same facts', () => {
    const sample = {
      ...EMPTY_SAMPLE,
      event: 'pull_request.opened' as const,
      branch: 'dev',
      bot: 'no' as const,
    };
    const viaModel = runSample(config, sample);
    const direct = evaluateFilters(config, 'pull_request.opened', {
      branch: 'dev',
      baseBranch: null,
      actorLogin: null,
      actorIsBot: false,
      actorIsGhost: null,
      draft: null,
      labels: [],
    });
    expect(viaModel).toEqual(direct);
    expect(viaModel).toMatchObject({ pass: false, filterId: 'branch', reason: 'not_in_allow_list' });
  });

  it('treats an empty field as "GitHub did not say", not as a value', () => {
    const d = runSample(config, { ...EMPTY_SAMPLE, event: 'push', branch: '' });
    expect(d).toMatchObject({ pass: false, reason: 'unknown_fact', unknown: true });
  });

  it('knows the deleted-account login is never skipped', () => {
    const only = ok(draft({ bots: 'only' }));
    const d = runSample(only, { ...EMPTY_SAMPLE, event: 'push', login: 'Ghost', bot: 'no' });
    expect(d).toMatchObject({ pass: true, reason: 'ghost_exempt' });
    expect(describeDecision(d)).toContain('deleted account');
  });

  it('describes a skip by filter and reason, and a pass plainly', () => {
    const skipped = runSample(config, {
      ...EMPTY_SAMPLE,
      event: 'pull_request.opened',
      branch: 'main',
      bot: 'no',
      draft: 'yes',
    });
    expect(describeDecision(skipped)).toBe(
      'Skipped by the “Draft pull requests” filter, because it is a draft pull request.',
    );
    const sent = runSample(config, { ...EMPTY_SAMPLE, event: 'push', branch: 'main', bot: 'no' });
    expect(describeDecision(sent)).toContain('Sent.');
  });

  it('every reason code the evaluator can produce has copy, and every message exists', () => {
    for (const code of REASON_CODES) expect(en[REASON_TEXT[code]]).toBeTruthy();
    for (const id of Object.values(FILTER_NAME)) expect(en[id]).toBeTruthy();
    expect(t('filters.reason.config_invalid')).toBeTruthy();
  });
});

describe('create wizard filters step', () => {
  const base: Draft = {
    ...EMPTY_DRAFT,
    destination: 'slack',
    webhookUrl: 'https://hooks.slack.com/services/T000/B000/XXXX',
    repo: 'acme/web',
  };
  const installations = [
    {
      id: 'a',
      account: 'acme',
      accountType: 'Organization' as const,
      repositorySelection: 'selected' as const,
      status: 'active' as const,
      updatedAt: null,
      needsResync: false,
      repositories: ['acme/web'],
    },
  ];

  it('filters sit after the events step and before review', () => {
    expect(STEPS.at(-2)).toBe('wizard.step.filters');
    expect(stepOf('filters')).toBe(STEPS.length - 2);
  });

  it('is optional: an untouched step passes and adds nothing to the request', () => {
    expect(validateAll(base, installations)).toEqual({});
    expect(toBody({ ...base, destination: 'slack' })).not.toHaveProperty('filters');
  });

  it('blocks Continue on an invalid filter and sends the user to that step', () => {
    const bad: Draft = { ...base, filters: draft({ branchAllow: 'a?b' }) };
    const errors = validateStep(stepOf('filters'), bad, installations);
    expect(errors.filters).toBeTruthy();
    expect(earliestStep(validateAll(bad, installations), 0)).toBe(stepOf('filters'));
  });

  it('sends normalised filters, and the server accepts exactly what the form sends', () => {
    const withFilters: Draft = {
      ...base,
      filters: draft({ branchAllow: 'main\nrelease/**', skipDrafts: true }),
    };
    const body = toBody({ ...withFilters, destination: 'slack' });
    expect(body.filters).toEqual({ branch: { allow: ['main', 'release/**'], deny: [] }, draft: 'exclude' });
    const server = parseCreateIntegration({ ...body, eventTypes: ['push'] });
    expect(server.ok && server.value.filters).toEqual(body.filters);
  });

  it('a server filter error returns the person to the filters step', () => {
    const server = fromServer([{ field: 'filters.branch.allow[0]', message: 'x' }]);
    expect(Object.keys(server.fields)).toEqual(['filters']);
    expect(earliestStep(server.fields, 99)).toBe(stepOf('filters'));
  });
});

describe('API client', () => {
  const row = {
    id: 'i',
    name: 'n',
    repo: 'a/b',
    eventTypes: ['push'],
    destination: 'slack',
    destinationHost: 'hooks.slack.com',
    enabled: true,
    credentials: 'ok',
    createdAt: null,
    updatedAt: null,
  };

  it('reads filters through the server parser, and treats a missing or malformed value as none', () => {
    expect(parseIntegration({ ...row, filters: { draft: 'exclude' } }).filters).toEqual({ draft: 'exclude' });
    expect(parseIntegration(row).filters).toEqual({});
    expect(parseIntegration({ ...row, filters: { branch: { allow: ['a?'] } } }).filters).toEqual({});
    expect(parseIntegration({ ...row, filtersInvalid: true }).filtersInvalid).toBe(true);
  });

  it('parses a routing log page strictly', () => {
    const entry = {
      id: 'e',
      eventType: 'push',
      outcome: 'filtered',
      filterId: 'branch',
      reason: 'not_in_allow_list',
      unknownFact: false,
      decidedAt: '2026-10-13T00:00:00.000Z',
    };
    expect(parseRoutingLog({ entries: [entry], nextCursor: 'c' })).toEqual({
      entries: [entry],
      nextCursor: 'c',
    });
    expect(parseRoutingLog({ entries: [], nextCursor: null }).nextCursor).toBeNull();
    expect(() => parseRoutingLog({ entries: [{ ...entry, outcome: 'maybe' }] })).toThrow(ApiError);
    expect(() => parseRoutingLog({})).toThrow(ApiError);
  });
});

describe('filters must fit the selected updates (H2)', () => {
  const only = ok(draft({ branchAllow: 'main' }));
  const never = ok(draft({ branchDeny: 'wip', skipDrafts: true }));

  it('refuses an "only" list that some selected update cannot read, naming both in plain language', () => {
    const notes = coverageNotes(only, ['push', 'issues.opened']);
    expect(notes.blocking).toHaveLength(1);
    expect(notes.blocking[0]).toContain('Branches');
    expect(notes.blocking[0]).toContain('An issue is opened');
    expect(eventsCoverageError(only, ['push', 'issues.opened'])).toContain('Branches');
    expect(eventsCoverageError(only, ['push', 'pull_request.opened'])).toBeUndefined();
  });

  it('only warns for a "never" rule', () => {
    const notes = coverageNotes(never, ['push', 'issues.opened']);
    expect(notes.blocking).toEqual([]);
    expect(notes.warnings.map((w) => w.includes('sent regardless'))).toEqual([true, true]);
  });

  it('validation of the draft includes the selected updates, as the API does', () => {
    const d = draft({ branchAllow: 'main' });
    expect(validateFilterDraft(d, ['push']).ok).toBe(true);
    const r = validateFilterDraft(d, ['push', 'issues.opened']);
    expect(!r.ok && r.errors.form).toContain('Branches');
  });

  it('maps the server coverage refusal onto the form-level message', () => {
    const errors = errorsFromServer(
      [{ field: 'filters.coverage', message: 'server words' }],
      EMPTY_FILTER_DRAFT,
    );
    expect(errors.form).toBe('server words');
  });

  it('the wizard blocks Continue on the filters step and on submit when events and filters disagree', () => {
    const bad: Draft = {
      ...EMPTY_DRAFT,
      destination: 'slack',
      webhookUrl: 'https://hooks.slack.com/services/T000/B000/XXXX',
      repo: 'acme/web',
      eventTypes: ['push', 'issues.opened'],
      filters: draft({ branchAllow: 'main' }),
    };
    expect(validateStep(stepOf('filters'), bad, []).filters).toBeTruthy();
    expect(validateStep(stepOf('filters'), { ...bad, eventTypes: ['push'] }, [])).toEqual({});
  });
});

describe('unknown facts and invalid stored filters in copy (M1, H1)', () => {
  it('tells people that a missing detail holds an update back', () => {
    expect(t('filters.honest')).toContain('held back');
    const d = runSample(ok(draft({ peopleDeny: 'mallory' })), { ...EMPTY_SAMPLE, event: 'push' });
    expect(d).toMatchObject({ pass: false, reason: 'unknown_fact' });
    expect(describeDecision(d)).toContain('held back to be safe');
  });

  it('explains a held-back event from unreadable stored filters', () => {
    const text = describeDecision({
      pass: false,
      unknown: false,
      filterId: 'config',
      reason: 'config_invalid',
    });
    expect(text).toContain('Stored filters');
    expect(text).toContain('held back to be safe');
    expect(
      describeDecision({ pass: true, unknown: false, filterId: null, reason: 'config_newer' }),
    ).toContain('newer version');
  });

  it('reads the new integration flags from the API', () => {
    const row = {
      id: 'i',
      name: 'n',
      repo: 'a/b',
      eventTypes: ['push'],
      destination: 'slack',
      destinationHost: null,
      enabled: true,
      credentials: 'ok',
      createdAt: null,
      updatedAt: null,
    };
    expect(parseIntegration({ ...row, filtersInvalid: true })).toMatchObject({
      filtersInvalid: true,
      filtersNewer: false,
    });
    expect(parseIntegration({ ...row, filtersNewer: true })).toMatchObject({
      filtersInvalid: false,
      filtersNewer: true,
    });
  });
});
