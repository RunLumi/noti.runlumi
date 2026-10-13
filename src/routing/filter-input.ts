import { asRecord } from '../lib/json';
import {
  BOT_MODES,
  FILTER_IDS,
  type BotMode,
  type FilterConfig,
  type FilterId,
  type RoutingFacts,
} from './filters';
import { CONTROL_CHARS, compileGlob, fold, GLOB_INPUT_MAX } from './glob';

/**
 * Validation, normalisation and storage of filter configs. Everything user-supplied passes
 * through here before it is stored or evaluated; messages name the field and the rule and
 * never echo the value (a response may be logged by a proxy).
 */
export interface FilterIssue {
  readonly field: string;
  readonly message: string;
}
export type FilterParse =
  | { readonly ok: true; readonly value: FilterConfig }
  | { readonly ok: false; readonly errors: FilterIssue[] };

/** Entries per list, and across the whole config. Product bounds that also bound CPU. */
export const MAX_ENTRIES_PER_LIST = 32;
export const MAX_ENTRIES_TOTAL = 128;
export const LOGIN_MAX = 64;
export const LABEL_MAX = 100;
/** Version of the stored document. Bump together with the registry definition versions. */
export const STORED_VERSION = 1;
/** Serialised-size ceiling; the migration's CHECK enforces the same number. */
export const STORED_MAX_BYTES = 8192;

const LOGIN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[bot\])?$/;
const ALLOWED_KEYS: Readonly<Record<string, readonly string[]>> = {
  branch: ['allow', 'deny'],
  baseBranch: ['allow', 'deny'],
  actor: ['allow', 'deny', 'bots'],
  labels: ['include', 'exclude'],
};

type ItemCheck = (value: string) => string | null;

/** Parse one list of strings: trims, checks each entry, drops case-insensitive duplicates. */
function parseList(raw: unknown, path: string, check: ItemCheck, errors: FilterIssue[]): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push({ field: path, message: 'Must be a list.' });
    return [];
  }
  if (raw.length > MAX_ENTRIES_PER_LIST) {
    errors.push({ field: path, message: `At most ${MAX_ENTRIES_PER_LIST} entries per list.` });
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  raw.forEach((item: unknown, i) => {
    const at = `${path}[${i}]`;
    if (typeof item !== 'string') {
      errors.push({ field: at, message: 'Must be text.' });
      return;
    }
    const value = item.trim();
    const problem = value.length === 0 ? 'Cannot be empty.' : check(value);
    if (problem) {
      errors.push({ field: at, message: problem });
      return;
    }
    const key = fold(value);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(value);
    }
  });
  return out;
}

const globCheck: ItemCheck = (v) => {
  const c = compileGlob(v);
  return c.ok ? null : c.message;
};
const loginCheck: ItemCheck = (v) => {
  if (v.length > LOGIN_MAX || !LOGIN.test(v))
    return 'Use a GitHub username, for example octocat or dependabot[bot].';
  // F138/F151: a rule may not be built to suppress deleted accounts.
  if (fold(v) === 'ghost') return 'The deleted-user placeholder cannot be filtered.';
  return null;
};
const labelCheck: ItemCheck = (v) =>
  v.length > LABEL_MAX || CONTROL_CHARS.test(v)
    ? `Use 1–${LABEL_MAX} characters, no control characters.`
    : null;

function checkKeys(
  r: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errors: FilterIssue[],
): void {
  for (const key of Object.keys(r))
    if (!allowed.includes(key)) errors.push({ field: `${path}.${key}`, message: 'Unknown option.' });
}

function parseAllowDeny(raw: unknown, path: string, check: ItemCheck, errors: FilterIssue[]) {
  const r = asRecord(raw);
  if (!r) {
    errors.push({ field: path, message: 'Expected an object.' });
    return undefined;
  }
  checkKeys(r, ALLOWED_KEYS[path.split('.').at(-1) ?? ''] ?? [], path, errors);
  const allow = parseList(r.allow, `${path}.allow`, check, errors);
  const deny = parseList(r.deny, `${path}.deny`, check, errors);
  return { allow, deny };
}

/**
 * Validate a `filters` value. `null`/`{}` mean "no filters". The result is normalised: empty
 * lists and default values are dropped, so equal configs serialise equally.
 */
export function parseFilters(raw: unknown, path = 'filters'): FilterParse {
  if (raw === null) return { ok: true, value: {} };
  const r = asRecord(raw);
  if (!r) return { ok: false, errors: [{ field: path, message: 'Expected an object.' }] };
  const errors: FilterIssue[] = [];
  for (const key of Object.keys(r))
    if (!(FILTER_IDS as readonly string[]).includes(key))
      errors.push({ field: `${path}.${key}`, message: 'Unknown filter.' });

  const out: { -readonly [K in keyof FilterConfig]: FilterConfig[K] } = {};
  for (const id of ['branch', 'baseBranch'] as const) {
    if (r[id] === undefined) continue;
    const v = parseAllowDeny(r[id], `${path}.${id}`, globCheck, errors);
    if (v && (v.allow.length || v.deny.length)) out[id] = v;
  }
  if (r.actor !== undefined) {
    const a = asRecord(r.actor);
    const base = parseAllowDeny(r.actor, `${path}.actor`, loginCheck, errors);
    let bots: BotMode = 'any';
    if (a && a.bots !== undefined) {
      if ((BOT_MODES as readonly unknown[]).includes(a.bots)) bots = a.bots as BotMode;
      else errors.push({ field: `${path}.actor.bots`, message: 'Use any, exclude or only.' });
    }
    if (base && (base.allow.length || base.deny.length || bots !== 'any')) out.actor = { ...base, bots };
  }
  if (r.draft !== undefined && r.draft !== false && r.draft !== null) {
    if (r.draft === 'exclude') out.draft = 'exclude';
    else errors.push({ field: `${path}.draft`, message: 'Use "exclude" or leave it out.' });
  }
  if (r.labels !== undefined) {
    const lr = asRecord(r.labels);
    if (!lr) errors.push({ field: `${path}.labels`, message: 'Expected an object.' });
    else {
      checkKeys(lr, ALLOWED_KEYS.labels ?? [], `${path}.labels`, errors);
      const include = parseList(lr.include, `${path}.labels.include`, labelCheck, errors);
      const exclude = parseList(lr.exclude, `${path}.labels.exclude`, labelCheck, errors);
      if (include.length || exclude.length) out.labels = { include, exclude };
    }
  }
  if (errors.length === 0 && countEntries(out) > MAX_ENTRIES_TOTAL)
    errors.push({ field: path, message: `At most ${MAX_ENTRIES_TOTAL} entries in total.` });
  if (
    errors.length === 0 &&
    serializeFilters(out) !== null &&
    (serializeFilters(out) ?? '').length > STORED_MAX_BYTES
  )
    errors.push({ field: path, message: 'Filters are too large.' });
  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}

function countEntries(c: FilterConfig): number {
  return (
    (c.branch?.allow.length ?? 0) +
    (c.branch?.deny.length ?? 0) +
    (c.baseBranch?.allow.length ?? 0) +
    (c.baseBranch?.deny.length ?? 0) +
    (c.actor?.allow.length ?? 0) +
    (c.actor?.deny.length ?? 0) +
    (c.labels?.include.length ?? 0) +
    (c.labels?.exclude.length ?? 0)
  );
}

/** Ids of the filters present, in registry order. */
export function activeFilterIds(c: FilterConfig): FilterId[] {
  return FILTER_IDS.filter((id) => c[id] !== undefined);
}

/** `null` (stored as SQL NULL) when there is nothing to evaluate. */
export function serializeFilters(c: FilterConfig): string | null {
  return activeFilterIds(c).length === 0 ? null : JSON.stringify({ v: STORED_VERSION, ...c });
}

export type StoredFilters =
  | { readonly kind: 'none' }
  | { readonly kind: 'ok'; readonly config: FilterConfig }
  | { readonly kind: 'invalid' };

/**
 * Read a stored document. Anything that does not re-validate (corruption, a version this
 * Worker does not know, a hand-edited row) is `invalid`, and ingress then fails OPEN with a
 * recorded reason: a filter is a noise control, not an authorization, and a broken one must
 * not silently swallow notifications.
 */
export function readStoredFilters(json: string | null): StoredFilters {
  if (json === null || json === '') return { kind: 'none' };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { kind: 'invalid' };
  }
  const r = asRecord(raw);
  if (!r || r.v !== STORED_VERSION) return { kind: 'invalid' };
  const { v: _version, ...rest } = r;
  const parsed = parseFilters(rest);
  if (!parsed.ok) return { kind: 'invalid' };
  return activeFilterIds(parsed.value).length ? { kind: 'ok', config: parsed.value } : { kind: 'none' };
}

/** Ids whose configuration differs. For audit metadata: ids only, never values. */
export function changedFilterIds(before: FilterConfig, after: FilterConfig): FilterId[] {
  return FILTER_IDS.filter((id) => JSON.stringify(before[id] ?? null) !== JSON.stringify(after[id] ?? null));
}

const FACT_KEYS = ['branch', 'baseBranch', 'actorLogin', 'actorIsBot', 'actorIsGhost', 'draft', 'labels'];
const PREVIEW_LABELS_MAX = 100;

/**
 * Strict parse of a SAMPLE facts object (the preview endpoint and the dashboard tester). Every
 * key is optional and absent means `null` ("the source did not say"). Over-long strings are
 * rejected here rather than truncated, so a preview never differs from production.
 */
export function parseFacts(
  raw: unknown,
): { ok: true; value: RoutingFacts } | { ok: false; errors: FilterIssue[] } {
  const r = asRecord(raw);
  if (!r) return { ok: false, errors: [{ field: 'facts', message: 'Expected an object.' }] };
  const errors: FilterIssue[] = [];
  for (const key of Object.keys(r))
    if (!FACT_KEYS.includes(key)) errors.push({ field: `facts.${key}`, message: 'Unknown field.' });
  const text = (key: string): string | null => {
    const v = r[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string' || v.length > GLOB_INPUT_MAX) {
      errors.push({ field: `facts.${key}`, message: `Use text up to ${GLOB_INPUT_MAX} characters.` });
      return null;
    }
    return v;
  };
  const flag = (key: string): boolean | null => {
    const v = r[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'boolean') {
      errors.push({ field: `facts.${key}`, message: 'Must be true, false or empty.' });
      return null;
    }
    return v;
  };
  let labels: string[] | null = null;
  if (r.labels !== undefined && r.labels !== null) {
    if (
      !Array.isArray(r.labels) ||
      r.labels.length > PREVIEW_LABELS_MAX ||
      !r.labels.every((l): l is string => typeof l === 'string' && l.length <= LABEL_MAX)
    )
      errors.push({ field: 'facts.labels', message: `Use up to ${PREVIEW_LABELS_MAX} labels of text.` });
    else labels = [...r.labels];
  }
  const value: RoutingFacts = {
    branch: text('branch'),
    baseBranch: text('baseBranch'),
    actorLogin: text('actorLogin'),
    actorIsBot: flag('actorIsBot'),
    actorIsGhost: flag('actorIsGhost'),
    draft: flag('draft'),
    labels,
  };
  return errors.length ? { ok: false, errors } : { ok: true, value };
}
