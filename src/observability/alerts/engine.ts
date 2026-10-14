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
import { readMaintenance } from '../cron';
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
import {
  MAX_NOTIFY_FAILURES,
  NOTIFY_RETRY_MS,
  SETTLE_AFTER_MAINTENANCE_MS,
  SINK_BUDGET_MS,
} from './thresholds';

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
  /** Every sink accepted the notice. False also when a webhook was skipped for the budget (retried later). */
  readonly ok: boolean;
  /** A webhook request was actually made: its outcome is worth recording. */
  readonly webhookTried: boolean;
  /** A webhook request was made and failed. A skip for the budget made no request and is not a failure. */
  readonly webhookFailed: boolean;
}

/** Contained: a throwing sink is logged, never rethrown. */
async function announce(
  sinks: readonly AlertSink[],
  event: AlertEvent,
  deadlineMs: number,
): Promise<Delivery> {
  let ok = true;
  let webhookTried = false;
  let webhookFailed = false;
  for (const sink of sinks) {
    const remaining = deadlineMs - Date.now();
    const external = sink.name !== 'log';
    if (external && remaining <= 0) {
      ok = false; // not sent, so retried; but no request was made, so the webhook is not blamed
      log('error', 'alert_sink_failed', {
        sink: sink.name,
        alert: event.alertId,
        reason: 'budget_exhausted',
      });
      continue;
    }
    if (external) webhookTried = true;
    try {
      await sink.notify(event, { timeoutMs: remaining });
    } catch (error) {
      if (external) {
        ok = false;
        webhookFailed = true;
      }
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
  return { ok, webhookTried, webhookFailed };
}

/** The incident key is `<alert>:<time it started firing>`: how long it fired survives a re-sent RESOLVED. */
function firingStart(row: AlertRow): number {
  const at = Number(row.dedupeKey.slice(row.dedupeKey.lastIndexOf(':') + 1));
  return Number.isFinite(at) ? at : row.since;
}

function firingFor(kind: AlertEventKind, row: AlertRow, nowMs: number): number {
  if (kind === 'firing') return 0;
  // RESOLVED: `since` is when it resolved (also on a re-send), so the duration never grows with the delay.
  return Math.max(0, (kind === 'resolved' ? row.since : nowMs) - firingStart(row));
}

function eventFor(
  def: AlertDef,
  kind: AlertEventKind,
  row: AlertRow,
  value: number | null,
  nowMs: number,
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
    firingForMs: firingFor(kind, row, nowMs),
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

const UNUSABLE_KEY = 'alert_webhook_unusable_logged';
const UNUSABLE_LOG_EVERY_MS = 60 * 60_000;

/** A secret that is set but unusable means alerts reach the log only: say so, at most once an hour. */
async function warnUnusableWebhook(db: Bindings['DB'], nowMs: number): Promise<void> {
  try {
    const row = await db
      .prepare('SELECT value FROM ops_state WHERE key=?1')
      .bind(UNUSABLE_KEY)
      .first<{ value: string }>();
    const last = Number(row?.value);
    if (Number.isFinite(last) && nowMs - last < UNUSABLE_LOG_EVERY_MS) return;
    await db
      .prepare(
        `INSERT INTO ops_state(key,value,updated_at) VALUES(?1,?2,?3)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      )
      .bind(UNUSABLE_KEY, String(nowMs), nowMs)
      .run();
  } catch {
    // ops_state unreadable: fall through and log (noisier is the safe direction).
  }
  log('warn', 'alert_webhook_unusable', {});
}

export async function evaluateAlerts(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  nowMs: number = Date.now(),
  deps: EngineDeps = {},
): Promise<AlertReport> {
  const sinks = deps.sinks ?? sinksFromEnv(env);
  if (env.ALERT_WEBHOOK_URL?.trim() && !resolveWebhookTarget(env.ALERT_WEBHOOK_URL, env.APP_ORIGIN)) {
    await warnUnusableWebhook(env.DB, nowMs);
  }
  const signals = deps.signals ?? (await collectSignals(env, nowMs, deps.stallCounts));
  const states = await loadAlertStates(env.DB);
  // Shortly after a maintenance freeze the backlog and job-freshness signals look bad until the cron has
  // caught up; those alerts hold their state (neither fire nor resolve) for the settle period.
  const marker = await readMaintenance(env.DB).catch(() => null);
  const settling = marker !== null && nowMs - marker.to <= SETTLE_AFTER_MAINTENANCE_MS;
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
    const value = def.settlesAfterMaintenance && settling ? null : def.read(signals);
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
      const delivery = await announce(sinks, eventFor(def, kind, base, value, nowMs, environment), deadline);
      webhookTried = webhookTried || delivery.webhookTried;
      webhookFailed = webhookFailed || delivery.webhookFailed;
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
