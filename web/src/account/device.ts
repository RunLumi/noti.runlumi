/**
 * A person-readable name for a session's `User-Agent`, so "Chrome on macOS" is shown instead of a
 * 150-character string. A user agent is whatever the client says it is: this is a label to help someone
 * recognise their own device, never a fact about it, and an unrecognised one is shown as unknown rather
 * than guessed. Order matters: Edge, Opera and Samsung Internet all say "Chrome" too, and iPads and
 * iPhones say "Safari" whatever the browser is.
 */
export interface Device {
  readonly browser: string | null;
  readonly os: string | null;
  readonly kind: 'phone' | 'tablet' | 'computer';
}

const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\b(?:OPR|Opera)\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/\b(?:Chrome|CriOS|Chromium)\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
];

const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/\b(?:iPhone|iPad|iPod)\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\b(?:Macintosh|Mac OS X)\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

export function parseDevice(userAgent: string | null | undefined): Device {
  const ua = userAgent ?? '';
  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1] ?? null;
  const os = SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1] ?? null;
  const tablet = /\biPad\b/.test(ua) || (/\bAndroid\b/.test(ua) && !/\bMobile\b/.test(ua));
  const phone = !tablet && (/\b(?:iPhone|iPod)\b/.test(ua) || /\bAndroid\b.*\bMobile\b/.test(ua));
  return { browser, os, kind: tablet ? 'tablet' : phone ? 'phone' : 'computer' };
}
