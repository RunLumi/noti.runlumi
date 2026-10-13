import { compileGlob, fold, globMatchesFolded, GLOB_INPUT_MAX, type CompiledGlob } from './glob';

/**
 * Routing filters (docs/specs/10-routing-and-filtering.md F121, F124, F125, F127, F128, F136,
 * F138). A small CLOSED set: every filter is a typed, versioned definition in the registry
 * below with a pure `evaluate`. There is no expression language and nothing here computes; a
 * filter compares a normalised fact to literals the user typed.
 *
 * Filters only ever NARROW what an authorised connection receives. Authorization is the
 * verified GitHub installation (D3), never a filter.
 *
 * Evaluation reads {@link RoutingFacts} only, a minimal object extracted from the verified
 * payload. The payload itself is neither passed in nor stored (AGENTS.md privacy).
 *
 * Cost: a config is compiled once ({@link compileFilters}) and the facts are folded once
 * ({@link prepareFacts}) per request, however many integrations are evaluated.
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
  'unknown_fact',
  'ghost_exempt',
  'draft_excluded',
  'bot_excluded',
  'not_a_bot',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface FilterResult {
  readonly pass: boolean;
  readonly reason: ReasonCode;
  /**
   * A fact this filter needed was absent or could not be compared. Every configured filter
   * that applies to the event holds it back then (fail closed), because a deny list is often a
   * privacy control and "we did not know" must not mean "so it was sent".
   */
  readonly unknown: boolean;
}

/** A value folded (NFC, lower case) once. `tooLong` values are never compared (F124). */
interface Prepared {
  readonly folded: string;
  readonly tooLong: boolean;
}
export interface PreparedFacts {
  readonly branch: Prepared | null;
  readonly baseBranch: Prepared | null;
  readonly actorLogin: Prepared | null;
  readonly actorIsBot: boolean | null;
  readonly actorIsGhost: boolean | null;
  readonly draft: boolean | null;
  readonly labels: readonly Prepared[] | null;
}

function prepare(value: string | null): Prepared | null {
  if (value === null) return null;
  return value.length > GLOB_INPUT_MAX
    ? { folded: '', tooLong: true }
    : { folded: fold(value), tooLong: false };
}

/** Fold every string fact once per request. */
export function prepareFacts(facts: RoutingFacts): PreparedFacts {
  return {
    branch: prepare(facts.branch),
    baseBranch: prepare(facts.baseBranch),
    actorLogin: prepare(facts.actorLogin),
    actorIsBot: facts.actorIsBot,
    actorIsGhost: facts.actorIsGhost,
    draft: facts.draft,
    labels: facts.labels === null ? null : facts.labels.map((l) => prepare(l) as Prepared),
  };
}

type Matcher = (value: Prepared) => boolean | undefined;

interface CompiledList {
  /** The config had entries, even if some no longer compile: an allow list never becomes "allow all". */
  readonly present: boolean;
  readonly matchers: readonly Matcher[];
}
interface CompiledAllowDeny {
  readonly allow: CompiledList;
  readonly deny: CompiledList;
}
interface CompiledMap {
  readonly branch: CompiledAllowDeny;
  readonly baseBranch: CompiledAllowDeny;
  readonly actor: CompiledAllowDeny & { readonly bots: BotMode };
  readonly draft: true;
  readonly labels: { readonly include: CompiledList; readonly exclude: CompiledList };
}
export type CompiledFilters = { readonly [K in FilterId]?: CompiledMap[K] };

function globList(patterns: readonly string[]): CompiledList {
  const matchers: Matcher[] = [];
  for (const p of patterns) {
    const c = compileGlob(p);
    // A stored pattern that no longer compiles is skipped, never turned into a match-all.
    if (c.ok) {
      const glob: CompiledGlob = c.glob;
      matchers.push((v) => (v.tooLong ? undefined : globMatchesFolded(glob, v.folded)));
    }
  }
  return { present: patterns.length > 0, matchers };
}

function exactList(literals: readonly string[]): CompiledList {
  const set = new Set(literals.map(fold));
  return {
    present: literals.length > 0,
    matchers: set.size ? [(v) => (v.tooLong ? undefined : set.has(v.folded))] : [],
  };
}

const pass = (reason: ReasonCode = 'allowed'): FilterResult => ({ pass: true, reason, unknown: false });
const fail = (reason: ReasonCode): FilterResult => ({
  pass: false,
  reason,
  unknown: reason === 'unknown_fact',
});
const UNKNOWN = fail('unknown_fact');

/**
 * Deny wins; an allow list needs a known value to say yes. Any value that cannot be judged
 * (missing, or too long to compare) holds the event back as `unknown_fact`.
 */
function allowDeny(value: Prepared | null, allow: CompiledList, deny: CompiledList): FilterResult {
  if (!allow.present && !deny.present) return pass();
  if (value === null) return UNKNOWN;
  let undecidable = false;
  for (const match of deny.matchers) {
    const m = match(value);
    if (m === true) return fail('in_deny_list');
    if (m === undefined) undecidable = true;
  }
  if (deny.present && value.tooLong) undecidable = true;
  if (allow.present) {
    for (const match of allow.matchers) {
      const m = match(value);
      if (m === true) return undecidable ? UNKNOWN : pass();
      if (m === undefined) undecidable = true;
    }
    if (value.tooLong) undecidable = true;
    return undecidable ? UNKNOWN : fail('not_in_allow_list');
  }
  return undecidable ? UNKNOWN : pass();
}

export interface FilterDefinition<K extends FilterId> {
  readonly id: K;
  /** Bumped when the meaning of a stored config changes. Stored docs carry it. */
  readonly version: 1;
  /** Event types (catalog names) whose payloads carry the fact. Elsewhere the filter is skipped. */
  readonly appliesTo: (eventType: string) => boolean;
  /** True when this config cannot let an event through without knowing the fact ("only" lists). */
  readonly requiresFact: (config: NonNullable<FilterConfig[K]>) => boolean;
  readonly compile: (config: NonNullable<FilterConfig[K]>) => CompiledMap[K];
  readonly evaluate: (compiled: CompiledMap[K], facts: PreparedFacts) => FilterResult;
}

const PR_FAMILY = /^pull_request(?:_review(?:_comment)?)?\./;

const isPullRequestEvent = (t: string): boolean => PR_FAMILY.test(t);
/** Events whose payload names a branch (a release or deployment only when it carries one). */
const hasHeadBranch = (t: string): boolean =>
  t === 'push' ||
  isPullRequestEvent(t) ||
  t.startsWith('workflow_run.') ||
  t.startsWith('deployment_status.') ||
  t.startsWith('release.');
const hasLabels = (t: string): boolean =>
  isPullRequestEvent(t) || t.startsWith('issues.') || t.startsWith('issue_comment.');

const compileAllowDeny = (c: AllowDeny): CompiledAllowDeny => ({
  allow: globList(c.allow),
  deny: globList(c.deny),
});

export const FILTER_REGISTRY: { readonly [K in FilterId]: FilterDefinition<K> } = {
  branch: {
    id: 'branch',
    version: 1,
    appliesTo: hasHeadBranch,
    requiresFact: (c) => c.allow.length > 0,
    compile: compileAllowDeny,
    evaluate: (c, f) => allowDeny(f.branch, c.allow, c.deny),
  },
  baseBranch: {
    id: 'baseBranch',
    version: 1,
    appliesTo: isPullRequestEvent,
    requiresFact: (c) => c.allow.length > 0,
    compile: compileAllowDeny,
    evaluate: (c, f) => allowDeny(f.baseBranch, c.allow, c.deny),
  },
  actor: {
    id: 'actor',
    version: 1,
    appliesTo: () => true,
    requiresFact: () => false,
    compile: (c) => ({ allow: exactList(c.allow), deny: exactList(c.deny), bots: c.bots }),
    evaluate: (c, f) => {
      // F138/F151: a deleted account's placeholder user is never suppressed by an actor
      // filter, and is never treated as a bot. Missing a failure because its author left is
      // the exact failure this guards. It is the one exception to "unknown holds back".
      if (f.actorIsGhost === true) return pass('ghost_exempt');
      // `bots` reads the SENDER of the event (who caused it), not a pull request's author.
      if (c.bots === 'exclude') {
        if (f.actorIsBot === true) return fail('bot_excluded');
        if (f.actorIsBot === null) return UNKNOWN;
      } else if (c.bots === 'only') {
        if (f.actorIsBot === false) return fail('not_a_bot');
        if (f.actorIsBot === null) return UNKNOWN;
      }
      return allowDeny(f.actorLogin, c.allow, c.deny);
    },
  },
  draft: {
    id: 'draft',
    version: 1,
    appliesTo: isPullRequestEvent,
    requiresFact: () => false,
    compile: () => true,
    evaluate: (_c, f) => (f.draft === null ? UNKNOWN : f.draft ? fail('draft_excluded') : pass()),
  },
  labels: {
    id: 'labels',
    version: 1,
    appliesTo: hasLabels,
    requiresFact: (c) => c.include.length > 0,
    compile: (c) => ({ include: exactList(c.include), exclude: exactList(c.exclude) }),
    evaluate: (c, f) => {
      if (!c.include.present && !c.exclude.present) return pass();
      if (f.labels === null) return UNKNOWN;
      const has = (list: CompiledList): boolean =>
        list.matchers.some((m) => (f.labels ?? []).some((l) => m(l) === true));
      if (c.exclude.present && has(c.exclude)) return fail('in_deny_list');
      if (c.include.present) return has(c.include) ? pass() : fail('not_in_allow_list');
      return pass();
    },
  },
};

export function compileFilters(config: FilterConfig): CompiledFilters {
  const out: { -readonly [K in FilterId]?: CompiledMap[K] } = {};
  const set = <K extends FilterId>(id: K): void => {
    const c = config[id];
    if (c !== undefined) out[id] = FILTER_REGISTRY[id].compile(c);
  };
  for (const id of FILTER_IDS) set(id);
  return out;
}

export interface RouteDecision {
  readonly pass: boolean;
  /** The filter that suppressed the event, or null when it passed. */
  readonly filterId: FilterId | null;
  readonly reason: ReasonCode;
  readonly unknown: boolean;
}

function runFilter<K extends FilterId>(
  id: K,
  compiled: CompiledFilters,
  eventType: string,
  facts: PreparedFacts,
): FilterResult | null {
  const c = compiled[id];
  if (c === undefined) return null;
  const definition = FILTER_REGISTRY[id];
  if (!definition.appliesTo(eventType)) return pass('not_applicable');
  return definition.evaluate(c, facts);
}

/**
 * Evaluate every configured filter in registry order and stop at the first that suppresses.
 * Pure, bounded (list sizes and string lengths are capped at write time and again here), and
 * never throws on a hostile fact.
 */
export function evaluateCompiled(
  compiled: CompiledFilters,
  eventType: string,
  facts: PreparedFacts,
): RouteDecision {
  let exempt = false;
  for (const id of FILTER_IDS) {
    const result = runFilter(id, compiled, eventType, facts);
    if (!result) continue;
    exempt ||= result.reason === 'ghost_exempt';
    if (!result.pass) return { pass: false, filterId: id, reason: result.reason, unknown: result.unknown };
  }
  // A ghost exemption is surfaced even though the event passed: the user should be able to
  // see that a rule they wrote would otherwise have applied.
  return { pass: true, filterId: null, reason: exempt ? 'ghost_exempt' : 'allowed', unknown: false };
}

/** Convenience for one-off use (dry run, dashboard): compile, prepare, evaluate. */
export function evaluateFilters(config: FilterConfig, eventType: string, facts: RoutingFacts): RouteDecision {
  return evaluateCompiled(compileFilters(config), eventType, prepareFacts(facts));
}

export interface CoverageIssue {
  readonly filter: FilterId;
  /** Subscribed event types this filter cannot read a fact from. */
  readonly eventTypes: readonly string[];
}
export interface Coverage {
  /** "Only" lists that would be silently unenforced on these event types: refused at save. */
  readonly blocking: readonly CoverageIssue[];
  /** "Never" rules that would not apply to these event types: allowed, and reported. */
  readonly warnings: readonly CoverageIssue[];
}

function coverageOf<K extends FilterId>(
  id: K,
  config: FilterConfig,
  eventTypes: readonly string[],
): { blocking: boolean; issue: CoverageIssue } | null {
  const c = config[id];
  if (c === undefined) return null;
  const def = FILTER_REGISTRY[id];
  const missing = eventTypes.filter((t) => !def.appliesTo(t));
  if (missing.length === 0) return null;
  return { blocking: def.requiresFact(c), issue: { filter: id, eventTypes: missing } };
}

/**
 * Which configured filters cannot read a fact from some subscribed event types (H2). A filter
 * that does not apply to an event type is skipped there, so an "only" list would silently let
 * those events through: that combination is rejected when saving. A "never" rule is merely
 * incomplete there, so it is reported.
 */
export function filterCoverage(config: FilterConfig, eventTypes: readonly string[]): Coverage {
  const blocking: CoverageIssue[] = [];
  const warnings: CoverageIssue[] = [];
  for (const id of FILTER_IDS) {
    const r = coverageOf(id, config, eventTypes);
    if (r) (r.blocking ? blocking : warnings).push(r.issue);
  }
  return { blocking, warnings };
}
