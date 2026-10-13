# Release gates for PR #1

Current state: engineering alpha. Do not merge as production-ready.

## Required before merge
- CI typecheck and unit tests green; pin and commit a lockfile after dependency resolution.
- Add signed webhook request integration tests, invalid payload and duplicate delivery tests.
- Test D1 outbox transactions and queue retry/reconciliation under injected failures.
- Replace shared GitHub secret and repository-name-only routing with authorized per-source credentials/installation checks before public multitenancy.
- Validate Lark custom webhook signing and card schema with a real Lark group, Slack with a real channel, and Teams separately.
- Add secure authenticated destination setup and encryption at creation time.
- Confirm no secret values or webhook URLs appear in logs and failed-delivery errors.
- Configure D1 database ID, queues, secrets, and staging deploy.
- Test dead-letter and permanent-failure terminal states; don't leave exhausted deliveries as 'retrying'.
- Document rollback and migrations.

## Known limitations
The current outbox publisher can enqueue a row more than once when the Worker crashes after Queue.send and before updating D1. The queue consumer must guard already-sent deliveries before external delivery; even then, provider requests may be duplicated after timeout. At-least-once delivery is the intended contract.

Outbox reconciliation is scheduled every minute, and webhook handling also attempts prompt asynchronous dispatch via waitUntil. Scheduled reconciliation remains the recovery mechanism.

The current implementation supports GitHub to Lark/Slack only, not Teams or an interactive dashboard.
