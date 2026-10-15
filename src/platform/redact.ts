/**
 * Redaction layer — docs/specs/01-platform-runtime.md F11/F12.
 *
 * `redact()` is the only sanctioned way to turn an arbitrary value (an Error, a provider
 * response, a request context) into something that may be logged or stored as a
 * diagnostic. It returns a JSON-safe structure and never throws.
 *
 * Rules:
 * - A denylisted key renders as `[redacted]` whatever its value — never a prefix (F12).
 * - Free text is scrubbed: URLs keep scheme + host only, bearer/basic credentials,
 *   `key=value` secrets, JSON-embedded secrets and known token formats are replaced.
 * - Scrubbing happens before truncation, so truncation can never expose part of a secret.
 * - Errors keep `name` and `code`; `message` is scrubbed; stacks are dropped.
 * - Cycles, depth, breadth and string length are bounded.
 */

export type Redacted = null | boolean | number | string | readonly Redacted[] | RedactedObject;
export interface RedactedObject {
  readonly [key: string]: Redacted;
}

export interface RedactOptions {
  readonly maxDepth?: number;
  readonly maxStringLength?: number;
  readonly maxEntries?: number;
}

export const REDACTED = '[redacted]';

const DEFAULTS: Required<RedactOptions> = { maxDepth: 6, maxStringLength: 512, maxEntries: 50 };

/**
 * F12 denylist, matched per word of the key (`x-hub-signature-256` → hub, signature, 256)
 * so `assignee` or `monkey` do not trip `sign`/`key`, but `webhookUrl` and `access_token` do.
 */
const DENY_WORDS: ReadonlySet<string> = new Set([
  'key',
  'keys',
  'secret',
  'secrets',
  'token',
  'tokens',
  'password',
  'passwords',
  'passwd',
  'passphrase',
  'authorization',
  'auth',
  'cookie',
  'cookies',
  'url',
  'urls',
  'uri',
  'href',
  'webhook',
  'webhooks',
  'sign',
  'signature',
  'signatures',
  'sig',
  'ciphertext',
  'credential',
  'credentials',
  'email',
  'emails',
  'dsn',
  'bearer',
  'jwt',
  'session',
  'otp',
]);

/** Denylisted keys written as one lowercase word, compared after stripping separators. */
const DENY_COMPOUNDS: ReadonlySet<string> = new Set([
  'apikey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'clientsecret',
  'privatekey',
  'webhookurl',
  'installationid',
  'setcookie',
  'sessionid',
]);

function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

export function isDeniedKey(key: string): boolean {
  const words = keyWords(key);
  return words.some((w) => DENY_WORDS.has(w)) || DENY_COMPOUNDS.has(words.join(''));
}

type Scrubber = readonly [RegExp, string | ((match: string, ...groups: string[]) => string)];

// Order matters: URLs first, so a token inside a query string is removed with its URL.
const SCRUBBERS: readonly Scrubber[] = [
  // Any absolute URL: keep scheme + host (F08: hostname, never the path that is the secret).
  [/\b([a-z][a-z0-9+.-]*):\/\/(?:[^\s/?#@"'<>]*@)?([^\s/?#:"'<>]+)(?::\d+)?([^\s"'<>]*)/gi, scrubUrl],
  [/\b(bearer|basic|token|digest)\s+[a-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  // GitHub (ghp_/gho_/ghu_/ghs_/ghr_, github_pat_), Slack (xox?-), Stripe-style sk_/rk_.
  [
    /\b(?:gh[pousr]_[a-z0-9]{8,}|github_pat_[a-z0-9_]{8,}|xox[a-z]-[a-z0-9-]{4,}|[sr]k_(?:live|test)_[a-z0-9]{8,})/gi,
    REDACTED,
  ],
  // Webhook signing secrets (Standard Webhooks and Stripe both use the whsec_ prefix).
  [/\bwhsec_[a-z0-9+/=_-]{8,}/gi, REDACTED],
  [/\b(sha1|sha256|sha512|v1)=[a-f0-9]{16,}/gi, `$1=${REDACTED}`],
  // `"secret": "..."` inside an echoed JSON body (F13: provider bodies echo credentials).
  [/("([^"\\]{1,64})"\s*:\s*)(?:"(?:[^"\\]|\\.)*"|-?\d[\d.eE+-]*)/g, scrubJsonPair],
  // `token=...`, `sign: ...` in query strings, headers or prose.
  [/\b([a-z][a-z0-9_-]{0,40})(\s*[=:]\s*)([^\s&,;"'<>]+)/gi, scrubAssignment],
];

function scrubUrl(_match: string, scheme: string, host: string, rest: string): string {
  return rest.length > 0 ? `${scheme}://${host}/${REDACTED}` : `${scheme}://${host}`;
}

function scrubJsonPair(match: string, prefix: string, key: string): string {
  return isDeniedKey(key) ? `${prefix}"${REDACTED}"` : match;
}

function scrubAssignment(match: string, key: string, sep: string, value: string): string {
  if (!isDeniedKey(key) || value === REDACTED) return match;
  return `${key}${sep}${REDACTED}`;
}

/**
 * Replace secret-shaped text (URL paths, bearer tokens, provider token prefixes, `key=value` and JSON
 * pairs with a denied key) without cutting anything else. Input is capped first so a hostile value cannot
 * make the regexes costly. Used where a value must be kept whole but must not hold a secret (audit metadata,
 * ADR 0039); `scrubString` is this plus truncation.
 */
export function scrubSecrets(input: string): string {
  const bounded =
    input.length > DEFAULTS.maxStringLength * 8 ? input.slice(0, DEFAULTS.maxStringLength * 8) : input;
  const scrubbed = SCRUBBERS.reduce<string>(
    (text, [pattern, replacement]) =>
      typeof replacement === 'string'
        ? text.replace(pattern, replacement)
        : text.replace(pattern, replacement),
    bounded,
  );
  // Never keep the part past the cap unscrubbed: say it was dropped instead.
  return bounded.length < input.length
    ? `${scrubbed}…[truncated ${input.length - bounded.length} chars]`
    : scrubbed;
}

/** Scrub-then-truncate. Input is capped first so a hostile body cannot make regexes costly. */
export function scrubString(input: string, maxLength: number = DEFAULTS.maxStringLength): string {
  const bounded = input.length > maxLength * 8 ? input.slice(0, maxLength * 8) : input;
  const scrubbed = SCRUBBERS.reduce<string>(
    (text, [pattern, replacement]) =>
      typeof replacement === 'string'
        ? text.replace(pattern, replacement)
        : text.replace(pattern, replacement),
    bounded,
  );
  return truncate(scrubbed, maxLength, input.length - bounded.length);
}

function truncate(text: string, maxLength: number, alreadyDropped: number): string {
  if (text.length <= maxLength && alreadyDropped === 0) return text;
  const cut = safeCut(text, maxLength);
  return `${text.slice(0, cut)}…[truncated ${text.length - cut + alreadyDropped} chars]`;
}

/**
 * Markers this module writes (`[redacted]`, `[circular]`, `[binary 12 bytes]`, `…[truncated 9 chars]`).
 * A cut never lands inside one, so a shortened value cannot read as a half-redacted secret (ADR 0051).
 */
const MARKER = /…?\[[^[\]\n]{1,40}\]/g;

/** The largest index <= `max` that splits neither a marker nor a surrogate pair. */
function safeCut(text: string, max: number): number {
  if (text.length <= max) return text.length;
  let cut = max;
  for (const m of text.matchAll(MARKER)) {
    if (m.index >= cut) break;
    if (m.index + m[0].length > cut) {
      cut = m.index;
      break;
    }
  }
  const code = text.charCodeAt(cut - 1);
  return cut > 0 && code >= 0xd800 && code <= 0xdbff ? cut - 1 : cut;
}

/** Shorten already-scrubbed text to at most `max` UTF-16 units plus a `…[truncated n chars]` marker. */
export function truncateSafely(text: string, max: number): string {
  return truncate(text, max, 0);
}

interface Context {
  readonly options: Required<RedactOptions>;
  readonly ancestors: WeakSet<object>;
}

/** Redact any value into a log-safe structure. Never throws (F12: drop fields, not lines). */
export function redact(value: unknown, options: RedactOptions = {}): Redacted {
  const ctx: Context = { options: { ...DEFAULTS, ...options }, ancestors: new WeakSet() };
  try {
    return redactValue(value, 0, ctx);
  } catch {
    return '[unredactable]';
  }
}

function redactValue(value: unknown, depth: number, ctx: Context): Redacted {
  switch (typeof value) {
    case 'string':
      return scrubString(value, ctx.options.maxStringLength);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'undefined':
      return null;
    case 'symbol':
      return '[symbol]';
    case 'function':
      return '[function]';
    case 'object':
      return value === null ? null : redactObject(value, depth, ctx);
  }
}

function redactObject(value: object, depth: number, ctx: Context): Redacted {
  if (ctx.ancestors.has(value)) return '[circular]';
  if (depth >= ctx.options.maxDepth) return '[max-depth]';
  ctx.ancestors.add(value);
  try {
    return redactByKind(value, depth + 1, ctx);
  } finally {
    ctx.ancestors.delete(value);
  }
}

function redactByKind(value: object, depth: number, ctx: Context): Redacted {
  if (value instanceof Error) return redactError(value, depth, ctx);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '[invalid-date]' : value.toISOString();
  if (value instanceof URL) return scrubString(value.href, ctx.options.maxStringLength);
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return `[binary ${value.byteLength} bytes]`;
  if (value instanceof Map) return redactEntries(Array.from(value.entries()), depth, ctx);
  if (value instanceof Headers) return redactEntries(headerEntries(value), depth, ctx);
  if (value instanceof Set) return redactArray(Array.from(value.values()), depth, ctx);
  if (Array.isArray(value)) return redactArray(value as readonly unknown[], depth, ctx);
  return redactEntries(ownEntries(value), depth, ctx);
}

function headerEntries(headers: Headers): Array<readonly [string, string]> {
  const entries: Array<readonly [string, string]> = [];
  headers.forEach((value, key) => entries.push([key, value]));
  return entries;
}

function ownEntries(value: object): Array<readonly [unknown, unknown]> {
  return Object.keys(value).map((key) => [key, readProperty(value, key)] as const);
}

const UNREADABLE = Symbol('unreadable');

/** Getters can throw; a field that cannot be read is dropped, not the whole line (F12). */
function readProperty(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return UNREADABLE;
  }
}

function redactArray(items: readonly unknown[], depth: number, ctx: Context): Redacted {
  const max = ctx.options.maxEntries;
  const kept = items.slice(0, max).map((item) => redactValue(item, depth, ctx));
  return items.length > max ? [...kept, `[${items.length - max} more items]`] : kept;
}

function redactEntries(
  entries: ReadonlyArray<readonly [unknown, unknown]>,
  depth: number,
  ctx: Context,
): Redacted {
  const max = ctx.options.maxEntries;
  const pairs = entries
    .slice(0, max)
    .filter(([, v]) => v !== UNREADABLE)
    .map(([k, v]) => redactPair(String(k), v, depth, ctx));
  const extra = entries.length > max ? [['[truncated]', `${entries.length - max} more keys`] as const] : [];
  return Object.fromEntries<Redacted>([...pairs, ...extra]);
}

function redactPair(key: string, value: unknown, depth: number, ctx: Context): readonly [string, Redacted] {
  // Keys can carry secrets too (e.g. a map keyed by webhook URL).
  const safeKey = scrubString(key, 128);
  return [safeKey, isDeniedKey(key) ? REDACTED : redactValue(value, depth, ctx)];
}

function redactError(error: Error, depth: number, ctx: Context): Redacted {
  const code = readProperty(error, 'code');
  const cause = readProperty(error, 'cause');
  return {
    name: scrubString(error.name, 128),
    message: scrubString(error.message, ctx.options.maxStringLength),
    ...(typeof code === 'string' || typeof code === 'number' ? { code: redactValue(code, depth, ctx) } : {}),
    ...(cause !== undefined && cause !== UNREADABLE ? { cause: redactValue(cause, depth, ctx) } : {}),
  };
}
