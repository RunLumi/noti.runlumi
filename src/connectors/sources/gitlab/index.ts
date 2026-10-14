import { repoSource } from '../../../events/canonical';
import { SECRET_PREFIX, fromBase64 } from '../generic/encoding';
import type { AuthMode, FieldError, SecretInput, SourceConnector } from '../types';
import { GITLAB_EVENT_TYPES } from './catalog';
import { mapGitlab } from './map';
import { verifyGitlab } from './verify';

/**
 * GitLab.com source (spec 06 F81–F83, ADR 0015). GitLab does not let us choose the credential:
 * the person creates it in GitLab (a secret token they type, or a signing token GitLab shows
 * once) and pastes it here. It is sealed on write and never shown again.
 */

/** 1 MiB, the spec's ingress cap: a pipeline event with many jobs is far larger than a generic event. */
const MAX_BODY_BYTES = 1024 * 1024;

const SIGNING_TOKEN_MAX = 512;
const SECRET_TOKEN_MIN = 8;
const SECRET_TOKEN_MAX = 255;
// Printable ASCII without spaces: a header value cannot carry anything else intact.
const SECRET_TOKEN = /^[!-~]+$/;

function parseSecret(body: Record<string, unknown>): SecretInput {
  const errors: FieldError[] = [];
  const mode = body.authMode;
  if (mode !== 'signing_token' && mode !== 'secret_token')
    errors.push({ field: 'authMode', message: 'Choose signing_token or secret_token.' });
  const secret = body.secret;
  if (typeof secret !== 'string' || secret.length === 0) {
    errors.push({ field: 'secret', message: 'Paste the token from your GitLab webhook settings.' });
  } else if (mode === 'signing_token') {
    const decoded = secret.startsWith(SECRET_PREFIX) ? fromBase64(secret.slice(SECRET_PREFIX.length)) : null;
    if (secret.length > SIGNING_TOKEN_MAX || !decoded || decoded.length === 0)
      errors.push({
        field: 'secret',
        message:
          'A signing token starts with whsec_ followed by base64. Paste it exactly as GitLab showed it.',
      });
  } else if (mode === 'secret_token') {
    if (secret.length < SECRET_TOKEN_MIN || secret.length > SECRET_TOKEN_MAX || !SECRET_TOKEN.test(secret))
      errors.push({
        field: 'secret',
        message: `Use ${SECRET_TOKEN_MIN}–${SECRET_TOKEN_MAX} visible characters without spaces.`,
      });
  }
  if (errors.length > 0 || typeof secret !== 'string') return { ok: false, errors };
  return { ok: true, secret, authMode: mode as AuthMode, livemode: null };
}

export const gitlabConnector: SourceConnector = {
  kind: 'gitlab',
  label: 'GitLab',
  adapterVersion: '1.0.0',
  canonicalSource: (display) => repoSource('gitlab.com', display.repo),
  maxBodyBytes: MAX_BODY_BYTES,
  // GitLab counts a 429 as a failed delivery and disables the webhook after four in a row, so a
  // flood is absorbed with a 2xx instead (spec 06 F82).
  onFlood: 'absorb',
  eventCatalog: GITLAB_EVENT_TYPES,
  parseSecret,
  verify: verifyGitlab,
  map: mapGitlab,
  decoy: { secret: `${SECRET_PREFIX}${btoa('Z'.repeat(32))}`, authMode: 'signing_token' },
};
