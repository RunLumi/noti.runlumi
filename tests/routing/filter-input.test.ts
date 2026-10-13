import { describe, expect, it } from 'vitest';
import { extractGithubFacts } from '../../src/connectors/sources/github/facts';
import {
  activeFilterIds,
  changedFilterIds,
  LABEL_MAX,
  MAX_ENTRIES_PER_LIST,
  parseFacts,
  parseFilters,
  readStoredFilters,
  serializeFilters,
} from '../../src/routing/filter-input';

function ok(raw: unknown) {
  const r = parseFilters(raw);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
}
function fields(raw: unknown): string[] {
  const r = parseFilters(raw);
  return r.ok ? [] : r.errors.map((e) => e.field);
}

describe('parseFilters', () => {
  it('treats null and {} as no filters, and drops empty or default members', () => {
    expect(ok(null)).toEqual({});
    expect(ok({})).toEqual({});
    expect(ok({ branch: { allow: [], deny: [] }, actor: { bots: 'any' }, labels: {}, draft: false })).toEqual(
      {},
    );
    expect(serializeFilters({})).toBeNull();
  });

  it('normalises: trims, drops case-insensitive duplicates, keeps the first spelling', () => {
    expect(ok({ branch: { allow: [' main ', 'MAIN', 'dev'] } })).toEqual({
      branch: { allow: ['main', 'dev'], deny: [] },
    });
    expect(ok({ labels: { include: ['Bug', 'bug'] } })).toEqual({
      labels: { include: ['Bug'], exclude: [] },
    });
  });

  it('accepts every filter together', () => {
    const value = ok({
      branch: { allow: ['main', 'release/**'], deny: ['wip/*'] },
      baseBranch: { allow: ['main'] },
      actor: { allow: ['alice'], deny: ['dependabot[bot]'], bots: 'exclude' },
      draft: 'exclude',
      labels: { include: ['bug'], exclude: ['wontfix'] },
    });
    expect(activeFilterIds(value)).toEqual(['branch', 'baseBranch', 'actor', 'draft', 'labels']);
  });

  it.each([
    ['not an object', 'x', ['filters']],
    ['an array', [], ['filters']],
    ['unknown filter', { regex: {} }, ['filters.regex']],
    ['unknown option', { branch: { allow: ['a'], regex: 'x' } }, ['filters.branch.regex']],
    ['non-list', { branch: { allow: 'main' } }, ['filters.branch.allow']],
    ['non-string entry', { branch: { allow: [1] } }, ['filters.branch.allow[0]']],
    ['empty entry', { branch: { deny: ['  '] } }, ['filters.branch.deny[0]']],
    ['unsupported glob', { branch: { allow: ['a?b'] } }, ['filters.branch.allow[0]']],
    ['negated glob', { branch: { allow: ['!main'] } }, ['filters.branch.allow[0]']],
    ['bad bot mode', { actor: { bots: 'maybe' } }, ['filters.actor.bots']],
    ['bad draft value', { draft: 'only' }, ['filters.draft']],
    ['bad login', { actor: { allow: ['a b'] } }, ['filters.actor.allow[0]']],
    ['ghost in a deny list (F151)', { actor: { deny: ['Ghost'] } }, ['filters.actor.deny[0]']],
    ['over-long label', { labels: { include: ['x'.repeat(LABEL_MAX + 1)] } }, ['filters.labels.include[0]']],
    ['control character in a label', { labels: { exclude: ['a\u0000b'] } }, ['filters.labels.exclude[0]']],
    [
      'bidi override in a label',
      { labels: { exclude: [`a${String.fromCharCode(0x202e)}b`] } },
      ['filters.labels.exclude[0]'],
    ],
    [
      'too many entries',
      { branch: { allow: Array.from({ length: MAX_ENTRIES_PER_LIST + 1 }, (_, i) => `b${i}`) } },
      ['filters.branch.allow'],
    ],
  ])('rejects %s', (_name, raw, expected) => {
    expect(fields(raw)).toEqual(expected);
  });

  it('rejects more than the total entry budget even when each list is within bounds', () => {
    const list = (p: string) => Array.from({ length: MAX_ENTRIES_PER_LIST }, (_, i) => `${p}${i}`);
    const f = fields({
      branch: { allow: list('a'), deny: list('b') },
      baseBranch: { allow: list('c'), deny: list('d') },
      labels: { include: list('e') },
    });
    expect(f).toEqual(['filters']);
  });

  it('never echoes a rejected value in a message', () => {
    const r = parseFilters({ branch: { allow: ['super-secret?name'] }, actor: { allow: ['bad name!'] } });
    expect(JSON.stringify(r)).not.toContain('super-secret');
    expect(JSON.stringify(r)).not.toContain('bad name');
  });
});

describe('stored documents', () => {
  it('round-trips through serialise and read', () => {
    const config = ok({ branch: { allow: ['main'] }, draft: 'exclude' });
    const json = serializeFilters(config);
    expect(JSON.parse(json ?? '{}')).toMatchObject({ v: 1 });
    expect(readStoredFilters(json)).toEqual({ kind: 'ok', config });
  });

  it.each([
    ['null', null, 'none'],
    ['empty string', '', 'none'],
    ['empty document', '{"v":1}', 'none'],
    ['not JSON', '{nope', 'invalid'],
    ['an array', '[]', 'invalid'],
    ['a newer version (rollback)', '{"v":2,"draft":"exclude"}', 'newer'],
    ['missing version', '{"draft":"exclude"}', 'invalid'],
    ['a value that no longer validates', '{"v":1,"branch":{"allow":["a?b"]}}', 'invalid'],
  ])('reads %s as %s', (_name, json, kind) => {
    expect(readStoredFilters(json).kind).toBe(kind);
  });

  it('reports changed filter ids only', () => {
    const before = ok({ branch: { allow: ['main'] }, draft: 'exclude' });
    const after = ok({ branch: { allow: ['main', 'dev'] }, labels: { include: ['bug'] } });
    expect(changedFilterIds(before, after)).toEqual(['branch', 'draft', 'labels']);
    expect(changedFilterIds(before, before)).toEqual([]);
  });
});

describe('parseFacts (sample facts for the dry run)', () => {
  it('treats missing keys as unknown (null), never as false or empty', () => {
    const r = parseFacts({});
    expect(r.ok && r.value).toEqual({
      branch: null,
      baseBranch: null,
      actorLogin: null,
      actorIsBot: null,
      actorIsGhost: null,
      draft: null,
      labels: null,
    });
  });

  it.each([
    ['unknown key', { payload: {} }],
    ['string flag', { draft: 'yes' }],
    ['numeric branch', { branch: 5 }],
    ['over-long branch', { branch: 'a'.repeat(256) }],
    ['label list too long', { labels: Array(101).fill('x') }],
    ['non-string label', { labels: [1] }],
    ['not an object', 'x'],
  ])('rejects %s', (_n, raw) => {
    expect(parseFacts(raw).ok).toBe(false);
  });

  it('keeps an empty label list distinct from absent', () => {
    const r = parseFacts({ labels: [] });
    expect(r.ok && r.value.labels).toEqual([]);
  });
});

describe('extractGithubFacts', () => {
  const pr = {
    sender: { login: 'dependabot[bot]', type: 'Bot' },
    pull_request: {
      draft: true,
      head: { ref: 'dependabot/npm/x' },
      base: { ref: 'main' },
      labels: [{ name: 'dependencies' }, { name: 'bug' }, { nope: 1 }],
      body: 'must never be carried',
    },
  };

  it('extracts the minimal facts from a pull_request payload', () => {
    expect(extractGithubFacts('pull_request', pr)).toEqual({
      branch: 'dependabot/npm/x',
      baseBranch: 'main',
      actorLogin: 'dependabot[bot]',
      actorIsBot: true,
      actorIsGhost: false,
      draft: true,
      labels: ['dependencies', 'bug'],
    });
  });

  it('uses the pushed branch, and nothing for a tag', () => {
    expect(extractGithubFacts('push', { ref: 'refs/heads/release/1' }).branch).toBe('release/1');
    expect(extractGithubFacts('push', { ref: 'refs/tags/v1' }).branch).toBeNull();
  });

  it('uses head_branch for a workflow run', () => {
    expect(extractGithubFacts('workflow_run', { workflow_run: { head_branch: 'main' } }).branch).toBe('main');
  });

  it('reads issue labels, and keeps an empty list distinct from none', () => {
    expect(extractGithubFacts('issues', { issue: { labels: [] } }).labels).toEqual([]);
    expect(extractGithubFacts('issues', { issue: {} }).labels).toBeNull();
  });

  it('never invents facts: a payload without a sender has unknown actor flags', () => {
    const f = extractGithubFacts('push', { ref: 'refs/heads/x' });
    expect(f.actorLogin).toBeNull();
    expect(f.actorIsBot).toBeNull();
    expect(f.actorIsGhost).toBeNull();
    expect(f.draft).toBeNull();
  });

  it('recognises the ghost placeholder user and does not call it a bot', () => {
    const f = extractGithubFacts('issues', { sender: { login: 'ghost', type: 'User' } });
    expect(f.actorIsGhost).toBe(true);
    expect(f.actorIsBot).toBe(false);
  });

  it('bounds label count and length', () => {
    const labels = Array.from({ length: 300 }, () => ({ name: 'x'.repeat(500) }));
    const f = extractGithubFacts('issues', { issue: { labels } });
    expect(f.labels).toHaveLength(100);
    expect(f.labels?.[0]).toHaveLength(LABEL_MAX);
  });
});
