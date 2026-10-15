# Log event catalogue

Every line the Worker writes is one JSON object from `log()` in `src/platform/log.ts`
(spec 13 F194/F195, [ADR 0051](adr/0051-log-catalogue-and-redaction-site.md)). This page lists every
event that can appear as `msg`. The table is generated from `src/platform/log-events.ts`, and
`tests/docs/logs-doc.test.ts` fails when the two differ. Do not edit the table by hand: change the
catalogue and run `npm run docs:logs`.

## Shape of a line

- `ts` (ISO 8601), `level` (`info`, `warn` or `error`) and `msg` (an event below) are always present.
  A field can never overwrite them.
- Inside a request or a queue message, `log()` adds `correlation_id`, and when known
  `external_request_id` and `cf_ray` (ADR 0011). They are not listed per event below.
- The remaining keys are the event's declared fields. A call site that passes an undeclared field, or an
  event name that is not catalogued, does not compile.
- The whole object passes through `redact()` once before it is written: denylisted keys read
  `[redacted]`, URLs keep scheme and host only, and token-shaped text is replaced (spec 01 F12). So a
  field documented here can still read `[redacted]` or carry a scrubbed value.
- If `redact()` cannot produce an object, the line keeps `ts`, `level` and `msg` and says
  `redaction_failed: true`; the fields are dropped, the line is not.

## Size budget

A line is at most 4096 bytes of UTF-8 (`LOG_LINE_BUDGET_BYTES`). Cloudflare keeps at most 256 KB of
logs, exceptions and metadata per invocation and then records nothing more for it
([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)); the delivery consumer
handles up to 5 messages a batch with a few lines each, so a whole batch fits well inside that.

An oversized line is never cut mid-JSON. String values are shortened first (to 256, then 64, then 16
characters, never inside a `[redacted]` or other marker) and the line carries `log_truncated: "values"`.
If that is still too large, every field is dropped except `ts`, `level`, `msg` and the correlation keys,
and the line carries `log_truncated: "fields_dropped"` with `dropped_fields: <n>`. Nothing counts
truncated lines per invocation yet.

## Adding an event

1. Add the entry to `src/platform/log-events.ts` (keep the keys sorted): a one-line description and every
   field the call site passes. A field name the redactor denies (`url`, `token`, `auth`, `secret`, …)
   is refused by `tests/platform/log-events.test.ts`, because it would always read `[redacted]`.
2. Call `log(level, 'your_event', { ...fields })`. `console` is not available: ESLint `no-console` is an
   error everywhere in `src/` except `src/platform/log.ts`, and
   `tests/security/log-redaction-site.test.ts` checks the same from the source.
3. Run `npm run docs:logs` and commit this file.

Event names are the existing snake_case names. Spec 13 F194 sketches dotted names
(`delivery.attempt`); renaming would break saved log searches and the runbook, so it is not done here.

## Events

<!-- BEGIN GENERATED: log-events -->

| Event (`msg`) | What happened | Fields |
| --- | --- | --- |
| `account_deletion_notice_failed` | The account-deletion notice mail could not be sent; the deletion continues. | `error` |
| `account_erase_failed` | Erasing an account failed and nothing was deleted; the user is told to retry. | `error` |
| `alert_firing` | An operator alert started firing (log sink of the alert engine). | `alert`, `severity`, `value`, `threshold`, `incident`, `firing_for_ms`, `runbook` |
| `alert_notice_dropped` | An alert notice failed to reach its sinks too many times and was given up. | `alert`, `kind`, `failures` |
| `alert_renotify` | A still-firing alert was re-notified after its re-notify interval. | `alert`, `severity`, `value`, `threshold`, `incident`, `firing_for_ms`, `runbook` |
| `alert_resolved` | A firing alert recovered. | `alert`, `severity`, `value`, `threshold`, `incident`, `firing_for_ms`, `runbook` |
| `alert_signal_unreadable` | An alert signal could not be read from D1; that alert is not evaluated this tick. | `signal`, `error` |
| `alert_sink_failed` | An alert sink (log or chat webhook) failed or ran out of time budget. | `sink`, `alert`, `reason`, `error_class` |
| `alert_sink_health_write_failed` | The alert sink health row could not be written. | `error` |
| `alert_state_write_failed` | An alert state transition could not be persisted. | `alert`, `error` |
| `alert_webhook_unusable` | The configured operator alert webhook is unusable, so chat alert notices are off. | none |
| `audit_note_failed` | A Better Auth hook could not record its audit row. | `action` |
| `audit_read_failed` | An audit log read failed; carries a closed category code only. | `code` |
| `audit_total_unavailable` | The audit log total count query failed; the page is served without a total. | none |
| `audit_write_failed` | An audit row could not be written; the failure is noted for /health/ready. | `action` |
| `background_task_failed` | A waitUntil background task rejected; the request was already answered. | `task`, `error` |
| `bulk_replay_audit_incomplete` | A bulk replay ran but its audit record could not be completed. | `replayed`, `error` |
| `bulk_replay_not_started` | A bulk replay could not start; nothing was sent. | `error` |
| `canonical_event_invalid` | A verified source event failed canonical-envelope validation and was dropped. | `source`, `source_id`, `kind`, `fields` |
| `config_invalid` | Required configuration is missing or invalid; requests answer 503 and jobs stop. | `misconfigured`, `code` |
| `config_unknown_keys` | The Worker has bindings the config schema does not know. | `unknown_bindings` |
| `correlation_missing` | A queued delivery carried no correlation id; a fresh one is used. | `delivery_id`, `workspace_id` |
| `credential_destroy_sweep_failed` | The scheduled credential-destruction sweep failed. | `error` |
| `credential_maintenance` | Summary of one credential maintenance run (migrate, rewrap, destroy, backfill). | `migrated`, `rewrapped`, `sourcesRewrapped`, `destroyed`, `backfilled`, `remaining` |
| `cron_job_failed` | One scheduled job threw; the other jobs in the tick still ran. | `job`, `error` |
| `d1_write_retry` | A D1 write failed with a retryable class and will be retried with backoff. | `label`, `attempt`, `class` |
| `d1_write_shed` | D1 shed a write (overloaded); it is not retried here. | `label` |
| `dead_letter_consumer_failed` | The dead-letter queue consumer failed on a message; the message is retried. | `delivery_id`, `error` |
| `dead_letter_run_record_failed` | The dead-letter consumer could not record its job run. | `error` |
| `dedup_purged` | Expired event dedup rows were purged. | `purged`, `more` |
| `delivery_attempt` | One delivery attempt finished (warn when it dead-lettered). | `delivery_id`, `workspace_id`, `integration_id`, `attempt`, `outcome`, `error_code`, `unmapped_provider_error`, `status_class`, `probe` |
| `delivery_attempt_failed` | A delivery attempt threw inside the consumer; recorded as internal_error. | `delivery_id`, `error` |
| `delivery_consumer_failed` | Handling a delivery queue message threw; the message is retried. | `error` |
| `delivery_dead_lettered_by_queue` | The queue dead-lettered a delivery message after its retries. | `delivery_id`, `workspace_id`, `outcome` |
| `delivery_deferral_timeout` | A delivery waited too long behind an open circuit or rate limit and was failed. | `delivery_id`, `workspace_id`, `integration_id`, `reason`, `recorded` |
| `delivery_deferred` | A delivery was deferred by an open circuit or a destination rate limit. | `delivery_id`, `workspace_id`, `integration_id`, `reason`, `recorded` |
| `delivery_message_unparseable` | A delivery queue message did not parse and was acknowledged without work. | none |
| `delivery_not_found` | A delivery queue message named a delivery that no longer exists. | `delivery_id`, `workspace_id` |
| `delivery_stall` | Deliveries are stalled (old outbox rows, stale claims or overdue retries). | `outbox_pending_over_threshold`, `claimed_stale`, `retry_overdue`, `firing_for_ms`, `renotify` |
| `delivery_stall_recovered` | A delivery stall cleared. | `firing_for_ms` |
| `destination_health_unreadable` | Destination health could not be read; the attempt proceeds without the gate. | `delivery_id`, `error` |
| `discord_auto_pause_failed` | Pausing a Discord destination after a permanent failure did not persist. | `delivery_id`, `error` |
| `egress_guard_opened` | The platform-wide Discord guard opened: every Discord request is held until it closes (ADR 0029). | `provider`, `invalid_in_window`, `trip` |
| `egress_guard_record_failed` | A Discord egress count could not be recorded; the delivery outcome is unchanged and the fault is counted (ADR 0029). | `provider`, `error` |
| `egress_guard_unreadable` | The Discord guard could not read its counters and failed open; the fault is counted for egress_guard_failing (ADR 0029). | `provider`, `error` |
| `expired_auth_records_purged` | Expired sessions, tokens, invitations, install states and auth limits were purged. | `skipped`, `sessions`, `overAgeSessions`, `verifications`, `invitations`, `installStates`, `rateLimitRows`, `more`, `aborted` |
| `expired_purge_aborted` | The expired-records purge saw an anomaly and deleted nothing. | `table`, `reason`, `total`, `expired` |
| `fingerprint_backfill_failed` | Backfilling one credential fingerprint failed; it is retried on the next sweep. | `integration_id`, `source_id`, `error` |
| `fingerprint_backfill_sweep_failed` | The scheduled fingerprint backfill sweep failed. | `error` |
| `generic_source_secret_unavailable` | A generic webhook source secret could not be opened; the sender gets a 500. | `source_id`, `code` |
| `generic_source_touch_failed` | Updating a generic source last-received time failed (display only). | `source_id` |
| `generic_webhook_id_reused` | A generic webhook reused a message id with a different body and was refused. | `source_id` |
| `github_callback_failed` | The GitHub App verification callback failed unexpectedly; the user returns to the dashboard. | none |
| `github_event_too_large` | A GitHub webhook body exceeded the size limit and was refused. | `reason`, `limit_bytes` |
| `github_lifecycle_failed` | A GitHub installation lifecycle event could not be applied; GitHub sees a 500. | `kind` |
| `github_setup_failed` | The GitHub App setup redirect failed unexpectedly; the user returns to the dashboard. | none |
| `ingress_usage_write_failed` | The per-workspace ingress usage counter could not be written. | `source` |
| `integration_key_destroy_failed` | Destroying an integration credential key failed; it is retried by the sweep. | `integration_id`, `error` |
| `integration_old_wipe_failed` | Wiping kept originals of destroyed integration credentials failed. | `error` |
| `job_runs_write_failed` | Job run records could not be written. | `rows`, `error` |
| `legacy_key_malformed_migration_skipped` | ENCRYPTION_KEY is set but malformed, so the legacy credential migration was skipped. | none |
| `maintenance_marker_failed` | The maintenance-mode marker could not be written. | `error` |
| `maintenance_mode_cron_skipped` | Maintenance mode is on, so the scheduled jobs were skipped. | none |
| `maintenance_mode_prolonged` | Maintenance mode has been on for longer than expected. | `hours`, `since` |
| `noise_hold_capacity` | An integration reached its held-event capacity; the event is delivered now instead. | `integration_id` |
| `noise_purged` | Old held-event and open-failure noise rows were purged. | `held`, `openFailures`, `failed` |
| `noise_release` | Held events were released as grouped notifications. | `units`, `notifications`, `events`, `reclaimed` |
| `noise_release_failed` | Releasing one held group failed; it is retried on the next tick. | `integration_id`, `delivery_id`, `error` |
| `noise_settings_unusable` | Stored noise settings are invalid or from a newer version; events are not held. | `integration_id`, `state` |
| `outbox_dispatch_incomplete` | An outbox dispatch pass released claims or found invalid rows. | `workspaces`, `dispatched`, `reclaimed`, `lostRace`, `released`, `invalid` |
| `outbox_reconcile` | Summary of one outbox reconcile run (sweep stale claims, dispatch, purge). | `workspaces`, `dispatched`, `reclaimed`, `lostRace`, `released`, `invalid`, `released_claims`, `purged` |
| `outbox_send_failed` | Sending an outbox row to the delivery queue failed; the claim is released. | `delivery_id`, `workspace_id`, `error` |
| `password_changed_notice_failed` | The password-changed notice mail could not be sent; the reset still completes. | `error` |
| `probe_audit_capped` | Workspace probe denials hit the per-minute audit cap; further probes are not recorded. | `limit` |
| `provider_event_rejected` | A verified provider event was rejected by its connector mapping. | `source_id`, `kind`, `reason` |
| `provider_integration_event_types_unreadable` | An integration event-type selection is unreadable; it receives nothing. | `integration_id`, `kind` |
| `provider_source_flood_dropped` | A provider source exceeded its rate limit and the event was absorbed (dropped). | `source_id`, `kind` |
| `provider_source_secret_unavailable` | A provider source secret could not be opened; the sender gets a 500. | `source_id`, `kind`, `code` |
| `provider_source_touch_failed` | Updating a provider source last-received time failed (display only). | `source_id`, `kind` |
| `rate_limit_error` | The GitHub ingress rate limiter failed; the event is accepted without it (fail open). | `scope` |
| `ready_d1_failed` | The readiness probe could not reach D1. | none |
| `retention_config_invalid` | A retention variable is invalid and its default is used (variable name only). | `var` |
| `retention_purge` | Summary of one retention purge pass. | `skipped`, `deliveries`, `attempts`, `outbox`, `audit`, `jobRuns`, `ingressUsage`, `more` |
| `revoked_secret_awaiting_fingerprint` | Revoked secrets cannot be destroyed until their fingerprint is backfilled. | `count` |
| `routing_decisions_purged` | Old routing provenance rows were purged. | `deleted` |
| `routing_filters_invalid` | Stored routing filters are invalid (fail closed) or from a newer version (fail open). | `integration_id`, `state` |
| `routing_provenance_failed` | Routing provenance rows could not be written; routing itself was unaffected. | `records` |
| `signup_refused` | A sign-up was refused by the sign-up control. | `reason` |
| `source_key_destroy_failed` | Destroying a source credential key failed; it is retried by the sweep. | `source_id`, `error` |
| `summary_jobs_unreadable` | Job health could not be read for the observability summary. | `error` |
| `summary_sink_health_unreadable` | Alert sink health could not be read for the observability summary. | `error` |
| `unmapped_provider_response` | A destination replied with a response no classification maps (status only, never the body). | `delivery_id`, `workspace_id`, `integration_id`, `destination_kind`, `attempt`, `provider_status`, `status_class` |
| `webhook_host_addresses_changed` | A custom webhook's host now resolves to different addresses (ids only, never the host or address; ADR 0029). | `workspace_id`, `integration_id` |
| `webhook_probe_audit_capped` | GitHub webhook probe denials hit the per-minute audit cap; further probes are not recorded. | `limit` |
| `workspace_purge` | A workspace past its deletion grace period was purged. | `organizationId`, `deleted`, `completed` |

<!-- END GENERATED: log-events -->
