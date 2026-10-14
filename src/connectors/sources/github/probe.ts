/**
 * Audit of a signed GitHub event that no workspace can receive (docs/specs/02 F233, ADR 0028, 1.23):
 * an installation we have no row for, or one that is suspended or uninstalled.
 *
 * The response is unchanged by anything here (a 403, one body for every unroutable case), and a
 * failed or skipped record never alters it. What is recorded is bounded on purpose:
 *  - one row per (installation, workspace) per hour, not one per event, so a chatty unbound or
 *    suspended installation cannot grow the log;
 *  - at most `WEBHOOK_PROBES_RECORDED_PER_MINUTE` rows a minute across the whole platform, so a
 *    sender with a valid signature cannot use many installation ids to flood it;
 *  - a known workspace (a suspended installation) gets the row in ITS log, where its admins can see
 *    that GitHub is still sending; an unknown installation has no workspace, so the row has none and
 *    is read by an operator from D1, never through a tenant's API.
 * The installation id is a number GitHub assigned; it is not a secret and carries no payload.
 */
import { recordDenial } from '../../../audit/audit';
import { hit } from '../../../security/rate-limit';

export const WEBHOOK_PROBES_RECORDED_PER_MINUTE = 30;
export const WEBHOOK_PROBE_DEDUPE_SECONDS = 3600;

export interface WebhookProbe {
  /** The workspace that owns the installation, or null when no workspace does. */
  readonly organizationId: string | null;
  readonly installationId: string;
  readonly reason: 'unknown-installation' | 'not-active';
}

export async function recordWebhookProbe(db: D1Database, probe: WebhookProbe): Promise<void> {
  try {
    const limit = await hit(db, 'probe-audit:github-webhook', WEBHOOK_PROBES_RECORDED_PER_MINUTE, 60_000);
    if (limit.limited) return;
    await recordDenial(
      db,
      {
        organizationId: probe.organizationId,
        actorId: null,
        action: 'github.webhook.refused',
        subjectType: 'github_installation',
        subjectId: probe.installationId.slice(0, 40),
        outcome: 'denied',
        metadata: { reason: probe.reason === 'not-active' ? 'not_active' : 'unknown_installation' },
      },
      { dedupeSeconds: WEBHOOK_PROBE_DEDUPE_SECONDS },
    );
  } catch {
    // Bookkeeping only: the 403 the caller is about to return must not change.
  }
}
