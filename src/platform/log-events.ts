/**
 * The closed log event catalogue (docs/specs/13-observability.md F194, ADR 0051).
 *
 * Every `msg` that `log()` can emit is a key of `LOG_EVENTS`, with a one-line description and the
 * fields its call sites may pass. `log()` is typed against this object, so an unknown event name, or a
 * field an event does not declare, is a compile error. `docs/LOGS.md` is generated from it and
 * `tests/docs/logs-doc.test.ts` fails when the two differ (`npm run docs:logs` refreshes the table).
 *
 * Adding an entry or a field is a review event: a field reaches the log after `redact()`, but a field
 * nobody declared is a field nobody reviewed. Names are the existing snake_case names; F194's dotted
 * names (`delivery.attempt`) are a target shape, not a rename this catalogue performs.
 *
 * `correlation_id`, `external_request_id` and `cf_ray` are added to every line inside a request or a
 * queue message by `log()` itself (ADR 0011); they are not listed per event.
 */

export interface LogEventSpec {
  /** One line: what happened, in operator terms. */
  readonly description: string;
  /** The only fields a call site may pass for this event. */
  readonly fields: readonly string[];
}

export const LOG_EVENTS = {
  account_deletion_notice_failed: {
    description: 'The account-deletion notice mail could not be sent; the deletion continues.',
    fields: ['error'],
  },
  account_erase_failed: {
    description: 'Erasing an account failed and nothing was deleted; the user is told to retry.',
    fields: ['error'],
  },
  alert_firing: {
    description: 'An operator alert started firing (log sink of the alert engine).',
    fields: ['alert', 'severity', 'value', 'threshold', 'incident', 'firing_for_ms', 'runbook'],
  },
  alert_notice_dropped: {
    description: 'An alert notice failed to reach its sinks too many times and was given up.',
    fields: ['alert', 'kind', 'failures'],
  },
  alert_renotify: {
    description: 'A still-firing alert was re-notified after its re-notify interval.',
    fields: ['alert', 'severity', 'value', 'threshold', 'incident', 'firing_for_ms', 'runbook'],
  },
  alert_resolved: {
    description: 'A firing alert recovered.',
    fields: ['alert', 'severity', 'value', 'threshold', 'incident', 'firing_for_ms', 'runbook'],
  },
  alert_signal_unreadable: {
    description: 'An alert signal could not be read from D1; that alert is not evaluated this tick.',
    fields: ['signal', 'error'],
  },
  alert_sink_failed: {
    description: 'An alert sink (log or chat webhook) failed or ran out of time budget.',
    fields: ['sink', 'alert', 'reason', 'error_class'],
  },
  alert_sink_health_write_failed: {
    description: 'The alert sink health row could not be written.',
    fields: ['error'],
  },
  alert_state_write_failed: {
    description: 'An alert state transition could not be persisted.',
    fields: ['alert', 'error'],
  },
  alert_webhook_unusable: {
    description: 'The configured operator alert webhook is unusable, so chat alert notices are off.',
    fields: [],
  },
  audit_note_failed: {
    description: 'A Better Auth hook could not record its audit row.',
    fields: ['action'],
  },
  audit_read_failed: {
    description: 'An audit log read failed; carries a closed category code only.',
    fields: ['code'],
  },
  audit_total_unavailable: {
    description: 'The audit log total count query failed; the page is served without a total.',
    fields: [],
  },
  audit_write_failed: {
    description: 'An audit row could not be written; the failure is noted for /health/ready.',
    fields: ['action'],
  },
  background_task_failed: {
    description: 'A waitUntil background task rejected; the request was already answered.',
    fields: ['task', 'error'],
  },
  bulk_replay_audit_incomplete: {
    description: 'A bulk replay ran but its audit record could not be completed.',
    fields: ['replayed', 'error'],
  },
  bulk_replay_not_started: {
    description: 'A bulk replay could not start; nothing was sent.',
    fields: ['error'],
  },
  canonical_event_invalid: {
    description: 'A verified source event failed canonical-envelope validation and was dropped.',
    fields: ['source', 'source_id', 'kind', 'fields'],
  },
  config_invalid: {
    description: 'Required configuration is missing or invalid; requests answer 503 and jobs stop.',
    fields: ['misconfigured', 'code'],
  },
  config_unknown_keys: {
    description: 'The Worker has bindings the config schema does not know.',
    fields: ['unknown_bindings'],
  },
  correlation_missing: {
    description: 'A queued delivery carried no correlation id; a fresh one is used.',
    fields: ['delivery_id', 'workspace_id'],
  },
  credential_decrypt_count_failed: {
    description:
      'A send-time credential decrypt failure could not be counted for its alert; the delivery is unaffected.',
    fields: ['error'],
  },
  credential_decrypt_failed: {
    description:
      'Stored destination credentials could not be opened at send time (wrong key or damaged row); counted for an alert.',
    fields: ['delivery_id', 'workspace_id', 'integration_id', 'code'],
  },
  credential_destroy_sweep_failed: {
    description: 'The scheduled credential-destruction sweep failed.',
    fields: ['error'],
  },
  credential_maintenance: {
    description: 'Summary of one credential maintenance run (migrate, rewrap, destroy, backfill).',
    fields: ['migrated', 'rewrapped', 'sourcesRewrapped', 'destroyed', 'backfilled', 'remaining'],
  },
  cron_job_failed: {
    description: 'One scheduled job threw; the other jobs in the tick still ran.',
    fields: ['job', 'error'],
  },
  d1_write_retry: {
    description: 'A D1 write failed with a retryable class and will be retried with backoff.',
    fields: ['label', 'attempt', 'class'],
  },
  d1_write_shed: {
    description: 'D1 shed a write (overloaded); it is not retried here.',
    fields: ['label'],
  },
  dead_letter_consumer_failed: {
    description: 'The dead-letter queue consumer failed on a message; the message is retried.',
    fields: ['delivery_id', 'error'],
  },
  dead_letter_run_record_failed: {
    description: 'The dead-letter consumer could not record its job run.',
    fields: ['error'],
  },
  dedup_purged: {
    description: 'Expired event dedup rows were purged.',
    fields: ['purged', 'more'],
  },
  delivery_attempt: {
    description: 'One delivery attempt finished (warn when it dead-lettered).',
    fields: [
      'delivery_id',
      'workspace_id',
      'integration_id',
      'attempt',
      'outcome',
      'error_code',
      'unmapped_provider_error',
      'status_class',
      'probe',
    ],
  },
  delivery_attempt_failed: {
    description: 'A delivery attempt threw inside the consumer; recorded as internal_error.',
    fields: ['delivery_id', 'error'],
  },
  delivery_consumer_failed: {
    description: 'Handling a delivery queue message threw; the message is retried.',
    fields: ['error'],
  },
  delivery_dead_lettered_by_queue: {
    description: 'The queue dead-lettered a delivery message after its retries.',
    fields: ['delivery_id', 'workspace_id', 'outcome'],
  },
  delivery_deferral_timeout: {
    description: 'A delivery waited too long behind an open circuit or rate limit and was failed.',
    fields: ['delivery_id', 'workspace_id', 'integration_id', 'reason', 'recorded'],
  },
  delivery_deferred: {
    description: 'A delivery was deferred by an open circuit or a destination rate limit.',
    fields: ['delivery_id', 'workspace_id', 'integration_id', 'reason', 'recorded'],
  },
  delivery_message_unparseable: {
    description: 'A delivery queue message did not parse and was acknowledged without work.',
    fields: [],
  },
  delivery_not_found: {
    description: 'A delivery queue message named a delivery that no longer exists.',
    fields: ['delivery_id', 'workspace_id'],
  },
  delivery_stall: {
    description: 'Deliveries are stalled (old outbox rows, stale claims or overdue retries).',
    fields: ['outbox_pending_over_threshold', 'claimed_stale', 'retry_overdue', 'firing_for_ms', 'renotify'],
  },
  delivery_stall_recovered: {
    description: 'A delivery stall cleared.',
    fields: ['firing_for_ms'],
  },
  destination_health_unreadable: {
    description: 'Destination health could not be read; the attempt proceeds without the gate.',
    fields: ['delivery_id', 'error'],
  },
  destination_recheck_refused: {
    description:
      'An integration update was refused because its saved destination URL no longer passes the URL policy.',
    fields: ['integration_id', 'rule'],
  },
  destination_recheck_unreadable: {
    description:
      'An integration update was refused because its saved destination could not be opened to re-check it.',
    fields: ['integration_id', 'code'],
  },
  discord_auto_pause_failed: {
    description: 'Pausing a Discord destination after a permanent failure did not persist.',
    fields: ['delivery_id', 'error'],
  },
  egress_guard_opened: {
    description:
      'The platform-wide Discord guard opened: every Discord request is held until it closes (ADR 0029).',
    fields: ['provider', 'invalid_in_window', 'trip'],
  },
  egress_guard_record_failed: {
    description:
      'A Discord egress count could not be recorded; the delivery outcome is unchanged and the fault is counted (ADR 0029).',
    fields: ['provider', 'error'],
  },
  egress_guard_unreadable: {
    description:
      'The Discord guard could not read its counters and failed open; the fault is counted for egress_guard_failing (ADR 0029).',
    fields: ['provider', 'error'],
  },
  expired_auth_records_purged: {
    description: 'Expired sessions, tokens, invitations, install states and auth limits were purged.',
    fields: [
      'skipped',
      'sessions',
      'overAgeSessions',
      'verifications',
      'invitations',
      'installStates',
      'rateLimitRows',
      'more',
      'aborted',
    ],
  },
  expired_purge_aborted: {
    description: 'The expired-records purge saw an anomaly and deleted nothing.',
    fields: ['table', 'reason', 'total', 'expired'],
  },
  fingerprint_backfill_failed: {
    description: 'Backfilling one credential fingerprint failed; it is retried on the next sweep.',
    fields: ['integration_id', 'source_id', 'error'],
  },
  fingerprint_backfill_sweep_failed: {
    description: 'The scheduled fingerprint backfill sweep failed.',
    fields: ['error'],
  },
  generic_source_secret_unavailable: {
    description: 'A generic webhook source secret could not be opened; the sender gets a 500.',
    fields: ['source_id', 'code'],
  },
  generic_source_touch_failed: {
    description: 'Updating a generic source last-received time failed (display only).',
    fields: ['source_id'],
  },
  generic_webhook_id_reused: {
    description: 'A generic webhook reused a message id with a different body and was refused.',
    fields: ['source_id'],
  },
  github_callback_failed: {
    description:
      'The GitHub App verification callback failed unexpectedly; the user returns to the dashboard.',
    fields: [],
  },
  github_event_too_large: {
    description: 'A GitHub webhook body exceeded the size limit and was refused.',
    fields: ['reason', 'limit_bytes'],
  },
  github_lifecycle_failed: {
    description: 'A GitHub installation lifecycle event could not be applied; GitHub sees a 500.',
    fields: ['kind'],
  },
  github_setup_failed: {
    description: 'The GitHub App setup redirect failed unexpectedly; the user returns to the dashboard.',
    fields: [],
  },
  ingress_usage_write_failed: {
    description: 'The per-workspace ingress usage counter could not be written.',
    fields: ['source'],
  },
  integration_key_destroy_failed: {
    description: 'Destroying an integration credential key failed; it is retried by the sweep.',
    fields: ['integration_id', 'error'],
  },
  integration_old_wipe_failed: {
    description: 'Wiping kept originals of destroyed integration credentials failed.',
    fields: ['error'],
  },
  job_runs_write_failed: {
    description: 'Job run records could not be written.',
    fields: ['rows', 'error'],
  },
  legacy_key_malformed_migration_skipped: {
    description: 'ENCRYPTION_KEY is set but malformed, so the legacy credential migration was skipped.',
    fields: [],
  },
  maintenance_marker_failed: {
    description: 'The maintenance-mode marker could not be written.',
    fields: ['error'],
  },
  maintenance_mode_cron_skipped: {
    description: 'Maintenance mode is on, so the scheduled jobs were skipped.',
    fields: [],
  },
  maintenance_mode_prolonged: {
    description: 'Maintenance mode has been on for longer than expected.',
    fields: ['hours', 'since'],
  },
  noise_hold_capacity: {
    description: 'An integration reached its held-event capacity; the event is delivered now instead.',
    fields: ['integration_id'],
  },
  noise_purged: {
    description: 'Old held-event and open-failure noise rows were purged.',
    fields: ['held', 'openFailures', 'failed'],
  },
  noise_release: {
    description: 'Held events were released as grouped notifications.',
    fields: ['units', 'notifications', 'events', 'reclaimed'],
  },
  noise_release_failed: {
    description: 'Releasing one held group failed; it is retried on the next tick.',
    fields: ['integration_id', 'delivery_id', 'error'],
  },
  noise_settings_unusable: {
    description: 'Stored noise settings are invalid or from a newer version; events are not held.',
    fields: ['integration_id', 'state'],
  },
  outbox_dispatch_incomplete: {
    description: 'An outbox dispatch pass released claims or found invalid rows.',
    fields: ['workspaces', 'dispatched', 'reclaimed', 'lostRace', 'released', 'invalid'],
  },
  outbox_reconcile: {
    description: 'Summary of one outbox reconcile run (sweep stale claims, dispatch, purge).',
    fields: [
      'workspaces',
      'dispatched',
      'reclaimed',
      'lostRace',
      'released',
      'invalid',
      'released_claims',
      'purged',
    ],
  },
  outbox_send_failed: {
    description: 'Sending an outbox row to the delivery queue failed; the claim is released.',
    fields: ['delivery_id', 'workspace_id', 'error'],
  },
  password_changed_notice_failed: {
    description: 'The password-changed notice mail could not be sent; the reset still completes.',
    fields: ['error'],
  },
  probe_audit_capped: {
    description: 'Workspace probe denials hit the per-minute audit cap; further probes are not recorded.',
    fields: ['limit'],
  },
  provider_event_rejected: {
    description: 'A verified provider event was rejected by its connector mapping.',
    fields: ['source_id', 'kind', 'reason'],
  },
  provider_integration_event_types_unreadable: {
    description: 'An integration event-type selection is unreadable; it receives nothing.',
    fields: ['integration_id', 'kind'],
  },
  provider_source_flood_dropped: {
    description: 'A provider source exceeded its rate limit and the event was absorbed (dropped).',
    fields: ['source_id', 'kind'],
  },
  provider_source_secret_unavailable: {
    description: 'A provider source secret could not be opened; the sender gets a 500.',
    fields: ['source_id', 'kind', 'code'],
  },
  provider_source_touch_failed: {
    description: 'Updating a provider source last-received time failed (display only).',
    fields: ['source_id', 'kind'],
  },
  rate_limit_error: {
    description: 'The GitHub ingress rate limiter failed; the event is accepted without it (fail open).',
    fields: ['scope'],
  },
  ready_d1_failed: {
    description: 'The readiness probe could not reach D1.',
    fields: [],
  },
  retention_config_invalid: {
    description: 'A retention variable is invalid and its default is used (variable name only).',
    fields: ['var'],
  },
  retention_purge: {
    description: 'Summary of one retention purge pass.',
    fields: ['skipped', 'deliveries', 'attempts', 'outbox', 'audit', 'jobRuns', 'ingressUsage', 'more'],
  },
  revoked_secret_awaiting_fingerprint: {
    description: 'Revoked secrets cannot be destroyed until their fingerprint is backfilled.',
    fields: ['count'],
  },
  routing_decisions_purged: {
    description: 'Old routing provenance rows were purged.',
    fields: ['deleted'],
  },
  routing_filters_invalid: {
    description: 'Stored routing filters are invalid (fail closed) or from a newer version (fail open).',
    fields: ['integration_id', 'state'],
  },
  routing_provenance_failed: {
    description: 'Routing provenance rows could not be written; routing itself was unaffected.',
    fields: ['records'],
  },
  signup_refused: {
    description: 'A sign-up was refused by the sign-up control.',
    fields: ['reason'],
  },
  source_key_destroy_failed: {
    description: 'Destroying a source credential key failed; it is retried by the sweep.',
    fields: ['source_id', 'error'],
  },
  summary_jobs_unreadable: {
    description: 'Job health could not be read for the observability summary.',
    fields: ['error'],
  },
  summary_sink_health_unreadable: {
    description: 'Alert sink health could not be read for the observability summary.',
    fields: ['error'],
  },
  unmapped_provider_response: {
    description:
      'A destination replied with a response no classification maps (status only, never the body).',
    fields: [
      'delivery_id',
      'workspace_id',
      'integration_id',
      'destination_kind',
      'attempt',
      'provider_status',
      'status_class',
    ],
  },
  webhook_host_addresses_changed: {
    description:
      "A custom webhook's host now resolves to different addresses (ids only, never the host or address; ADR 0029).",
    fields: ['workspace_id', 'integration_id'],
  },
  webhook_probe_audit_capped: {
    description:
      'GitHub webhook probe denials hit the per-minute audit cap; further probes are not recorded.',
    fields: ['limit'],
  },
  workspace_purge: {
    description: 'A workspace past its deletion grace period was purged.',
    fields: ['organizationId', 'deleted', 'completed'],
  },
} as const satisfies Readonly<Record<string, LogEventSpec>>;

export type LogEvent = keyof typeof LOG_EVENTS;

/** The fields a call site may pass for `E`. */
export type LogEventField<E extends LogEvent> = (typeof LOG_EVENTS)[E]['fields'][number];

export const LOG_EVENT_NAMES: readonly LogEvent[] = Object.keys(LOG_EVENTS) as LogEvent[];
