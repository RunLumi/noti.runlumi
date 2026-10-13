import { compileGlob, fold, globMatches, GLOB_INPUT_MAX, type CompiledGlob } from './glob';

/**
 * Routing filters (docs/specs/10-routing-and-filtering.md F121, F124, F125, F127, F128, F136,
 * F138). A small CLOSED set: every filter is a typed, versioned definition in the registry
 * below with a pure `evaluate(config, facts)`. There is no expression language and nothing
 * here computes; a filter compares a normalised fact to literals the user typed.
 *
 * Filters only ever NARROW what an authorised connection receives. Authorization is the
 * verified GitHub installation (D3), never a filter.
 *
 * Evaluation reads {@link RoutingFacts} only, a minimal object extracted from the verified
 * payload. The payload itself is neither passed in nor stored (AGENTS.md privacy).
 */
export const FILTER_IDS = ['branch', 'baseBranch', 'actor', 'draft', 'labels'] as const;
export type FilterId = (typeof FILTER_IDS)[number];

export const BOT_MODES = ['any', 'exclude', 'only'] as const;
export type BotMode = (typeof BOT_MODES)[number];

export interface AllowDeny {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
}
export interface ActorFilter extends AllowDeny {
  readonly bots: BotMode;
}
export interface LabelFilter {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

/** The stored and API shape. A missing key means "no condition". `{}` means no filters. */
export interface FilterConfig {
  readonly branch?: AllowDeny;
  readonly baseBranch?: AllowDeny;
  readonly actor?: ActorFilter;
  readonly draft?: 'exclude';
  readonly labels?: LabelFilter;
}

/**
 * Facts a filter may read. `null` is "the source did not say" (F124): it is never coerced to
 * `false`, `''` or `[]`. An empty `labels` array is a fact ("there are no labels"); `null` is not.
 */
export interface RoutingFacts {
  readonly branch: string | null;
  readonly baseBranch: string | null;
  readonly actorLogin: string | null;
  readonly actorIsBot: boolean | null;
  readonly actorIsGhost: boolean | null;
  readonly draft: boolean | null;
  readonly labels: readonly string[] | null;
}

export const EMPTY_FACTS: RoutingFacts = {
  branch: null,
  baseBranch: null,
  actorLogin: null,
  actorIsBot: null,
  actorIsGhost: null,
  draft: null,
  labels: null,
};

/** Closed vocabulary. Stored in provenance rows and rendered by the dashboard. */
export const REASON_CODES = [
  'allowed',
  'not_applicable',
  'not_in_allow_list',
  'in_deny_list',
  'field_unknown',
  'ghost_exempt',
  'draft_excluded',
  'bot_excluded',
  'not_a_bot',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface FilterResult {
  readonly pass: boolean;
  readonly reason: ReasonCode;
  /** A fact this filter needed was absent. Never silent: it is recorded even when it passes. */
  readonly unknown: boolean;
}

export interface FilterDefinition<K extends FilterId> {
  readonly id: K;
  /** Bumped when the meaning of a stored config changes. Stored docs carry it. */
  readonly version: 1;
  /** Event types (catalog names) whose payloads carry the fact. Elsewhere the filter is skipped. */
  readonly appliesTo: (eventType: string) => boolean;
  readonly evaluate: (config: NonNullable<FilterConfig[K]>, facts: RoutingFacts) => FilterResult;
}

const PR_FAMILY = /^pull_request(?:_review(?:_comment)?)?\./;

const isPullRequestEvent = (t: string): boolean => PR_FAMILY.test(t);
const hasHeadBranch = (t: string): boolean =>
  t === 'push' || isPullRequestEvent(t) || t.startsWith('workflow_run.');
const hasLabels = (t: string): boolean =>
  isPullRequestEvent(t) || t.startsWith('issues.') || t.startsWith('issue_comment.');

const pass = (reason: ReasonCode = 'allowed', unknown = false): FilterResult => ({
  pass: true,
  reason,
  unknown,
});
const fail = (reason: ReasonCode, unknown = false): FilterResult => ({ pass: false, reason, unknown });

type Matcher = (value: string) => boolean | undefined;

function globMatcher(patterns: readonly string[]): Matcher[] {
  const compiled: CompiledGlob[] = [];
  for (const p of patterns) {
    const c = compileGlob(p);
    // A stored pattern that no longer compiles is skipped, never turned into a match-all.
    if (c.ok) compiled.push(c.glob);
  }
  return compiled.map((g) => (value) => globMatches(g, value));
}

function exactMatcher(literals: readonly string[]): Matcher[] {
  return literals.map((literal) => {
    const folded = fold(literal);
    return (value) => (value.length > GLOB_INPUT_MAX ? undefined : fold(value) === folded);
  });
}

/**
 * Allow/deny over one nullable string. Deny wins. An allow list needs a known value to say
 * yes: when the fact is unknown the event is held back and the reason says why (F124); a deny
 * list never excludes on an unknown value.
 */
function allowDeny(
  value: string | null,
  allow: readonly Matcher[],
  hasAllow: boolean,
  deny: readonly Matcher[],
): FilterResult {
  let unknown = false;
  if (deny.length > 0) {
    if (value === null) unknown = true;
    else
      for (const match of deny) {
        const m = match(value);
        if (m === undefined) unknown = true;
        else if (m) return fail('in_deny_list');
      }
  }
  if (!hasAllow) return pass('allowed', unknown);
  if (value === null) return fail('field_unknown', true);
  let undecidable = false;
  for (const match of allow) {
    const m = match(value);
    if (m === true) return pass('allowed', unknown);
    if (m === undefined) undecidable = true;
  }
  return fail(undecidable ? 'field_unknown' : 'not_in_allow_list', undecidable);
}

function branchEvaluate(config: AllowDeny, value: string | null): FilterResult {
  return allowDeny(value, globMatcher(config.allow), config.allow.length > 0, globMatcher(config.deny));
}

export const FILTER_REGISTRY: { readonly [K in FilterId]: FilterDefinition<K> } = {
  branch: {
    id: 'branch',
    version: 1,
    appliesTo: hasHeadBranch,
    evaluate: (config, facts) => branchEvaluate(config, facts.branch),
  },
  baseBranch: {
    id: 'baseBranch',
    version: 1,
    appliesTo: isPullRequestEvent,
    evaluate: (config, facts) => branchEvaluate(config, facts.baseBranch),
  },
  actor: {
    id: 'actor',
    version: 1,
    appliesTo: () => true,
    evaluate: (config, facts) => {
      // F138/F151: a deleted account's placeholder user is never suppressed by an actor
      // filter, and is never treated as a bot. Missing a failure because its author left is
      // the exact failure this guards.
      if (facts.actorIsGhost === true) return pass('ghost_exempt');
      let unknown = false;
      if (config.bots === 'exclude') {
        if (facts.actorIsBot === true) return fail('bot_excluded');
        if (facts.actorIsBot === null) unknown = true;
      } else if (config.bots === 'only') {
        if (facts.actorIsBot === false) return fail('not_a_bot');
        if (facts.actorIsBot === null) return fail('field_unknown', true);
      }
      const byLogin = allowDeny(
        facts.actorLogin,
        exactMatcher(config.allow),
        config.allow.length > 0,
        exactMatcher(config.deny),
      );
      return byLogin.pass ? pass(byLogin.reason, unknown || byLogin.unknown) : byLogin;
    },
  },
  draft: {
    id: 'draft',
    version: 1,
    appliesTo: isPullRequestEvent,
    evaluate: (_config, facts) =>
      facts.draft === true ? fail('draft_excluded') : pass('allowed', facts.draft === null),
  },
  labels: {
    id: 'labels',
    version: 1,
    appliesTo: hasLabels,
    evaluate: (config, facts) => {
      const labels = facts.labels;
      let unknown = false;
      const has = (wanted: readonly string[]): boolean => {
        const set = new Set(wanted.map(fold));
        return (labels ?? []).some((l) => l.length <= GLOB_INPUT_MAX && set.has(fold(l)));
      };
      if (config.exclude.length > 0) {
        if (labels === null) unknown = true;
        else if (has(config.exclude)) return fail('in_deny_list');
      }
      if (config.include.length > 0) {
        if (labels === null) return fail('field_unknown', true);
        return has(config.include) ? pass('allowed', unknown) : fail('not_in_allow_list');
      }
      return pass('allowed', unknown);
    },
  },
};

export interface RouteDecision {
  readonly pass: boolean;
  /** The filter that suppressed the event, or null when it passed. */
  readonly filterId: FilterId | null;
  readonly reason: ReasonCode;
  readonly unknown: boolean;
}

function runFilter<K extends FilterId>(
  id: K,
  config: FilterConfig,
  eventType: string,
  facts: RoutingFacts,
): FilterResult | null {
  const filterConfig = config[id];
  if (filterConfig === undefined) return null;
  const definition = FILTER_REGISTRY[id];
  if (!definition.appliesTo(eventType)) return pass('not_applicable');
  return definition.evaluate(filterConfig, facts);
}

/**
 * Evaluate every configured filter in registry order and stop at the first that suppresses.
 * Pure, bounded (list sizes and string lengths are capped at write time and again here), and
 * never throws on a hostile fact.
 */
export function evaluateFilters(config: FilterConfig, eventType: string, facts: RoutingFacts): RouteDecision {
  let unknown = false;
  let exempt = false;
  for (const id of FILTER_IDS) {
    const result = runFilter(id, config, eventType, facts);
    if (!result) continue;
    unknown ||= result.unknown;
    exempt ||= result.reason === 'ghost_exempt';
    if (!result.pass) return { pass: false, filterId: id, reason: result.reason, unknown };
  }
  // A ghost exemption is surfaced even though the event passed: the user should be able to
  // see that a rule they wrote would otherwise have applied.
  return { pass: true, filterId: null, reason: exempt ? 'ghost_exempt' : 'allowed', unknown };
}
