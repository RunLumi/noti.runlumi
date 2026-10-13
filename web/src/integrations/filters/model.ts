import { parseFilters, type FilterIssue } from '../../../../src/routing/filter-input';
import {
  EMPTY_FACTS,
  evaluateFilters,
  FILTER_IDS,
  type BotMode,
  type FilterConfig,
  type FilterId,
  type ReasonCode,
  type RouteDecision,
  type RoutingFacts,
} from '../../../../src/routing/filters';
import { t, tp, type MessageId } from '../../i18n';
import type { GithubEventType } from '../events';

/**
 * The dashboard's model of routing filters. The server's own parser and evaluator are imported
 * (pure TypeScript, no Workers types), not re-implemented, so a rule that the form accepts is
 * one the API accepts and the "Try it" check answers exactly as ingress would (ADR 0010).
 *
 * People type one entry per line; this module turns lines into the API shape and maps the
 * parser's field paths back onto the control that owns them.
 */
export type FilterControl =
  | 'branchAllow'
  | 'branchDeny'
  | 'baseAllow'
  | 'baseDeny'
  | 'bots'
  | 'peopleAllow'
  | 'peopleDeny'
  | 'labelsInclude'
  | 'labelsExclude'
  | 'form';
export type FilterErrors = Partial<Record<FilterControl, string>>;

export interface FilterDraft {
  readonly branchAllow: string;
  readonly branchDeny: string;
  readonly baseAllow: string;
  readonly baseDeny: string;
  readonly bots: BotMode;
  readonly peopleAllow: string;
  readonly peopleDeny: string;
  readonly skipDrafts: boolean;
  readonly labelsInclude: string;
  readonly labelsExclude: string;
}

export const EMPTY_FILTER_DRAFT: FilterDraft = {
  branchAllow: '',
  branchDeny: '',
  baseAllow: '',
  baseDeny: '',
  bots: 'any',
  peopleAllow: '',
  peopleDeny: '',
  skipDrafts: false,
  labelsInclude: '',
  labelsExclude: '',
};

const lines = (list: readonly string[] | undefined): string => (list ?? []).join('\n');

export function draftFromConfig(config: FilterConfig): FilterDraft {
  return {
    branchAllow: lines(config.branch?.allow),
    branchDeny: lines(config.branch?.deny),
    baseAllow: lines(config.baseBranch?.allow),
    baseDeny: lines(config.baseBranch?.deny),
    bots: config.actor?.bots ?? 'any',
    peopleAllow: lines(config.actor?.allow),
    peopleDeny: lines(config.actor?.deny),
    skipDrafts: config.draft === 'exclude',
    labelsInclude: lines(config.labels?.include),
    labelsExclude: lines(config.labels?.exclude),
  };
}

/** One entry per line. Blank lines are ignored; whitespace is trimmed by the parser. */
export function splitLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim() !== '');
}

/** The raw request value. The parser (not this function) decides what is valid. */
export function rawFilters(draft: FilterDraft): Record<string, unknown> {
  return {
    branch: { allow: splitLines(draft.branchAllow), deny: splitLines(draft.branchDeny) },
    baseBranch: { allow: splitLines(draft.baseAllow), deny: splitLines(draft.baseDeny) },
    actor: { allow: splitLines(draft.peopleAllow), deny: splitLines(draft.peopleDeny), bots: draft.bots },
    draft: draft.skipDrafts ? 'exclude' : null,
    labels: { include: splitLines(draft.labelsInclude), exclude: splitLines(draft.labelsExclude) },
  };
}

const CONTROL_OF: Readonly<Record<string, FilterControl>> = {
  'branch.allow': 'branchAllow',
  'branch.deny': 'branchDeny',
  'baseBranch.allow': 'baseAllow',
  'baseBranch.deny': 'baseDeny',
  'actor.bots': 'bots',
  'actor.allow': 'peopleAllow',
  'actor.deny': 'peopleDeny',
  'labels.include': 'labelsInclude',
  'labels.exclude': 'labelsExclude',
};

const ENTRY_ERROR: Readonly<Record<FilterControl, MessageId>> = {
  branchAllow: 'filters.error.pattern',
  branchDeny: 'filters.error.pattern',
  baseAllow: 'filters.error.pattern',
  baseDeny: 'filters.error.pattern',
  peopleAllow: 'filters.error.login',
  peopleDeny: 'filters.error.login',
  labelsInclude: 'filters.error.label',
  labelsExclude: 'filters.error.label',
  bots: 'filters.error.generic',
  form: 'filters.error.generic',
};

/**
 * Map a parser/server issue to the control that owns it, with translated copy. `filters.branch.
 * allow[2]` becomes "Line 3: ..." on the "Only these branches" box. Messages are ours, not the
 * server's, so they are translation-ready and never echo what was typed.
 */
export function describeIssue(issue: FilterIssue, draft?: FilterDraft): [FilterControl, string] {
  const m = /^filters\.([A-Za-z]+\.[A-Za-z]+)(?:\[(\d+)\])?$/.exec(issue.field);
  const control = m?.[1] ? CONTROL_OF[m[1]] : undefined;
  if (!control) {
    return ['form', t(issue.field === 'filters' ? 'filters.error.total' : 'filters.error.generic')];
  }
  if (m?.[2] === undefined) return [control, t('filters.error.tooMany')];
  // The parser indexes the cleaned list; the person counts lines in the box they typed.
  const index = Number(m[2]);
  const typed = draft ? rawLineNumber(draft, control, index) : index + 1;
  return [control, t(ENTRY_ERROR[control], { line: typed })];
}

function rawLineNumber(draft: FilterDraft, control: FilterControl, cleanedIndex: number): number {
  const text = draft[control as Exclude<FilterControl, 'bots' | 'form'>];
  return nthNonBlankLine(text, cleanedIndex);
}

/** Line number (1-based) in `text` of its `n`th (0-based) non-blank line. */
export function nthNonBlankLine(text: string, n: number): number {
  let seen = -1;
  const all = text.split(/\r?\n/);
  for (let i = 0; i < all.length; i++) {
    if ((all[i] ?? '').trim() !== '' && ++seen === n) return i + 1;
  }
  return n + 1;
}

export type FilterValidation =
  | { readonly ok: true; readonly config: FilterConfig }
  | { readonly ok: false; readonly errors: FilterErrors };

export function validateFilterDraft(draft: FilterDraft): FilterValidation {
  const parsed = parseFilters(rawFilters(draft));
  if (parsed.ok) return { ok: true, config: parsed.value };
  const errors: FilterErrors = {};
  for (const issue of parsed.errors) {
    const [control, message] = describeIssue(issue, draft);
    errors[control] ??= message;
  }
  return { ok: false, errors };
}

/** Server 422 field errors, shown beside the control that owns each. */
export function errorsFromServer(fields: readonly FilterIssue[], draft: FilterDraft): FilterErrors {
  const errors: FilterErrors = {};
  for (const issue of fields) {
    if (!issue.field.startsWith('filters')) continue;
    const [control, message] = describeIssue(issue, draft);
    errors[control] ??= message;
  }
  return errors;
}

export function filterCount(config: FilterConfig): number {
  return FILTER_IDS.filter((id) => config[id] !== undefined).length;
}

export function describeFilterCount(config: FilterConfig): string {
  const n = filterCount(config);
  return n === 0 ? t('filters.summary.none') : tp('filters.summary.count', n);
}

export const FILTER_NAME: Readonly<Record<FilterId, MessageId>> = {
  branch: 'filters.name.branch',
  baseBranch: 'filters.name.baseBranch',
  actor: 'filters.name.actor',
  draft: 'filters.name.draft',
  labels: 'filters.name.labels',
};

export const REASON_TEXT: Readonly<Record<ReasonCode | 'no_filters' | 'config_invalid', MessageId>> = {
  allowed: 'filters.reason.allowed',
  not_applicable: 'filters.reason.not_applicable',
  not_in_allow_list: 'filters.reason.not_in_allow_list',
  in_deny_list: 'filters.reason.in_deny_list',
  field_unknown: 'filters.reason.field_unknown',
  ghost_exempt: 'filters.reason.ghost_exempt',
  draft_excluded: 'filters.reason.draft_excluded',
  bot_excluded: 'filters.reason.bot_excluded',
  not_a_bot: 'filters.reason.not_a_bot',
  no_filters: 'filters.reason.no_filters',
  config_invalid: 'filters.reason.config_invalid',
};

/** Sentence for one decision, used by the tester and the recent-decisions list. */
export function describeDecision(
  decision: Pick<RouteDecision, 'pass' | 'unknown'> & { filterId: string | null; reason: string },
): string {
  if (!decision.pass) {
    const name = FILTER_NAME[decision.filterId as FilterId];
    const reason = REASON_TEXT[decision.reason as keyof typeof REASON_TEXT];
    return name && reason
      ? t('filters.result.skipped', { filter: t(name), reason: t(reason) })
      : t('filters.log.skipped');
  }
  if (decision.reason === 'ghost_exempt') return t('filters.result.sentGhost');
  return decision.unknown ? t('filters.result.sentUnknown') : t('filters.result.sent');
}

// --- "Try it" ---------------------------------------------------------------------------

export type Tri = 'unknown' | 'yes' | 'no';

export interface SampleDraft {
  readonly event: GithubEventType;
  readonly branch: string;
  readonly baseBranch: string;
  readonly login: string;
  readonly bot: Tri;
  readonly draft: Tri;
  readonly labels: string;
}

export const EMPTY_SAMPLE: SampleDraft = {
  event: 'pull_request.opened',
  branch: '',
  baseBranch: '',
  login: '',
  bot: 'unknown',
  draft: 'unknown',
  labels: '',
};

const triValue = (v: Tri): boolean | null => (v === 'unknown' ? null : v === 'yes');
const textOrNull = (v: string): string | null => (v.trim() === '' ? null : v.trim());

export function factsFromSample(sample: SampleDraft): RoutingFacts {
  const login = textOrNull(sample.login);
  return {
    ...EMPTY_FACTS,
    branch: textOrNull(sample.branch),
    baseBranch: textOrNull(sample.baseBranch),
    actorLogin: login,
    actorIsBot: triValue(sample.bot),
    // Same rule as ingress: GitHub's placeholder for a deleted account is the login "ghost".
    actorIsGhost: login === null ? null : login.toLowerCase() === 'ghost',
    draft: triValue(sample.draft),
    labels: splitLines(sample.labels).map((l) => l.trim()),
  };
}

export function runSample(config: FilterConfig, sample: SampleDraft): RouteDecision {
  return evaluateFilters(config, sample.event, factsFromSample(sample));
}
