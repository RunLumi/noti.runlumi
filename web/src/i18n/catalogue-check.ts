import type { PluralMessage } from './messages.en';

type Entry = string | PluralMessage;
export type AnyCatalogue = Readonly<Record<string, Entry>>;

const placeholdersOf = (text: string): string[] => [...new Set(text.match(/\{\w+\}/g) ?? [])].sort();

/** Every template of a message, keyed by plural category (`other` for a plain string). */
export function templatesOf(entry: Entry): Readonly<Record<string, string>> {
  return typeof entry === 'string' ? { other: entry } : { ...entry };
}

/**
 * Compare a translation with its source. Returns one human-readable problem per defect:
 * a missing id, an unknown id, or a `{placeholder}` set that differs from the source (a
 * dropped `{name}` shows nothing; an invented one renders as a hole or raw braces).
 * Pure, so the checks themselves can be tested against deliberately broken catalogues.
 */
export function compareCatalogues(source: AnyCatalogue, target: AnyCatalogue): string[] {
  const problems: string[] = [];
  for (const id of Object.keys(source)) {
    const translated = target[id];
    if (translated === undefined) {
      problems.push(`${id}: missing`);
      continue;
    }
    const expected = placeholdersOf(templatesOf(source[id] ?? '').other ?? '').join(' ');
    for (const [category, text] of Object.entries(templatesOf(translated))) {
      const actual = placeholdersOf(text).join(' ');
      if (actual !== expected)
        problems.push(`${id}.${category}: placeholders "${actual}" do not match "${expected}"`);
    }
  }
  for (const id of Object.keys(target))
    if (!(id in source)) problems.push(`${id}: not in the source catalogue`);
  return problems;
}
