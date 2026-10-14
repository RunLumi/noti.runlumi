/**
 * Audit of a signed GitHub event that no workspace can receive (docs/specs/02 F233, ADR 0028, 1.23):
 * an installation we have no row for, or one that is suspended or uninstalled.
 *
 * The response is unchanged by anything here (a 403, one body for every unroutable case), and a
 * failed or skipped record never alters it. What is recorded is bounded on purpose, in this order:
 *  1. dedupe first: one row per (installation, workspace) per hour, so a repeat spends no budget;
 *  2. a per-installation cap, so one chatty installation cannot spend another tenant's budget;
 *  3. a platform-wide ceiling of `WEBHOOK_PROBES_RECORDED_PER_MINUTE` a minute, so many installation
 *     ids cannot flood the table. Over it, the first refusal in a window writes one marker row
 *     (`probe_audit_capped`, no workspace) and a warning is logged: the loss is never silent.
 * A known workspace (a suspended installation) gets the row in ITS log, where its admins can see that
 * GitHub is still sending; an unknown installation has no workspace, so the row has none and is read
 * by an operator from D1, never through a tenant's API. Two concurrent first events can both pass the
 * dedupe check and write two rows: accepted (bounded by the caps, harmless to read).
 * The installation id is a number GitHub assigned; it is not a secret and carries no payload.
 */
import { recordDenial } from '../../../audit/audit';
import { log } from '../../../platform/log';
import { hit } from '../../../security/rate-limit';

export const WEBHOOK_PROBES_RECORDED_PER_MINUTE = 30;
export const WEBHOOK_PROBES_PER_INSTALLATION_PER_MINUTE = 3;
export const WEBHOOK_PROBE_DEDUPE_SECONDS = 3600;

export interface WebhookProbe {
  /** The workspace that owns the installation, or null when no workspace does. */
  readonly organizationId: string | null;
  readonly installationId: string;
  readonly reason: 'unknown-installation' | 'not-active';
}

export async function recordWebhookProbe(db: D1Database, probe: WebhookProbe): Promise<void> {
  try {
    const installation = probe.installationId.slice(0, 40);
    await recordDenial(
      db,
      {
        organizationId: probe.organizationId,
        actorId: null,
        action: 'github.webhook.refused',
        subjectType: 'github_installation',
        subjectId: installation,
        outcome: 'denied',
        metadata: { reason: probe.reason === 'not-active' ? 'not_active' : 'unknown_installation' },
      },
      {
        dedupeSeconds: WEBHOOK_PROBE_DEDUPE_SECONDS,
        gate: async () => {
          const own = await hit(
            db,
            `probe-audit:github-webhook:${installation}`,
            WEBHOOK_PROBES_PER_INSTALLATION_PER_MINUTE,
            60_000,
          );
          if (own.limited) return false;
          const all = await hit(db, 'probe-audit:github-webhook', WEBHOOK_PROBES_RECORDED_PER_MINUTE, 60_000);
          if (!all.limited) return true;
          if (all.count === WEBHOOK_PROBES_RECORDED_PER_MINUTE + 1) {
            log('warn', 'webhook_probe_audit_capped', { limit: WEBHOOK_PROBES_RECORDED_PER_MINUTE });
            await recordDenial(db, {
              organizationId: null,
              actorId: null,
              action: 'github.webhook.refused',
              subjectType: 'github_installation',
              subjectId: null,
              outcome: 'denied',
              metadata: { reason: 'probe_audit_capped' },
            });
          }
          return false;
        },
      },
    );
  } catch {
    // Bookkeeping only: the 403 the caller is about to return must not change.
  }
}
