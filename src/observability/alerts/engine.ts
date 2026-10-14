/**
 * The alert engine (docs/specs/13-observability.md F200): once per cron tick, read the signals, decide
 * each alert's transition with the pure state machine, persist it in `alert_state` and announce it to the
 * sinks.
 *
 * Failure containment:
 *  - a signal that cannot be read leaves its alert untouched;
 *  - a sink that throws is logged (class and closed code only, never a message) and never fails the tick
 *    or the other sinks;
 *  - a notice a sink refused is kept on the row (`unsent`) and RE-SENT AS THE SAME KIND (a FIRING stays a
 *    FIRING, a RESOLVED is retried too) ten minutes later, at most MAX_NOTIFY_FAILURES times, never in a loop;
 *  - all sinks together get SINK_BUDGET_MS per evaluation (each webhook call is given what is left, capped
 *    at its own timeout), so a hung endpoint cannot delay the cron jobs after the alert job;
 *  - a failed `alert_state` write is logged and the evaluation continues with the other alerts;
 *  - the webhook's health (last success, last failure, consecutive failures) is recorded in `ops_state`.
 *
 * Overlapping ticks are not serialised (D1 has no cross-request lock here): the worst case is one
 * duplicate notification carrying the same dedupe key.
 */
import type { Bindings } from '../../env';
import { log } from '../../platform/log';
import { ALERTS, type AlertDef } from './registry';
import type { StallCounts } from '../stall';
import { collectSignals, type Signals } from './signals';
import { recordSinkAttempt } from './sink-health';
import {
  resolveWebhookTarget,
  sinksFromEnv,
  type AlertEvent,
  type AlertEventKind,
  type AlertSink,
} from './sinks';
import { decideAlert, loadAlertStates, saveAlertState, type AlertRow, type NoticeKind } from './state';
import { MAX_NOTIFY_FAILURES, NOTIFY_RETRY_MS, SINK_BUDGET_MS } from './thresholds';

export interface AlertReport {
  readonly evaluated: number;
  readonly unknown: number;
  readonly fired: number;
  readonly renotified: number;
  readonly resolved: number;
  readonly firing: number;
  readonly notifyFailures: number;
  readonly resent: number;
}

export interface EngineDeps {
  readonly sinks?: readonly AlertSink[];
  readonly signals?: Signals;
  /** The tick's shared stall counts, so the stall detector and the alert read D1 once. */
  readonly stallCounts?: StallCounts;
}

const EVENT_KIND: Readonly<Record<'fire' | 'renotify' | 'resolve', AlertEventKind>> = {
  fire: 'firing',
  renotify: 'renotify',
  resolve: 'resolved',
};

interface Delivery {
  readonly ok: boolean;
  /** A non-log sink was asked (or skipped for the budget): the webhook's health is worth recording. */
  readonly webhookTried: boolean;
}

/** Contained: a throwing sink is logged, never rethrown. */
async function announce(
  sinks: readonly AlertSink[],
  event: AlertEvent,
  deadlineMs: number,
): Promise<Delivery> {
  let ok = true;
  let webhookTried = false;
  for (const sink of sinks) {
    const remaining = deadlineMs - Date.now();
    const external = sink.name !== 'log';
    if (external) webhookTried = true;
    if (external && remaining <= 0) {
      ok = false;
      log('error', 'alert_sink_failed', {
        sink: sink.name,
        alert: event.alertId,
        reason: 'budget_exhausted',
      });
      continue;
    }
    try {
      await sink.notify(event, { timeoutMs: remaining });
    } catch (error) {
      if (external) ok = false;
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
  return { ok, webhookTried };
}

function eventFor(
  def: AlertDef,
  kind: AlertEventKind,
  row: AlertRow,
  value: number | null,
  nowMs: number,
  since: number,
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
    firingForMs: kind === 'firing' ? 0 : Math.max(0, nowMs - since),
    environment,
  };
}

/** What happened to the notice: cleared on success, queued for a re-send on failure, dropped after too many. */
function afterDelivery(
  row: AlertRow,
  kind: NoticeKind,
  delivered: boolean,
  nowMs: number,
  failuresBefore: number,
  alert: string,
): AlertRow {
  if (delivered) return { ...row, unsent: null, retryAt: null, notifyFailures: 0 };
  const failures = failuresBefore + 1;
  if (failures >= MAX_NOTIFY_FAILURES) {
    log('error', 'alert_notice_dropped', { alert, kind, failures });
    return { ...row, unsent: null, retryAt: null, notifyFailures: 0 };
  }
  return { ...row, unsent: kind, retryAt: nowMs + NOTIFY_RETRY_MS, notifyFailures: failures };
}

export async function evaluateAlerts(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  nowMs: number = Date.now(),
  deps: EngineDeps = {},
): Promise<AlertReport> {
  const sinks = deps.sinks ?? sinksFromEnv(env);
  if (env.ALERT_WEBHOOK_URL?.trim() && !resolveWebhookTarget(env.ALERT_WEBHOOK_URL, env.APP_ORIGIN)) {
    // Every tick while it stays wrong: a secret that is set but unusable means alerts reach the log only.
    log('warn', 'alert_webhook_unusable', {});
  }
  const signals = deps.signals ?? (await collectSignals(env, nowMs, deps.stallCounts));
  const states = await loadAlertStates(env.DB);
  const environment = env.ENVIRONMENT_NAME ?? 'unknown';
  const deadline = Date.now() + SINK_BUDGET_MS;
  let report: AlertReport = {
    evaluated: 0,
    unknown: 0,
    fired: 0,
    renotified: 0,
    resolved: 0,
    firing: 0,
    notifyFailures: 0,
    resent: 0,
  };
  let webhookTried = false;
  let webhookFailed = false;

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
      resolveTicks: def.clearTicks,
    });
    report = {
      ...report,
      evaluated: report.evaluated + 1,
      unknown: report.unknown + (value === null ? 1 : 0),
    };
    let next = decision.next;

    // A new transition supersedes an unsent notice; otherwise a due unsent notice is re-sent as it was.
    const resend =
      decision.action === 'none' && prev?.unsent && prev.retryAt !== null && prev.retryAt <= nowMs;
    const kind: NoticeKind | null =
      decision.action !== 'none' ? EVENT_KIND[decision.action] : resend && prev?.unsent ? prev.unsent : null;
    const base = next ?? prev;
    if (kind && base) {
      const since = decision.action === 'resolve' ? (prev?.since ?? base.since) : base.since;
      const delivery = await announce(
        sinks,
        eventFor(def, kind, base, value, nowMs, since, environment),
        deadline,
      );
      webhookTried = webhookTried || delivery.webhookTried;
      webhookFailed = webhookFailed || !delivery.ok;
      next = afterDelivery(
        base,
        kind,
        delivery.ok,
        nowMs,
        decision.action === 'none' ? (prev?.notifyFailures ?? 0) : 0,
        def.id,
      );
      report = {
        ...report,
        notifyFailures: report.notifyFailures + (delivery.ok ? 0 : 1),
        resent: report.resent + (decision.action === 'none' ? 1 : 0),
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

  if (webhookTried) {
    try {
      await recordSinkAttempt(env.DB, nowMs, !webhookFailed);
    } catch (error) {
      log('warn', 'alert_sink_health_write_failed', { error });
    }
  }
  return report;
}
