/**
 * The alert engine (docs/specs/13-observability.md F200): once per cron tick, read the signals, decide
 * each alert's transition with the pure state machine, persist it in `alert_state` and announce it to the
 * sinks.
 *
 * Failure containment: a signal that cannot be read leaves its alert untouched; a sink that throws is
 * logged (class only) and never fails the tick or the other sinks; a failed notification is retried at
 * most NOTIFY_RETRY_MS later (never in a loop), because the incident row already says `firing`. A failed
 * `alert_state` write is logged and the evaluation continues with the other alerts.
 *
 * Overlapping ticks are not serialised (D1 has no cross-request lock here): the worst case is one
 * duplicate notification carrying the same dedupe key.
 */
import type { Bindings } from '../../env';
import { log } from '../../platform/log';
import { ALERTS, type AlertDef } from './registry';
import { collectSignals, type Signals } from './signals';
import { sinksFromEnv, type AlertEvent, type AlertEventKind, type AlertSink } from './sinks';
import { decideAlert, loadAlertStates, saveAlertState, type AlertRow } from './state';
import { NOTIFY_RETRY_MS } from './thresholds';

export interface AlertReport {
  readonly evaluated: number;
  readonly unknown: number;
  readonly fired: number;
  readonly renotified: number;
  readonly resolved: number;
  readonly firing: number;
  readonly notifyFailures: number;
}

export interface EngineDeps {
  readonly sinks?: readonly AlertSink[];
  readonly signals?: Signals;
}

const EVENT_KIND: Readonly<Record<'fire' | 'renotify' | 'resolve', AlertEventKind>> = {
  fire: 'firing',
  renotify: 'renotify',
  resolve: 'resolved',
};

/** True when every sink accepted the event. A throwing sink is contained here. */
async function announce(sinks: readonly AlertSink[], event: AlertEvent): Promise<boolean> {
  let ok = true;
  for (const sink of sinks) {
    try {
      await sink.notify(event);
    } catch (error) {
      ok = false;
      // The class and, for our own closed webhook codes, the code. Never the message: a sink's error text
      // could carry a URL.
      const message = error instanceof Error ? error.message : '';
      log('error', 'alert_sink_failed', {
        sink: sink.name,
        alert: event.alertId,
        error_class: error instanceof Error ? error.name : 'unknown',
        ...(/^alert_webhook_[a-z_]+:[a-z_]+$/.test(message) ? { reason: message } : {}),
      });
    }
  }
  return ok;
}

function eventFor(
  def: AlertDef,
  kind: AlertEventKind,
  row: AlertRow,
  value: number | null,
  nowMs: number,
  prev: AlertRow | null,
  environment: string,
): AlertEvent {
  return {
    kind,
    alertId: def.id,
    severity: def.severity,
    summary: def.summary,
    value,
    threshold: def.threshold,
    unit: def.unit,
    dedupeKey: row.dedupeKey,
    firingForMs: kind === 'firing' ? 0 : Math.max(0, nowMs - (prev?.since ?? row.since)),
    environment,
  };
}

export async function evaluateAlerts(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  nowMs: number = Date.now(),
  deps: EngineDeps = {},
): Promise<AlertReport> {
  const sinks = deps.sinks ?? sinksFromEnv(env);
  const signals = deps.signals ?? (await collectSignals(env, nowMs));
  const states = await loadAlertStates(env.DB);
  const environment = env.ENVIRONMENT_NAME ?? 'unknown';
  let report: AlertReport = {
    evaluated: 0,
    unknown: 0,
    fired: 0,
    renotified: 0,
    resolved: 0,
    firing: 0,
    notifyFailures: 0,
  };
  for (const def of ALERTS) {
    const value = def.read(signals);
    const prev = states.get(def.id) ?? null;
    const decision = decideAlert(prev, {
      id: def.id,
      breached: value === null ? null : value >= def.threshold,
      value,
      nowMs,
      renotifyMs: def.renotifyMs,
      confirmTicks: def.confirmTicks,
    });
    report = {
      ...report,
      evaluated: report.evaluated + 1,
      unknown: report.unknown + (value === null ? 1 : 0),
    };
    let next = decision.next;
    if (decision.action !== 'none' && next) {
      const delivered = await announce(
        sinks,
        eventFor(def, EVENT_KIND[decision.action], next, value, nowMs, prev, environment),
      );
      if (!delivered) {
        report = { ...report, notifyFailures: report.notifyFailures + 1 };
        // Try again soon, not at the full cadence. A failed RESOLVED is not retried: the state is right.
        if (decision.action !== 'resolve')
          next = { ...next, lastNotified: nowMs - def.renotifyMs + NOTIFY_RETRY_MS };
      }
      report = {
        ...report,
        fired: report.fired + (decision.action === 'fire' ? 1 : 0),
        renotified: report.renotified + (decision.action === 'renotify' ? 1 : 0),
        resolved: report.resolved + (decision.action === 'resolve' ? 1 : 0),
      };
    }
    if (next && next !== prev) {
      try {
        await saveAlertState(env.DB, next, nowMs);
      } catch (error) {
        log('error', 'alert_state_write_failed', { alert: def.id, error });
      }
    }
    if (next?.state === 'firing') report = { ...report, firing: report.firing + 1 };
  }
  return report;
}
