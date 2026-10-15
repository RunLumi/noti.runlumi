import { createHash } from 'node:crypto';
import { format } from 'node:util';
import { vi } from 'vitest';

/**
 * Console capture for the no-secret-in-logs tests (spec 15 F234, AGENTS.md "never print tokens, secrets").
 * Every console method is replaced for the test; each call is formatted the way Node formats it (so an
 * Error's stack and a nested object are both included) and kept in order.
 */
export function captureConsole(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  for (const method of ['debug', 'info', 'log', 'warn', 'error', 'trace'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(format(...args));
    });
  }
  return { lines, restore: () => vi.restoreAllMocks() };
}

/**
 * Values that must never reach a log. Each value is registered with its SHA-256 hex and base64url
 * prefixes as well, because a log line that carries a hash prefix still identifies the secret.
 */
export class Planted {
  private readonly values = new Map<string, string>();

  add(label: string, value: string | null | undefined): void {
    if (!value) return;
    this.values.set(label, value);
    this.values.set(`${label} (sha256 hex prefix)`, sha256(value, 'hex').slice(0, 12));
    this.values.set(`${label} (sha256 base64url prefix)`, sha256(value, 'base64url').slice(0, 12));
    // A session cookie is `<token>.<signature>`: the token part is what the database holds.
    const beforeDot = value.split('.')[0];
    if (beforeDot && beforeDot !== value) this.values.set(`${label} (before the dot)`, beforeDot);
  }

  /** Labels of every planted value that appears in `text`. Values shorter than 8 characters are ignored. */
  leaked(text: string): string[] {
    return [...this.values].filter(([, v]) => v.length >= 8 && text.includes(v)).map(([label]) => label);
  }
}

function sha256(value: string, encoding: 'hex' | 'base64url'): string {
  return createHash('sha256').update(value).digest(encoding);
}
