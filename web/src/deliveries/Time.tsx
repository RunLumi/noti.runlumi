import { t } from '../i18n';
import { formatDateTime, formatRelative } from '../i18n/format';
import { useLocale } from '../i18n/LocaleProvider';

const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** "3 hours ago", "in 2 days", or "just now" in the active language. Pure given a clock. */
export function relativeTime(iso: string, now: number): string {
  const diff = new Date(iso).getTime() - now;
  if (Number.isNaN(diff)) return iso;
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return formatRelative(Math.trunc(diff / ms), unit);
  }
  return t('time.justNow');
}

export function absoluteTime(iso: string): string {
  return formatDateTime(iso);
}

/** Relative text for scanning, the exact local time on hover and for assistive tech via the datetime. */
export function Time({ iso }: { readonly iso: string }) {
  useLocale();
  return (
    <time dateTime={iso} title={absoluteTime(iso)}>
      {relativeTime(iso, Date.now())}
    </time>
  );
}
