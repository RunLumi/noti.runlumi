const absolute = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** "3 hours ago", "in 2 days", or "just now". Pure, so it can be tested with a fixed clock. */
export function relativeTime(iso: string, now: number): string {
  const diff = new Date(iso).getTime() - now;
  if (Number.isNaN(diff)) return iso;
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return relative.format(Math.trunc(diff / ms), unit);
  }
  return 'just now';
}

export function absoluteTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : absolute.format(date);
}

/** Relative text for scanning, the exact local time on hover and for assistive tech via the datetime. */
export function Time({ iso }: { readonly iso: string }) {
  return (
    <time dateTime={iso} title={absoluteTime(iso)}>
      {relativeTime(iso, Date.now())}
    </time>
  );
}
