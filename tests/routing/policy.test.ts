import { describe, expect, it, vi } from 'vitest';
import { extractGithubFacts } from '../../src/connectors/sources/github/facts';
import { GITHUB_EVENT_TYPES } from '../../src/connectors/sources/github/catalog';
import {
  coverageIssue,
  parseFilters,
  readStoredFilters,
  serializeFilters,
  MAX_ENTRIES_PER_LIST,
} from '../../src/routing/filter-input';
import { filterCoverage, type FilterConfig } from '../../src/routing/filters';
import { createRouteDecider } from '../../src/routing/ingress';
import {
  purgeRoutingDecisions,
  ROUTING_PURGE_ROUNDS,
  ROUTING_PURGE_ROWS_PER_TICK,
  ROUTING_RETENTION_MS,
} from '../../src/routing/provenance';
import { createFakeD1, seedOrganization } from '../support/d1';

const EMPTY = {
  branch: null,
  baseBranch: null,
  actorLogin: null,
  actorIsBot: null,
  actorIsGhost: null,
  draft: null,
  labels: null,
};

describe('stored documents: fail closed, except a newer version (H1)', () => {
  it('reads an unknown NEWER version as newer, never invalid', () => {
    expect(readStoredFilters('{"v":2,"draft":"exclude"}').kind).toBe('newer');
    expect(readStoredFilters('{"v":99}').kind).toBe('newer');
  });

  it.each([
    ['not JSON', '{nope'],
    ['an array', '[]'],
    ['no version', '{"draft":"exclude"}'],
    ['version 0', '{"v":0}'],
    ['a non-integer version', '{"v":1.5}'],
    ['a string version', '{"v":"2"}'],
    ['a value that no longer validates', '{"v":1,"branch":{"allow":["a?b"]}}'],
    ['an unknown filter', '{"v":1,"regex":{}}'],
  ])('reads %s as invalid', (_n, json) => {
    expect(readStoredFilters(json).kind).toBe('invalid');
  });

  it('the decider holds an event back for an invalid document and logs it, redacted', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const decide = createRouteDecider('push', () => EMPTY);
    expect(decide('int-1', '{"v":1,"branch":{"allow":["a?b"]}}')).toEqual({
      pass: false,
      filterId: 'config',
      reason: 'config_invalid',
      unknown: false,
    });
    const line = String(error.mock.calls[0]?.[0]);
    expect(line).toContain('routing_filters_invalid');
    expect(line).not.toContain('a?b');
    error.mockRestore();
  });

  it('the decider sends for a newer-version document and logs it', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const decide = createRouteDecider('push', () => EMPTY);
    expect(decide('int-1', '{"v":2,"branch":{"allow":["main"]}}')).toEqual({
      pass: true,
      filterId: null,
      reason: 'config_newer',
      unknown: false,
    });
    expect(String(error.mock.calls[0]?.[0])).toContain('newer_version');
    error.mockRestore();
  });

  it('has nothing to record for an integration without filters', () => {
    const decide = createRouteDecider('push', () => EMPTY);
    expect(decide('i', null)).toBeNull();
    expect(decide('i', '')).toBeNull();
    expect(decide('i', '{"v":1}')).toBeNull();
  });
});

describe('every stored document re-validates (canary)', () => {
  const max = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  const samples: unknown[] = [
    { branch: { allow: ['main'] } },
    { branch: { allow: max(MAX_ENTRIES_PER_LIST, 'rel/'), deny: ['wip/**'] } },
    { baseBranch: { deny: ['a*b*c'] } },
    { actor: { allow: ['octocat'], deny: ['dependabot[bot]'], bots: 'only' } },
    { actor: { bots: 'exclude' } },
    { draft: 'exclude' },
    { labels: { include: [' Bug ', 'bug', 'x'.repeat(100)], exclude: ['wont fix'] } },
    { branch: { allow: ['\\*literal', 'a\\\\b'] } },
    { branch: { allow: ['café', 'CAFÉ'] } },
    {
      branch: { allow: ['x'.repeat(128)] },
      labels: { include: max(32, 'l') },
      actor: { deny: max(32, 'u') },
    },
  ];

  it.each(samples.map((s, i) => [i, s]))('sample %s survives serialise then read unchanged', (_i, raw) => {
    const parsed = parseFilters(raw);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const json = serializeFilters(parsed.value);
    const back = readStoredFilters(json);
    expect(back).toEqual({ kind: 'ok', config: parsed.value });
    // Idempotent: a second round trip changes nothing.
    expect(serializeFilters(back.kind === 'ok' ? back.config : {})).toBe(json);
  });

  it('simulates a release that tightens the limits: a document that no longer fits is invalid', () => {
    const parsed = parseFilters({ labels: { include: max(32, 'l') }, branch: { allow: max(20, 'b') } });
    if (!parsed.ok) throw new Error('should parse');
    const json = serializeFilters(parsed.value);
    expect(readStoredFilters(json).kind).toBe('ok');
    expect(readStoredFilters(json, { perList: 16, total: 128 }).kind).toBe('invalid');
    expect(readStoredFilters(json, { perList: 32, total: 40 }).kind).toBe('invalid');
  });
});

describe('the decider does the work once per request (M4)', () => {
  const json = serializeFilters({
    branch: { allow: ['release/**'], deny: [] },
    labels: { include: ['bug'], exclude: [] },
  });

  it('extracts the facts once for any number of integrations', () => {
    const extract = vi.fn(() => ({ ...EMPTY, branch: 'release/1', labels: ['bug'] }));
    const decide = createRouteDecider('pull_request.opened', extract);
    for (let i = 0; i < 50; i++) expect(decide(`i${i}`, json)?.pass).toBe(true);
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('does not extract the facts at all when no integration has filters', () => {
    const extract = vi.fn(() => EMPTY);
    const decide = createRouteDecider('push', extract);
    decide('a', null);
    expect(extract).not.toHaveBeenCalled();
  });

  it('gives the same verdict for a shared document however many integrations use it', () => {
    const decide = createRouteDecider('pull_request.opened', () => ({
      ...EMPTY,
      branch: 'dev',
      labels: ['bug'],
    }));
    const first = decide('a', json);
    expect(first).toMatchObject({ pass: false, filterId: 'branch' });
    expect(decide('b', json)).toEqual(first);
  });
});

describe('coverage of subscribed events (H2)', () => {
  const only: FilterConfig = { branch: { allow: ['main'], deny: [] } };
  const never: FilterConfig = { branch: { allow: [], deny: ['wip'] }, draft: 'exclude' };

  it('refuses an "only" list that some subscribed event cannot read', () => {
    expect(coverageIssue(only, ['push', 'issues.opened'])?.field).toBe('filters.coverage');
    expect(coverageIssue(only, ['push', 'pull_request.opened', 'workflow_run.failure'])).toBeNull();
  });

  it('names filters and catalog events, never the typed values', () => {
    const issue = coverageIssue({ branch: { allow: ['very-secret-branch'], deny: [] } }, ['issues.opened']);
    expect(issue?.message).toContain('issues.opened');
    expect(issue?.message).not.toContain('very-secret-branch');
  });

  it('allows a "never" rule on events that cannot read it, and reports it', () => {
    const { blocking, warnings } = filterCoverage(never, ['push', 'issues.opened']);
    expect(blocking).toEqual([]);
    expect(warnings).toEqual([
      { filter: 'branch', eventTypes: ['issues.opened'] },
      { filter: 'draft', eventTypes: ['push', 'issues.opened'] },
    ]);
  });

  it('release and deployment events can read a branch now', () => {
    expect(filterCoverage(only, ['release.published', 'deployment_status.created']).blocking).toEqual([]);
  });

  it('labels and base-branch "only" lists are held to the same rule', () => {
    expect(coverageIssue({ labels: { include: ['bug'], exclude: [] } }, ['push'])).not.toBeNull();
    expect(
      coverageIssue({ baseBranch: { allow: ['main'], deny: [] } }, ['workflow_run.failure']),
    ).not.toBeNull();
    expect(
      coverageIssue({ actor: { allow: ['a'], deny: [], bots: 'only' } }, [...GITHUB_EVENT_TYPES]),
    ).toBeNull();
  });
});

describe('branch facts for releases and deployments (H2)', () => {
  it('uses deployment.ref and release.target_commitish when they look like a branch', () => {
    expect(extractGithubFacts('deployment_status', { deployment: { ref: 'main' } }).branch).toBe('main');
    expect(extractGithubFacts('deployment_status', { deployment: { ref: 'refs/heads/prod' } }).branch).toBe(
      'prod',
    );
    expect(extractGithubFacts('release', { release: { target_commitish: 'release/1' } }).branch).toBe(
      'release/1',
    );
  });

  it.each([
    ['a full SHA', 'a'.repeat(40)],
    ['a short SHA', 'abcdef1'],
    ['a tag ref', 'refs/tags/v1'],
  ])('treats %s as no branch', (_n, ref) => {
    expect(extractGithubFacts('deployment_status', { deployment: { ref } }).branch).toBeNull();
    expect(extractGithubFacts('release', { release: { target_commitish: ref } }).branch).toBeNull();
  });

  it('is null when the payload has neither', () => {
    expect(extractGithubFacts('release', {}).branch).toBeNull();
    expect(extractGithubFacts('deployment_status', { deployment: {} }).branch).toBeNull();
  });
});

describe('retention drains in bounded rounds (M2)', () => {
  const seed = (raw: ReturnType<typeof createFakeD1>['raw'], n: number, at: number) => {
    const insert = raw.prepare(
      `INSERT INTO routing_decisions(id,organization_id,integration_id,event_type,outcome,reason,decided_at)
       VALUES(?,?,?,?,?,?,?)`,
    );
    raw.exec('BEGIN');
    for (let i = 0; i < n; i++) insert.run(`${at}-${i}`, 'org-a', 'i', 'push', 'delivered', 'allowed', at);
    raw.exec('COMMIT');
  };
  const count = (raw: ReturnType<typeof createFakeD1>['raw']) =>
    (raw.prepare('SELECT COUNT(*) AS n FROM routing_decisions').get() as { n: number }).n;

  it('deletes several rounds per tick, never more than the bound, and keeps recent rows', async () => {
    const { d1, raw } = createFakeD1();
    seedOrganization(raw, 'org-a');
    const now = Date.now();
    const old = now - ROUTING_RETENTION_MS - 1000;
    const backlog = ROUTING_PURGE_ROWS_PER_TICK * (ROUTING_PURGE_ROUNDS + 1);
    seed(raw, backlog, old);
    seed(raw, 10, now);
    const first = await purgeRoutingDecisions(d1, now);
    expect(first).toBe(ROUTING_PURGE_ROWS_PER_TICK * ROUTING_PURGE_ROUNDS);
    expect(count(raw)).toBe(ROUTING_PURGE_ROWS_PER_TICK + 10);
    expect(await purgeRoutingDecisions(d1, now)).toBe(ROUTING_PURGE_ROWS_PER_TICK);
    expect(await purgeRoutingDecisions(d1, now)).toBe(0);
    expect(count(raw)).toBe(10);
  });
});
