import { asRecord, str } from '../../../lib/json';
import type { InstallationSourceConnector } from '../connector';
import { GITHUB_EVENT_TYPES, isGithubEventType } from './catalog';
import { classifyGithubEvent, verifyGithubSignature } from './events';
import { handleLifecycle, LIFECYCLE_EVENTS } from './lifecycle';
import { GITHUB_ADAPTER_VERSION, mapGithubEvent } from './map';
import { repositoryInScope, resolveTenant } from './tenant';

/**
 * The GitHub App source behind the one connector interface (spec 05 F71, ADR 0057). Every member
 * delegates to the function the route called before this connector existed, so the behaviour,
 * responses, logs and tenant resolution are the same; what changed is that the route reaches
 * them only through this object.
 */

/** Hard cap on an inbound body. See docs/specs/05-source-github.md F63. */
export const MAX_BODY_BYTES = 1024 * 1024;

export const githubConnector: InstallationSourceConnector = {
  kind: 'github',
  label: 'GitHub',
  adapterVersion: GITHUB_ADAPTER_VERSION,
  maxBodyBytes: MAX_BODY_BYTES,
  eventCatalog: GITHUB_EVENT_TYPES,
  tenantResolution: 'installation',
  credentialScope: 'app',
  // GitHub's signature carries no timestamp (X-Hub-Signature-256 only), so a replay is absorbed by
  // idempotency on X-GitHub-Delivery, which a manual redelivery keeps.
  replayWindowSeconds: null,
  idempotencyKey: 'X-GitHub-Delivery',
  ack: {
    onFlood: 'reject',
    // "GitHub will not retry it" (spec 05 F64): only a manual or API redelivery re-sends.
    providerRetries: false,
    // An event outside the closed catalogue: `202 {accepted, persisted: 0}`.
    ignored: 202,
  },

  appCredential(env) {
    if (!env.GITHUB_WEBHOOK_SECRET) return null;
    return { secret: env.GITHUB_WEBHOOK_SECRET, appId: env.GITHUB_APP_ID };
  },

  verify: async ({ secret, headers, raw }) => {
    // Kept exactly as before this connector existed: the HMAC runs over the UTF-8 re-encoding of
    // the decoded body, which equals the raw bytes for every valid UTF-8 body GitHub sends. A body
    // that is not valid UTF-8 (or starts with a BOM) therefore does not verify. ADR 0057 lists
    // the switch to the exact bytes as a separate, behaviour-changing follow-up.
    const ok = await verifyGithubSignature(
      new TextDecoder().decode(raw),
      headers.get('x-hub-signature-256') || '',
      secret,
    );
    // X-GitHub-Delivery is outside the signature, so the verifier vouches for no identity.
    return ok ? { ok: true, eventId: null } : { ok: false, reason: 'signature' };
  },

  classify(headers, body) {
    // F59: the event name is a header, and a delivery without one cannot be classified.
    const name = headers.get('x-github-event') || '';
    if (!name) return { kind: 'invalid' };
    // GitHub pings the App webhook when it is configured. It carries no installation and routes
    // nothing; acknowledging it is what makes "Redeliver" in GitHub's UI go green.
    if (name === 'ping') return { kind: 'ping' };
    // Lifecycle events change installation state and never route a notification (F68).
    if (LIFECYCLE_EVENTS.has(name)) return { kind: 'lifecycle', name };
    const repository = asRecord(body.repository);
    const repo = str(repository?.full_name);
    const deliveryId = headers.get('x-github-delivery') || '';
    if (!repo || !deliveryId) return { kind: 'invalid' };
    const eventType = classifyGithubEvent(name, body);
    return {
      kind: 'event',
      name,
      // Outside the closed catalog nothing can be subscribed, so nothing is looked up (D16).
      eventType: isGithubEventType(eventType) ? eventType : null,
      repo,
      repositoryId: repository?.id,
      deliveryId,
    };
  },

  applyLifecycle: handleLifecycle,
  resolveTenant,
  repositoryInScope,

  map: ({ name, body, eventType, id }) =>
    mapGithubEvent({ kind: name, event: body, eventType, deliveryId: id }),
};
