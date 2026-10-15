#!/usr/bin/env node
/**
 * Documentation integrity checks (spec 01 F14, spec 15 F241), plain ESM with no dependencies.
 *
 *   node scripts/check-docs.mjs      exit 1 with one line per problem
 *
 * 1. ADRs (`docs/adr/NNNN-slug.md`): file name shape, unique numbers, the H1 repeats the number, a `Status:` line
 *    near the top, a Decision heading. From ADR_STRICT_FROM onwards also Context, Consequences and Revisit when.
 *    Numbers may skip (a gap is not an error); they may not repeat.
 * 2. Control IDs: every `AR-n` row of the accepted-risk register in docs/THREAT_MODEL.md is unique; every `AR-n`
 *    cited anywhere outside docs/specs/ is defined there; every `Fnn` cited in the threat model is a `## Fnn`
 *    heading in docs/specs/, and spec headings are unique.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** ADRs numbered below this predate the full template and are held to the basic rules only. */
export const ADR_STRICT_FROM = 31;
/** Written before the Status line convention; exempt from that one rule only. */
export const LEGACY_NO_STATUS = new Set(['0002']);
/** Decision recorded as an inline `Decision:` paragraph rather than a heading. */
export const LEGACY_INLINE_DECISION = new Set(['0001']);
const STATUS_WORDS = /^Status:\s*(Proposed|Accepted|Superseded|Deprecated|Rejected)\b/;

/** @param {{name: string, text: string}[]} files */
export function checkAdrs(files) {
  const problems = [];
  const seen = new Map();
  for (const { name, text } of files) {
    const m = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.exec(name);
    if (!m) {
      problems.push(`${name}: file name must be NNNN-kebab-slug.md`);
      continue;
    }
    const num = m[1];
    if (seen.has(num)) problems.push(`${name}: number ${num} is also used by ${seen.get(num)}`);
    else seen.set(num, name);
    const lines = text.split('\n');
    const h1 = /^# ADR (\d{4}): \S/.exec(lines[0] ?? '');
    if (!h1) problems.push(`${name}: first line must be "# ADR ${num}: <title>"`);
    else if (h1[1] !== num) problems.push(`${name}: heading says ADR ${h1[1]} but the file is ${num}`);
    if (!LEGACY_NO_STATUS.has(num) && !lines.slice(1, 8).some((l) => STATUS_WORDS.test(l))) {
      problems.push(
        `${name}: a "Status: Proposed|Accepted|Superseded|Deprecated|Rejected" line must follow the title`,
      );
    }
    const headings = lines.filter((l) => l.startsWith('## ')).map((l) => l.slice(3).trim().toLowerCase());
    const has = (re) => headings.some((h) => re.test(h));
    if (!LEGACY_INLINE_DECISION.has(num) && !has(/^decisions?\b/))
      problems.push(`${name}: missing a "## Decision" heading`);
    if (Number(num) >= ADR_STRICT_FROM) {
      if (!has(/^context\b/)) problems.push(`${name}: missing a "## Context" heading`);
      if (!has(/^consequences\b/)) problems.push(`${name}: missing a "## Consequences" heading`);
      if (!has(/^revisit when\b/)) problems.push(`${name}: missing a "## Revisit when" heading`);
    }
  }
  return problems;
}

/**
 * @param {{threatModel: string, specs: {name: string, text: string}[], others: {name: string, text: string}[]}} input
 */
export function checkControlIds({ threatModel, specs, others }) {
  const problems = [];
  const defined = new Set();
  for (const m of threatModel.matchAll(/^\| (AR-\d+) \|/gm)) {
    if (defined.has(m[1])) problems.push(`THREAT_MODEL.md: ${m[1]} is defined twice`);
    defined.add(m[1]);
  }
  if (defined.size === 0) problems.push('THREAT_MODEL.md: no AR-n rows found in the accepted-risk register');
  for (const { name, text } of [{ name: 'docs/THREAT_MODEL.md', text: threatModel }, ...others]) {
    for (const id of new Set(text.match(/\bAR-\d+\b/g) ?? [])) {
      if (!defined.has(id)) problems.push(`${name}: cites ${id}, which is not in the accepted-risk register`);
    }
  }
  const headings = new Map();
  for (const { name, text } of specs) {
    for (const m of text.matchAll(/^## (F\d+)\b/gm)) {
      if (headings.has(m[1])) problems.push(`${name}: ${m[1]} is also a heading in ${headings.get(m[1])}`);
      else headings.set(m[1], name);
    }
  }
  for (const id of new Set(threatModel.match(/\bF\d{2,3}\b/g) ?? [])) {
    if (!headings.has(id))
      problems.push(`docs/THREAT_MODEL.md: cites ${id}, which has no heading in docs/specs/`);
  }
  return problems;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'dist', '.wrangler', 'coverage', 'specs']);
function collect(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) collect(join(dir, e.name), out);
    } else if (/\.(md|ts|tsx|mjs|jsonc)$/.test(e.name)) {
      out.push({ name: relative(root, join(dir, e.name)), text: readFileSync(join(dir, e.name), 'utf8') });
    }
  }
}

export function loadRepo(base = root) {
  const adrDir = join(base, 'docs', 'adr');
  const adrs = readdirSync(adrDir)
    .filter((f) => f.endsWith('.md'))
    .map((name) => ({ name, text: readFileSync(join(adrDir, name), 'utf8') }));
  const specDir = join(base, 'docs', 'specs');
  const specs = readdirSync(specDir)
    .filter((f) => /^\d\d-.*\.md$/.test(f))
    .map((name) => ({ name: `docs/specs/${name}`, text: readFileSync(join(specDir, name), 'utf8') }));
  const others = [];
  for (const d of ['docs', 'src', 'web/src', 'tests', 'scripts']) {
    if (existsSync(join(base, d))) collect(join(base, d), others);
  }
  for (const f of ['README.md', 'SECURITY.md', 'AGENTS.md']) {
    if (existsSync(join(base, f))) others.push({ name: f, text: readFileSync(join(base, f), 'utf8') });
  }
  const threatModel = readFileSync(join(base, 'docs', 'THREAT_MODEL.md'), 'utf8');
  return { adrs, specs, others: others.filter((o) => o.name !== 'docs/THREAT_MODEL.md'), threatModel };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const repo = loadRepo();
  const problems = [...checkAdrs(repo.adrs), ...checkControlIds(repo)];
  if (problems.length > 0) {
    for (const p of problems) console.error(p);
    process.exit(1);
  }
  console.log(`docs check ok: ${repo.adrs.length} ADRs, control IDs consistent`);
}
