/**
 * Structured logging (docs/specs/01-platform-runtime.md F11). Every line goes through
 * `redact()` (F12) before it is emitted, so a field that happens to carry a URL or token
 * cannot reach the log.
 */
import { redact } from './redact';

export type LogLevel = 'info' | 'warn' | 'error';

export type LogFields = Readonly<Record<string, unknown>>;

export function logLine(level: LogLevel, msg: string, fields: LogFields = {}): string {
  return JSON.stringify(redact({ ts: new Date().toISOString(), level, msg, ...fields }));
}

export function log(level: LogLevel, msg: string, fields: LogFields = {}): void {
  const line = logLine(level, msg, fields);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}
