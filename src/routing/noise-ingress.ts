import type { DeliveryMessage } from '../env';
import { log } from '../platform/log';
import {
  decideNoise,
  groupKeyOf,
  holdsUpdates,
  isCritical,
  readStoredNoise,
  type DeliverReason,
  type HoldReason,
  type NoiseSettings,
} from './noise';
import { holdStatement, readHoldContext } from './noise-store';

/**
 * The one place ingress asks "deliver now, or hold?" for a noise-enabled integration (ADR 0016).
 * Each source route calls this after it has decided that an integration should receive an event
 * at all (subscription, routing filters); it never decides that an event is NOT wanted. The
 * result is `deliver` or `hold`, so no path can lose an event, and a `hold` carries the
 * statement that stores it. The routes only choose which batch the statement goes into.
 */

type Display = Pick<DeliveryMessage, 'title' | 'url' | 'repo' | 'actor' | 'status' | 'eventType' | 'summary'>;

export interface NoiseCandidate {
  readonly integrationId: string;
  readonly noiseJson: string | null;
  /** Deterministic delivery id for (dedup key, integration). */
  readonly deliveryId: string;
  /** Some GitHub rows predate 0009 and use `${deliveryId}:${integrationId}`; same id otherwise. */
  readonly legacyId?: string;
  readonly eventType: string;
  /** Normalised object the update is about: `#42`, `run:123`, `branch:main`; may be empty. */
  readonly subject: string;
  readonly display: Display;
  readonly resolved?: boolean;
}

export type NoisePlan =
  | {
      readonly action: 'deliver';
      /** Present when the settings changed the outcome (a bypass or a full backlog). */
      readonly reason: Extract<DeliverReason, 'critical_bypass' | 'hold_capacity'> | null;
      readonly settings: NoiseSettings | null;
    }
  | {
      readonly action: 'hold';
      readonly reason: HoldReason;
      readonly releaseAt: number;
      readonly statement: D1PreparedStatement;
    };

/**
 * One planner per request: each distinct stored document is parsed once, and `nowMs` is read
 * once so every integration of one event is decided against the same instant.
 */
export function createNoisePlanner(db: D1Database, organizationId: string, nowMs: number) {
  const cache = new Map<string, NoiseSettings | null>();

  /** The settings in force, or null. An unusable document fails OPEN (delivers) and is logged. */
  const settingsOf = (integrationId: string, json: string | null): NoiseSettings | null => {
    if (json === null || json === '') return null;
    if (cache.has(json)) return cache.get(json) ?? null;
    const stored = readStoredNoise(json);
    if (stored.kind === 'invalid' || stored.kind === 'newer') {
      log('error', 'noise_settings_unusable', {
        integration_id: integrationId,
        state: stored.kind === 'newer' ? 'newer_version' : 'invalid',
      });
    }
    const settings = stored.kind === 'ok' ? stored.settings : null;
    cache.set(json, settings);
    return settings;
  };

  return {
    settingsOf,
    async plan(c: NoiseCandidate): Promise<NoisePlan> {
      const settings = settingsOf(c.integrationId, c.noiseJson);
      if (!settings) return { action: 'deliver', reason: null, settings: null };
      // Only resolved notices configured: nothing can hold an update, so skip the reads.
      if (!holdsUpdates(settings)) return { action: 'deliver', reason: null, settings };
      const critical = isCritical(c.display.status, c.eventType);
      // A critical update never needs the backlog read: it is delivered whatever it says.
      const groupKey = await groupKeyOf({
        organizationId,
        integrationId: c.integrationId,
        eventType: c.eventType,
        repo: c.display.repo ?? '',
        subject: c.subject,
      });
      const context = critical
        ? { heldCount: 0, openGroupReleaseAt: null }
        : await readHoldContext(db, organizationId, c.integrationId, groupKey);
      const decision = decideNoise(settings, { critical, nowMs, ...context });
      if (decision.action === 'deliver') {
        if (decision.reason === 'hold_capacity')
          log('warn', 'noise_hold_capacity', { integration_id: c.integrationId });
        return {
          action: 'deliver',
          reason:
            decision.reason === 'critical_bypass' || decision.reason === 'hold_capacity'
              ? decision.reason
              : null,
          settings,
        };
      }
      return {
        action: 'hold',
        reason: decision.reason,
        releaseAt: decision.releaseAt,
        statement: holdStatement(db, {
          id: c.deliveryId,
          legacyId: c.legacyId ?? c.deliveryId,
          organizationId,
          integrationId: c.integrationId,
          reason: decision.reason,
          groupKey,
          releaseAt: decision.releaseAt,
          heldAt: nowMs,
          resolved: c.resolved === true,
          display: c.display,
        }),
      };
    },
  };
}
