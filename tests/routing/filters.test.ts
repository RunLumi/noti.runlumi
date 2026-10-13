import { describe, expect, it } from 'vitest';
import {
  EMPTY_FACTS,
  evaluateFilters,
  FILTER_IDS,
  FILTER_REGISTRY,
  type FilterConfig,
  type RoutingFacts,
} from '../../src/routing/filters';

const facts = (over: Partial<RoutingFacts> = {}): RoutingFacts => ({ ...EMPTY_FACTS, ...over });

interface Row {
  name: string;
  config: FilterConfig;
  event: string;
  facts: Partial<RoutingFacts>;
  pass: boolean;
  filterId?: string;
  reason: string;
  unknown?: boolean;
}

const rows: Row[] = [
  // branch
  {
    name: 'branch allow hit',
    config: { branch: { allow: ['main'], deny: [] } },
    event: 'push',
    facts: { branch: 'main' },
    pass: true,
    reason: 'allowed',
  },
  {
    name: 'branch allow miss',
    config: { branch: { allow: ['main'], deny: [] } },
    event: 'push',
    facts: { branch: 'dev' },
    pass: false,
    filterId: 'branch',
    reason: 'not_in_allow_list',
  },
  {
    name: 'branch glob',
    config: { branch: { allow: ['release/**'], deny: [] } },
    event: 'workflow_run.failure',
    facts: { branch: 'release/1.2/x' },
    pass: true,
    reason: 'allowed',
  },
  {
    name: 'branch deny wins over allow',
    config: { branch: { allow: ['**'], deny: ['wip/*'] } },
    event: 'push',
    facts: { branch: 'wip/x' },
    pass: false,
    filterId: 'branch',
    reason: 'in_deny_list',
  },
  {
    name: 'branch deny only, other branch passes',
    config: { branch: { allow: [], deny: ['wip/*'] } },
    event: 'push',
    facts: { branch: 'main' },
    pass: true,
    reason: 'allowed',
  },
  {
    name: 'branch allow with unknown branch is held back and flagged',
    config: { branch: { allow: ['main'], deny: [] } },
    event: 'push',
    facts: {},
    pass: false,
    filterId: 'branch',
    reason: 'field_unknown',
    unknown: true,
  },
  {
    name: 'branch deny with unknown branch passes but is flagged',
    config: { branch: { allow: [], deny: ['wip/*'] } },
    event: 'push',
    facts: {},
    pass: true,
    reason: 'allowed',
    unknown: true,
  },
  {
    name: 'branch filter is skipped for events without a branch',
    config: { branch: { allow: ['main'], deny: [] } },
    event: 'issues.opened',
    facts: {},
    pass: true,
    reason: 'allowed',
  },
  {
    name: 'branch over-long value is unknown, not a truncated match',
    config: { branch: { allow: ['**'], deny: [] } },
    event: 'push',
    facts: { branch: 'a'.repeat(300) },
    pass: false,
    filterId: 'branch',
    reason: 'field_unknown',
    unknown: true,
  },
  // base branch
  {
    name: 'base branch allow hit',
    config: { baseBranch: { allow: ['main'], deny: [] } },
    event: 'pull_request.opened',
    facts: { baseBranch: 'main' },
    pass: true,
    reason: 'allowed',
  },
  {
    name: 'base branch miss',
    config: { baseBranch: { allow: ['main'], deny: [] } },
    event: 'pull_request.merged',
    facts: { baseBranch: 'dev' },
    pass: false,
    filterId: 'baseBranch',
    reason: 'not_in_allow_list',
  },
  {
    name: 'base branch not applicable to push',
    config: { baseBranch: { allow: ['main'], deny: [] } },
    event: 'push',
    facts: { baseBranch: 'dev' },
    pass: true,
    reason: 'allowed',
  },
  // actor
  {
    name: 'exclude bots drops a bot',
    config: { actor: { allow: [], deny: [], bots: 'exclude' } },
    event: 'pull_request.opened',
    facts: { actorLogin: 'dependabot[bot]', actorIsBot: true },
    pass: false,
    filterId: 'actor',
    reason: 'bot_excluded',
  },
  {
    name: 'exclude bots keeps a human',
    config: { actor: { allow: [], deny: [], bots: 'exclude' } },
    event: 'issues.opened',
    facts: { actorLogin: 'octocat', actorIsBot: false },
    pass: true,
    reason: 'allowed',
  },
  {
    name: 'exclude bots with unknown bot status passes but is flagged',
    config: { actor: { allow: [], deny: [], bots: 'exclude' } },
    event: 'issues.opened',
    facts: { actorLogin: 'x' },
    pass: true,
    reason: 'allowed',
    unknown: true,
  },
  {
    name: 'only bots drops a human',
    config: { actor: { allow: [], deny: [], bots: 'only' } },
    event: 'issues.opened',
    facts: { actorLogin: 'octocat', actorIsBot: false },
    pass: false,
    filterId: 'actor',
    reason: 'not_a_bot',
  },
  {
    name: 'only bots with unknown status is held back and flagged',
    config: { actor: { allow: [], deny: [], bots: 'only' } },
    event: 'issues.opened',
    facts: { actorLogin: 'x' },
    pass: false,
    filterId: 'actor',
    reason: 'field_unknown',
    unknown: true,
  },
  {
    name: 'actor deny is case-insensitive',
    config: { actor: { allow: [], deny: ['Octocat'], bots: 'any' } },
    event: 'push',
    facts: { actorLogin: 'octocat' },
    pass: false,
    filterId: 'actor',
    reason: 'in_deny_list',
  },
  {
    name: 'actor allow list hit',
    config: { actor: { allow: ['alice', 'bob'], deny: [], bots: 'any' } },
    event: 'push',
    facts: { actorLogin: 'BOB' },
    pass: true,
    reason: 'allowed',
  },
  {
    name: 'actor allow list miss',
    config: { actor: { allow: ['alice'], deny: [], bots: 'any' } },
    event: 'push',
    facts: { actorLogin: 'eve' },
    pass: false,
    filterId: 'actor',
    reason: 'not_in_allow_list',
  },
  {
    name: 'a deleted account is never suppressed by an actor filter',
    config: { actor: { allow: ['alice'], deny: [], bots: 'exclude' } },
    event: 'workflow_run.failure',
    facts: { actorLogin: 'ghost', actorIsGhost: true, actorIsBot: false },
    pass: true,
    reason: 'ghost_exempt',
  },
  {
    name: 'ghost is exempt even from only-bots',
    config: { actor: { allow: [], deny: [], bots: 'only' } },
    event: 'push',
    facts: { actorLogin: 'ghost', actorIsGhost: true, actorIsBot: false },
    pass: true,
    reason: 'ghost_exempt',
  },
  // draft
  {
    name: 'draft PR excluded',
    config: { draft: 'exclude' },
    event: 'pull_request.opened',
    facts: { draft: true },
    pass: false,
    filterId: 'draft',
    reason: 'draft_excluded',
  },
  {
    name: 'ready PR passes',
    config: { draft: 'exclude' },
    event: 'pull_request.ready_for_review',
    facts: { draft: false },
    pass: true,
    reason: 'allowed',
  },
  {
    name: 'unknown draft state passes but is flagged',
    config: { draft: 'exclude' },
    event: 'pull_request.opened',
    facts: {},
    pass: true,
    reason: 'allowed',
    unknown: true,
  },
  {
    name: 'draft is skipped for issues',
    config: { draft: 'exclude' },
    event: 'issues.opened',
    facts: { draft: true },
    pass: true,
    reason: 'allowed',
  },
  // labels
  {
    name: 'label include hit',
    config: { labels: { include: ['bug'], exclude: [] } },
    event: 'issues.opened',
    facts: { labels: ['Bug', 'p1'] },
    pass: true,
    reason: 'allowed',
  },
  {
    name: 'label include miss',
    config: { labels: { include: ['bug'], exclude: [] } },
    event: 'pull_request.opened',
    facts: { labels: ['docs'] },
    pass: false,
    filterId: 'labels',
    reason: 'not_in_allow_list',
  },
  {
    name: 'label include is element membership, not substring',
    config: { labels: { include: ['bug'], exclude: [] } },
    event: 'issues.opened',
    facts: { labels: ['debug'] },
    pass: false,
    filterId: 'labels',
    reason: 'not_in_allow_list',
  },
  {
    name: 'empty label list is a fact: include fails without being unknown',
    config: { labels: { include: ['bug'], exclude: [] } },
    event: 'issues.opened',
    facts: { labels: [] },
    pass: false,
    filterId: 'labels',
    reason: 'not_in_allow_list',
    unknown: false,
  },
  {
    name: 'absent labels: include fails as unknown',
    config: { labels: { include: ['bug'], exclude: [] } },
    event: 'issues.opened',
    facts: {},
    pass: false,
    filterId: 'labels',
    reason: 'field_unknown',
    unknown: true,
  },
  {
    name: 'label exclude hit',
    config: { labels: { include: [], exclude: ['wontfix'] } },
    event: 'issue_comment.created',
    facts: { labels: ['wontfix'] },
    pass: false,
    filterId: 'labels',
    reason: 'in_deny_list',
  },
  {
    name: 'empty label list satisfies exclude',
    config: { labels: { include: [], exclude: ['wontfix'] } },
    event: 'issues.opened',
    facts: { labels: [] },
    pass: true,
    reason: 'allowed',
  },
  {
    name: 'labels skipped for push',
    config: { labels: { include: ['bug'], exclude: [] } },
    event: 'push',
    facts: {},
    pass: true,
    reason: 'allowed',
  },
  // combination and order
  {
    name: 'first failing filter in registry order is the reason',
    config: { branch: { allow: ['main'], deny: [] }, draft: 'exclude' },
    event: 'pull_request.opened',
    facts: { branch: 'dev', draft: true },
    pass: false,
    filterId: 'branch',
    reason: 'not_in_allow_list',
  },
  { name: 'no filters passes', config: {}, event: 'push', facts: {}, pass: true, reason: 'allowed' },
];

describe('filter evaluation (F124, F127, F128, F138)', () => {
  it.each(rows)('$name', (row) => {
    const d = evaluateFilters(row.config, row.event, facts(row.facts));
    expect(d.pass).toBe(row.pass);
    expect(d.filterId).toBe(row.filterId ?? null);
    expect(d.reason).toBe(row.reason);
    expect(d.unknown).toBe(row.unknown ?? false);
  });

  it('never reads or returns field values: the decision is ids and codes only', () => {
    const d = evaluateFilters(
      { branch: { allow: ['secret-branch'], deny: [] } },
      'push',
      facts({ branch: 'other' }),
    );
    expect(JSON.stringify(d)).not.toContain('secret-branch');
    expect(JSON.stringify(d)).not.toContain('other');
  });

  it('does not mutate its inputs', () => {
    const config: FilterConfig = { labels: { include: ['bug'], exclude: [] } };
    const f = facts({ labels: ['bug'] });
    const before = JSON.stringify([config, f]);
    evaluateFilters(config, 'issues.opened', f);
    expect(JSON.stringify([config, f])).toBe(before);
  });

  it('skips a stored pattern that no longer compiles instead of matching everything', () => {
    // An allow list whose only pattern is invalid matches nothing, so the event is held back.
    const d = evaluateFilters(
      { branch: { allow: ['a?b'], deny: [] } },
      'push',
      facts({ branch: 'anything' }),
    );
    expect(d.pass).toBe(false);
  });

  it('survives hostile fact sizes quickly', () => {
    const started = performance.now();
    const config: FilterConfig = {
      branch: { allow: Array(32).fill('**a**a**a**'), deny: Array(32).fill('*b*b*b*') },
      labels: { include: Array(32).fill('x'), exclude: Array(32).fill('y') },
      actor: { allow: Array(32).fill('z'), deny: Array(32).fill('w'), bots: 'exclude' },
    };
    const huge = facts({
      branch: 'a'.repeat(1_000_000),
      actorLogin: 'z'.repeat(1_000_000),
      labels: Array(100).fill('q'.repeat(1_000_000)),
    });
    for (const event of ['push', 'pull_request.opened', 'issues.opened'])
      evaluateFilters(config, event, huge);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('registry', () => {
  it('has exactly one versioned definition per filter id', () => {
    expect(Object.keys(FILTER_REGISTRY).sort()).toEqual([...FILTER_IDS].sort());
    for (const id of FILTER_IDS) {
      expect(FILTER_REGISTRY[id].id).toBe(id);
      expect(FILTER_REGISTRY[id].version).toBe(1);
    }
  });
});
