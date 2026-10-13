import { constantTimeEqual } from '../../../lib/timing';
import { SECRET_PREFIX, fromBase64 } from '../generic/encoding';
import { isValidWebhookId, verifyStandardWebhook } from '../generic/signature';
import type { VerifyInput, VerifyResult } from '../types';

/**
 * GitLab request authentication. Sources: docs.gitlab.com/user/project/integrations/webhooks/
 * (read 2026-10-13); spec 06 F81.
 *
 * Two credentials exist and a source holds exactly ONE of them, chosen by the person who
 * connected it (`auth_mode`), never sniffed from its shape:
 *
 *  - `signing_token`: GitLab (19.0+, GA 19.1) follows Standard Webhooks: headers `webhook-id`,
 *    `webhook-timestamp`, `webhook-signature`, signed content `id.timestamp.body`, key = the
 *    base64 part of the `whsec_` token. This is the generic verifier, reused unchanged, so
 *    there is no bespoke GitLab crypto. A request WITHOUT a signature is refused: a source that
 *    holds a signing token never falls back to anything weaker.
 *  - `secret_token`: `X-Gitlab-Token`, plain text, compared in constant time. GitLab calls it
 *    weaker and "not recommended for new webhooks": it proves the sender knows the token, not
 *    that the body is intact, and it carries no timestamp, so a captured request can be
 *    replayed. The dashboard says so. Idempotency still absorbs a replayed delivery id.
 *
 * GitLab's documented migration (configure both, verify the signature when present, else the
 * token) is not offered: a source holds one credential, so the stronger-wins ordering rule
 * (spec F81, "an invalid signature is not rescued by a valid token") holds by construction.
 * To migrate, paste the signing token on the source (rotate with `authMode: signing_token`).
 */

/** Our own delivery-id rule for header-borne ids; anything else falls back to the body hash. */
function headerId(headers: Headers, name: string): string | null {
  const v = headers.get(name);
  return isValidWebhookId(v) ? v : null;
}

export async function verifyGitlab(input: VerifyInput): Promise<VerifyResult> {
  if (input.authMode === 'signing_token') {
    if (!input.secret.startsWith(SECRET_PREFIX)) return { ok: false, reason: 'secret_unusable' };
    const key = fromBase64(input.secret.slice(SECRET_PREFIX.length));
    if (!key || key.length === 0) return { ok: false, reason: 'secret_unusable' };
    const verdict = await verifyStandardWebhook(
      key,
      {
        id: input.headers.get('webhook-id'),
        timestamp: input.headers.get('webhook-timestamp'),
        signature: input.headers.get('webhook-signature'),
      },
      input.raw,
      input.nowSeconds,
    );
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    // `Idempotency-Key` is documented as equal to `webhook-id`; `webhook-id` is the signed one.
    return { ok: true, eventId: input.headers.get('webhook-id') };
  }
  const presented = input.headers.get('x-gitlab-token');
  if (presented === null || presented.length === 0 || presented.length > 512)
    return { ok: false, reason: 'malformed' };
  if (!(await constantTimeEqual(presented, input.secret))) return { ok: false, reason: 'mismatch' };
  // Not signed, so only a corroborating id: `Idempotency-Key` stays the same across retries.
  return { ok: true, eventId: headerId(input.headers, 'idempotency-key') };
}
