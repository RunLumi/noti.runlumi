import type { Context } from 'hono';
import type { Bindings } from '../env';

/**
 * The optional body of `POST …/revoke-credentials`: `{ "reason": "compromised" | "no_longer_used" |
 * "other" }`. A closed list, because the value goes into the audit log and free text never does.
 * No body at all means `other`.
 */
export const REVOKE_REASONS = ['compromised', 'no_longer_used', 'other'] as const;
export type RevokeReason = (typeof REVOKE_REASONS)[number];

const MAX_REVOKE_BODY_BYTES = 1024;

export async function readRevokeReason(c: Context<{ Bindings: Bindings }>): Promise<RevokeReason | Response> {
  const text = await c.req.text();
  if (new TextEncoder().encode(text).length > MAX_REVOKE_BODY_BYTES)
    return c.json({ error: 'Too large' }, 413);
  if (text.trim() === '') return 'other';
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
  const asked =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>).reason : undefined;
  if (asked === undefined) return 'other';
  const known = REVOKE_REASONS.find((r) => r === asked);
  return (
    known ??
    c.json(
      {
        error: 'Validation failed',
        fields: [{ field: 'reason', message: `Use one of: ${REVOKE_REASONS.join(', ')}.` }],
      },
      422,
    )
  );
}
