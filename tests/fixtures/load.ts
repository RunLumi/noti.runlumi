import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Fixture access for the replay and conformance suites. The manifest (manifest.json) is the
 * provenance record of every fixture: where it came from, the date it was read, whether it is a
 * documented example as published, derived from one by a stated change, or composed; and what the
 * replay must conclude about it. See tests/fixtures/README.md.
 */
export const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
export const GOLDEN_DIR = join(FIXTURE_DIR, 'golden');

export type Provenance = 'documented' | 'derived' | 'composed' | 'contract';
export type Expectation = 'delivered' | 'ignored' | 'lifecycle' | 'ping';

export interface FixtureEntry {
  readonly id: string;
  readonly provider: 'github' | 'gitlab' | 'stripe' | 'generic';
  readonly file: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly provenance: Provenance;
  readonly source: string;
  readonly readOn: string;
  readonly expect: Expectation;
  readonly derive?: {
    /** Replace an existing field. */
    readonly set?: Readonly<Record<string, unknown>>;
    /** Add a field that the documented example does not have (its parent must exist). */
    readonly add?: Readonly<Record<string, unknown>>;
  };
  /** Also render the Slack, Lark, Teams and Discord payloads into the golden (a representative subset). */
  readonly render?: boolean;
  readonly note?: string;
  readonly unverified?: readonly string[];
}

export function loadManifest(): readonly FixtureEntry[] {
  const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8')) as {
    fixtures: FixtureEntry[];
  };
  return raw.fixtures;
}

/** Set `a.b.c` on a deep copy. Path segments must already exist, so a typo fails loudly. */
function setPath(root: Record<string, unknown>, path: string, value: unknown, create = false): void {
  const parts = path.split('.');
  let node: Record<string, unknown> = root;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (typeof next !== 'object' || next === null) throw new Error(`fixture derive: no ${part} in ${path}`);
    node = next as Record<string, unknown>;
  }
  const last = parts[parts.length - 1] as string;
  if (!create && !(last in node)) throw new Error(`fixture derive: no ${path}`);
  node[last] = value;
}

export function loadFixtureJson(entry: FixtureEntry): Record<string, unknown> {
  const json = JSON.parse(readFileSync(join(FIXTURE_DIR, entry.file), 'utf8')) as Record<string, unknown>;
  for (const [path, value] of Object.entries(entry.derive?.set ?? {})) setPath(json, path, value);
  for (const [path, value] of Object.entries(entry.derive?.add ?? {})) setPath(json, path, value, true);
  return json;
}

export const goldenPath = (entry: FixtureEntry): string =>
  join(GOLDEN_DIR, `${entry.id.replace('/', '__')}.json`);
