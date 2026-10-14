import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The generator is plain ESM so CI can run it without a build step; it has no type declarations.
interface Feature {
  id: string;
  title: string;
  file: string;
  priority: string;
  status: string;
  glyph: string;
  note: string;
}
type Counts = Record<string, number>;
interface SpecStatus {
  GLYPHS: [string, string][];
  STATUS_FILE: string;
  README_FILE: string;
  applyReadmeBlock: (readme: string, features: Feature[]) => string;
  parseSpec: (file: string, text: string) => Feature[];
  parseSpecs: () => Feature[];
  renderStatus: (features: Feature[]) => string;
  overallCounts: (features: Feature[]) => Counts;
  hasEvidence: (note: string) => boolean;
}
const scriptPath = '../scripts/spec-status.mjs';
const {
  GLYPHS,
  STATUS_FILE,
  README_FILE,
  applyReadmeBlock,
  parseSpec,
  parseSpecs,
  renderStatus,
  overallCounts,
  hasEvidence,
} = (await import(/* @vite-ignore */ scriptPath)) as SpecStatus;

const REMAINING_FILE = join(dirname(README_FILE), 'REMAINING.md');
const features = parseSpecs();
const GLYPH_SET = new Set(GLYPHS.map(([g]) => g));

describe('spec catalogue (F01 to F262)', () => {
  it('has every feature id exactly once, F01 through F262', () => {
    const ids = features.map((f) => f.id);
    const expected = Array.from({ length: 262 }, (_, i) => `F${String(i + 1).padStart(2, '0')}`);
    expect([...ids].sort()).toEqual([...expected].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every feature a priority and a recognised status glyph', () => {
    const bad = features.filter((f) => !/^P[012]$/.test(f.priority) || !GLYPH_SET.has(f.glyph));
    expect(bad.map((f) => `${f.id}: ${f.status.slice(0, 40)}`)).toEqual([]);
  });

  it('gives every feature a note that says something', () => {
    expect(features.filter((f) => f.note.length < 20).map((f) => f.id)).toEqual([]);
  });

  it('requires an evidence pointer on every done P0 feature', () => {
    const missing = features.filter((f) => f.priority === 'P0' && f.glyph === '✅' && !hasEvidence(f.note));
    expect(missing.map((f) => f.id)).toEqual([]);
  });

  it('requires a stated gap on every partial feature and a reason on every blocked or deferred one', () => {
    const vague = features.filter((f) => f.glyph !== '✅' && f.glyph !== '❌' && f.note.length < 40);
    expect(vague.map((f) => f.id)).toEqual([]);
  });
});

describe('STATUS.md', () => {
  it('matches the generator output (run `npm run docs:spec-status`)', () => {
    expect(readFileSync(STATUS_FILE, 'utf8')).toBe(renderStatus(features));
  });

  it('keeps the README counts block in step (run `npm run docs:spec-status`)', () => {
    const readme = readFileSync(README_FILE, 'utf8');
    expect(applyReadmeBlock(readme, features)).toBe(readme);
  });

  it('reports counts that add up to 262', () => {
    const counts = overallCounts(features);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(262);
  });
});

describe('REMAINING.md', () => {
  it('lists every feature that is neither done nor decided against', () => {
    const remaining = readFileSync(REMAINING_FILE, 'utf8');
    const missing = features
      .filter((f) => f.glyph !== '✅' && f.glyph !== '🚫' && !new RegExp(`\\b${f.id}\\b`).test(remaining))
      .map((f) => f.id);
    expect(missing).toEqual([]);
  });
});

describe('parser', () => {
  const spec = [
    '## F01 — First thing',
    '',
    '**Priority** P0 · **Status** ✅ done, see `src/a.ts` · **Fixes** D1',
    '',
    '### F02 — Second',
    '**Priority** P1 · **Status** 🟡 partly; not built: x',
    '',
  ].join('\n');

  it('splits the status from trailing bold fields', () => {
    const [a, b] = parseSpec('01-x.md', spec);
    expect(a).toMatchObject({ id: 'F01', priority: 'P0', glyph: '✅', note: 'done, see `src/a.ts`' });
    expect(b).toMatchObject({ id: 'F02', priority: 'P1', glyph: '🟡', note: 'partly; not built: x' });
  });

  it('fails loudly on a feature with no Priority line', () => {
    expect(() => parseSpec('01-x.md', '## F01 — Orphan\n\ntext\n')).toThrow(/F01/);
  });

  it('treats an unrecognised status as no glyph', () => {
    const [a] = parseSpec('01-x.md', '## F01 — T\n**Priority** P0 · **Status** not started\n');
    expect(a?.glyph).toBe('');
  });

  it('recognises evidence pointers', () => {
    expect(hasEvidence('uses `src/security/headers.ts`')).toBe(true);
    expect(hasEvidence('shipped in PR #16')).toBe(true);
    expect(hasEvidence('see ADR 0005')).toBe(true);
    expect(hasEvidence('works well, trust us')).toBe(false);
    expect(hasEvidence('a `word` only')).toBe(false);
  });
});
