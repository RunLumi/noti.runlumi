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
 * 3. External references in ADRs (offline; this script makes no network request): every `http(s)://` URL in
 *    docs/adr/ is https, parses as a URL, does not end in punctuation picked up from the prose, and sits in a
 *    markdown link destination without whitespace. ADRs 0031 to 0035 (SOURCED_DECISION_ADRS) must cite at least one
 *    https URL. Whether a URL still resolves, and whether it says what the ADR claims, is checked by a human, not here.
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
/** Decisions that rest on external platform limits or standards; each must cite a source (spec 01 F14). */
export const SOURCED_DECISION_ADRS = new Set(['0031', '0032', '0033', '0034', '0035']);
/** A URL token: starts at http(s):// and stops at whitespace or a quote, angle bracket, backtick or square bracket. */
const URL_TOKEN = /https?:\/\/[^\s<>"'`[\]]*/g;
/** A markdown link destination, `](...)`, up to the first closing parenthesis. */
const LINK_DESTINATION = /\]\((https?:\/\/[^)\n]*)\)/g;
const TRAILING_PUNCTUATION = /[.,;:!?*]$/;

/** The URL ends before the first closing parenthesis it did not open: that one is markdown syntax, not URL. */
function beforeMarkdownCloser(token) {
  let depth = 0;
  for (let i = 0; i < token.length; i++) {
    if (token[i] === '(') depth++;
    else if (token[i] === ')') {
      if (depth === 0) return token.slice(0, i);
      depth--;
    }
  }
  return token;
}
function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

/**
 * Offline, structural checks on every http(s) URL in the ADRs. No request is made.
 * @param {{name: string, text: string}[]} files
 */
export function checkAdrUrls(files) {
  const problems = [];
  for (const { name, text } of files) {
    for (const m of text.matchAll(LINK_DESTINATION)) {
      if (/\s/.test(m[1] ?? '')) {
        problems.push(`${name}:${lineOf(text, m.index)}: link destination contains whitespace`);
      }
    }
    for (const m of text.matchAll(URL_TOKEN)) {
      const url = beforeMarkdownCloser(m[0]);
      const where = `${name}:${lineOf(text, m.index)}`;
      if (!url.startsWith('https://')) {
        problems.push(`${where}: ${url} must use https`);
        continue;
      }
      try {
        new URL(url);
      } catch {
        problems.push(`${where}: ${url} is not a valid URL`);
        continue;
      }
      if (TRAILING_PUNCTUATION.test(url)) {
        problems.push(`${where}: ${url} ends in punctuation that is probably not part of the URL`);
      }
    }
  }
  return problems;
}

/**
 * Each decision ADR in SOURCED_DECISION_ADRS exists and cites at least one https URL.
 * @param {{name: string, text: string}[]} files
 */
export function checkSourcedDecisions(files) {
  const problems = [];
  const byNumber = new Map();
  for (const { name, text } of files) {
    const m = /^(\d{4})-/.exec(name);
    if (m && SOURCED_DECISION_ADRS.has(m[1])) byNumber.set(m[1], text);
  }
  for (const num of [...SOURCED_DECISION_ADRS].sort()) {
    const text = byNumber.get(num);
    if (text === undefined) problems.push(`ADR ${num}: missing, but it is a sourced decision ADR`);
    else if (!/https:\/\/\S/.test(text))
      problems.push(`ADR ${num}: cites no https:// source for its external claims`);
  }
  return problems;
}

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
  const problems = [
    ...checkAdrs(repo.adrs),
    ...checkAdrUrls(repo.adrs),
    ...checkSourcedDecisions(repo.adrs),
    ...checkControlIds(repo),
  ];
  if (problems.length > 0) {
    for (const p of problems) console.error(p);
    process.exit(1);
  }
  console.log(`docs check ok: ${repo.adrs.length} ADRs, ADR URLs well-formed, control IDs consistent`);
}
