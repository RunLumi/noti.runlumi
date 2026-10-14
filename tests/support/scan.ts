import type { DatabaseSync } from 'node:sqlite';

/**
 * Whole-database scan for values that must never be stored (F34 `kek_is_never_written_to_d1`).
 *
 * Every column of every table (including Better Auth's, the outbox and the audit log) is read, and
 * each value is compared against every needle in the shapes a value could take: the text itself,
 * its UTF-8 bytes, its hex and base64 encodings, and (for a hex needle) the bytes it decodes to.
 * It matches by substring, so a secret embedded in JSON or a longer string is found too.
 */
export interface ScanHit {
  readonly table: string;
  readonly column: string;
  readonly needle: string;
}

export interface Needle {
  /** Name shown in a failure; never the value. */
  readonly label: string;
  readonly value: string | Uint8Array;
}

function variants(value: string | Uint8Array): { text: string[]; bytes: Buffer[] } {
  const raw = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  const text = new Set<string>();
  const bytes: Buffer[] = [raw];
  if (typeof value === 'string') text.add(value);
  text.add(raw.toString('hex'));
  text.add(raw.toString('hex').toUpperCase());
  text.add(raw.toString('base64'));
  text.add(raw.toString('base64url'));
  if (typeof value === 'string' && /^([0-9a-f]{2})+$/i.test(value)) {
    const decoded = Buffer.from(value, 'hex');
    bytes.push(decoded);
    text.add(decoded.toString('base64'));
    text.add(decoded.toString('base64url'));
  }
  return { text: [...text].filter((t) => t.length >= 8), bytes: bytes.filter((b) => b.length >= 8) };
}

export function scanDatabase(raw: DatabaseSync, needles: readonly Needle[]): ScanHit[] {
  const prepared = needles.map((n) => ({ label: n.label, ...variants(n.value) }));
  const hits: ScanHit[] = [];
  const tables = raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  for (const { name } of tables) {
    const rows = raw.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[];
    for (const row of rows) {
      for (const [column, cell] of Object.entries(row)) {
        if (cell === null || typeof cell === 'number' || typeof cell === 'bigint') continue;
        const asBuffer = cell instanceof Uint8Array ? Buffer.from(cell) : null;
        const asText = typeof cell === 'string' ? cell : (asBuffer?.toString('latin1') ?? '');
        for (const n of prepared) {
          const found =
            n.text.some((t) => asText.includes(t)) ||
            (asBuffer !== null && n.bytes.some((b) => asBuffer.includes(b))) ||
            (typeof cell === 'string' && n.bytes.some((b) => Buffer.from(cell, 'utf8').includes(b)));
          if (found) hits.push({ table: name, column, needle: n.label });
        }
      }
    }
  }
  return hits;
}

/** The same check over a list of strings (queue message bodies, captured log lines). */
export function scanTexts(texts: readonly string[], needles: readonly Needle[]): string[] {
  const found: string[] = [];
  for (const n of needles) {
    const v = variants(n.value);
    if (texts.some((t) => v.text.some((x) => t.includes(x)))) found.push(n.label);
  }
  return found;
}
