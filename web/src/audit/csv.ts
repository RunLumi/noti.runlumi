/**
 * CSV for the events on screen. Cells are escaped for both CSV and spreadsheets: a cell that a
 * spreadsheet would read as a formula (it starts with = + - @, or with a tab or carriage return)
 * is prefixed with an apostrophe, so a repository or name such as `=HYPERLINK(...)` is shown, not run.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
