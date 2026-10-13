import { escapeText, fitText, linkAtom, safeLinkUrl } from './markup';
import { redactContactDetails } from './redact';
import type {
  CanonicalNotification,
  DestinationCapabilities,
  DestinationKind,
  JsonObject,
  MarkupDialect,
  NotificationStatus,
  RenderFormat,
  RenderResult,
  RenderedField,
} from './types';

/**
 * Destination-independent rendering helpers and the degradation ladder (F93/F95).
 * User-visible strings live in one table so they can be translated later.
 */

export function uniqueFields(fields: readonly RenderedField[]): readonly RenderedField[] {
  return [...new Set(fields)];
}

export const STRINGS = {
  defaultLinkLabel: 'Open in source',
  linkUnavailable: 'Source link unavailable',
  untitled: 'Untitled event',
  actorPrefix: 'by ',
  metaSeparator: ' · ',
  status: {
    success: 'Succeeded',
    failure: 'Failed',
    warning: 'Warning',
    info: 'Info',
  } satisfies Record<NotificationStatus, string>,
} as const;

const MAX_META_CHARS = 300;
const MAX_LINK_LABEL_CHARS = 80;

export interface RungOutput {
  readonly payload: JsonObject;
  readonly truncatedFields: readonly RenderedField[];
}

export type RungBuilders = { readonly [F in RenderFormat]?: () => RungOutput };

export interface PreparedNotification {
  readonly notification: CanonicalNotification;
  readonly redactedFields: readonly RenderedField[];
}

/**
 * Upper bound on any untrusted field before it is segmented, escaped or scanned. It is far
 * above every render budget, so a bounded field is still truncated visibly later, but it
 * caps the work any single event can cause.
 */
export const MAX_FIELD_INPUT_CHARS = 16_384;

/** Cut to `MAX_FIELD_INPUT_CHARS` code units without leaving a lone high surrogate. */
export function boundInput(text: string): string {
  if (text.length <= MAX_FIELD_INPUT_CHARS) return text;
  const cut = text.slice(0, MAX_FIELD_INPUT_CHARS);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

type TextField = 'title' | 'summary' | 'actor' | 'repo' | 'linkLabel';
const TEXT_FIELDS: readonly TextField[] = ['title', 'summary', 'actor', 'repo', 'linkLabel'];
const REPORTED_AS: { readonly [F in TextField]: RenderedField } = {
  title: 'title',
  summary: 'summary',
  actor: 'meta',
  repo: 'meta',
  linkLabel: 'link',
};

function mapFields(n: CanonicalNotification, fn: (s: string) => string): CanonicalNotification {
  const updates = Object.fromEntries(
    TEXT_FIELDS.flatMap((f) => {
      const v = n[f];
      return typeof v === 'string' ? [[f, fn(v)]] : [];
    }),
  ) as Partial<Pick<CanonicalNotification, TextField>>;
  return { ...n, ...updates };
}

/**
 * Bound every free-text field, substitute an empty title, and mask contact details in every
 * free-text field when the destination requires it (F102).
 */
export function prepareNotification(
  n: CanonicalNotification,
  caps: DestinationCapabilities,
): PreparedNotification {
  const bounded = mapFields(n, boundInput);
  const titled = bounded.title.trim() ? bounded : { ...bounded, title: STRINGS.untitled };
  if (!caps.redactsContactDetails) return { notification: titled, redactedFields: [] };
  return redactNotification(titled);
}

function redactNotification(n: CanonicalNotification): PreparedNotification {
  const redacted = mapFields(n, (s) => redactContactDetails(s).text);
  const changed = TEXT_FIELDS.filter((f) => redacted[f] !== n[f]).map((f) => REPORTED_AS[f]);
  return { notification: redacted, redactedFields: uniqueFields(changed) };
}

/** `repo · by actor`, unescaped. */
export function metaLine(n: CanonicalNotification): string {
  const parts = [n.repo, n.actor ? STRINGS.actorPrefix + n.actor : undefined].filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  );
  return parts.join(STRINGS.metaSeparator);
}

export function statusLabel(status: NotificationStatus | undefined): string | undefined {
  return status ? STRINGS.status[status] : undefined;
}

/** The link label, unescaped, bounded at a grapheme boundary. */
export function linkLabel(n: CanonicalNotification): string {
  const raw = n.linkLabel && n.linkLabel.trim() ? n.linkLabel : STRINGS.defaultLinkLabel;
  return fitText(raw, 'plain', MAX_LINK_LABEL_CHARS).text;
}

export interface FittedField {
  readonly text: string;
  readonly truncated: boolean;
}

export interface TitleOptions {
  /** Prefix the status label (`Failed: …`) so status is not conveyed by colour alone. */
  readonly withStatus?: boolean;
  /** The title will be wrapped in `*`/`**` emphasis, so `*` must not appear inside it. */
  readonly emphasised?: boolean;
}

/** Titles are single-line; inside emphasis a `*` would close the bold early. */
function titleText(n: CanonicalNotification, options: TitleOptions): string {
  const label = options.withStatus === false ? undefined : statusLabel(n.status);
  const oneLine = (label ? `${label}: ${n.title}` : n.title).replace(/\s*[\r\n]+\s*/g, ' ').trim();
  return options.emphasised ? oneLine.replace(/\*/g, '∗') : oneLine;
}

export function fitTitle(
  n: CanonicalNotification,
  dialect: MarkupDialect,
  max: number,
  options: TitleOptions = {},
): FittedField {
  return fitText(titleText(n, options), dialect, max);
}

export function fitMeta(n: CanonicalNotification, dialect: MarkupDialect): FittedField {
  return fitText(metaLine(n), dialect, MAX_META_CHARS);
}

export function fitSummary(n: CanonicalNotification, dialect: MarkupDialect, max: number): FittedField {
  return fitText(n.summary ?? '', dialect, max);
}

export interface ComposeOptions {
  readonly dialect: MarkupDialect;
  readonly maxChars: number;
  readonly maxTitleChars: number;
  /** `markup` renders `[label](url)`-style links; `bare` prints the URL itself. */
  readonly linkStyle: 'markup' | 'bare';
  readonly titleWrap?: readonly [string, string];
  readonly withStatus?: boolean;
}

function linkLine(n: CanonicalNotification, opts: ComposeOptions): string | undefined {
  const url = safeLinkUrl(n.url);
  if (!url) return undefined;
  if (opts.linkStyle === 'bare') return opts.dialect === 'slack_mrkdwn' ? escapeText(url, opts.dialect) : url;
  return linkAtom(url, linkLabel(n), opts.dialect);
}

/**
 * One block of text: title, meta, link, then summary. The summary goes last so that, when
 * the budget runs out, only the longest free-text field is cut and the link survives intact.
 */
export function composeText(n: CanonicalNotification, opts: ComposeOptions): RungOutputText {
  const [pre, post] = opts.titleWrap ?? ['', ''];
  const title = fitTitle(n, opts.dialect, opts.maxTitleChars, {
    emphasised: opts.titleWrap !== undefined,
    ...(opts.withStatus === false ? { withStatus: false } : {}),
  });
  const meta = fitMeta(n, opts.dialect);
  const head = [pre + title.text + post, meta.text, linkLine(n, opts)]
    .filter((line): line is string => typeof line === 'string' && line.length > 0)
    .join('\n');
  const room = opts.maxChars - head.length - 2;
  const summary = room > 0 ? fitSummary(n, opts.dialect, room) : { text: '', truncated: !!n.summary };
  const truncatedFields: RenderedField[] = [
    ...(title.truncated ? (['title'] as const) : []),
    ...(meta.truncated ? (['meta'] as const) : []),
    ...(summary.truncated ? (['summary'] as const) : []),
  ];
  return { text: summary.text ? `${head}\n\n${summary.text}` : head, truncatedFields };
}

export interface RungOutputText {
  readonly text: string;
  readonly truncatedFields: readonly RenderedField[];
}

const encoder = new TextEncoder();

export function jsonBytes(payload: JsonObject): number {
  return encoder.encode(JSON.stringify(payload)).length;
}

export interface LadderInput {
  readonly kind: DestinationKind;
  readonly caps: DestinationCapabilities;
  readonly rungs: RungBuilders;
  readonly redactedFields: readonly RenderedField[];
  /** Bytes added after render, such as Lark's `timestamp` and `sign` fields. */
  readonly reserveBytes?: number;
  /** Start lower on the ladder, e.g. when the customer chose plain text. */
  readonly startAt?: RenderFormat;
}

function ladderFrom(formats: readonly RenderFormat[], startAt?: RenderFormat): readonly RenderFormat[] {
  if (!startAt) return formats;
  const i = formats.indexOf(startAt);
  return i < 0 ? formats : formats.slice(i);
}

/**
 * Try each supported rung, richest first, and return the first that fits the destination's
 * byte budget. The rungs that did not fit are reported, never hidden (F93). If nothing fits
 * the result is `payload_too_large`, a permanent failure, never a silent drop.
 */
export function runLadder(input: LadderInput): RenderResult {
  const formats = ladderFrom(input.caps.formats, input.startAt);
  const tried: RenderFormat[] = [];
  for (const format of formats) {
    const build = input.rungs[format];
    if (!build) continue;
    const out = build();
    const bytes = jsonBytes(out.payload) + (input.reserveBytes ?? 0);
    if (bytes <= input.caps.maxBodyBytes) {
      return {
        ok: true,
        message: {
          kind: input.kind,
          format,
          payload: out.payload,
          bytes,
          degradedFrom: tried,
          truncatedFields: out.truncatedFields,
          redactedFields: input.redactedFields,
        },
      };
    }
    tried.push(format);
  }
  return { ok: false, reason: tried.length === 0 ? 'render_failed' : 'payload_too_large' };
}
