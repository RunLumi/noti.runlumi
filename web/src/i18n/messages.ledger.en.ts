import type { PluralMessage } from './messages.en';

/**
 * Copy for the per-attempt history, duplicate disclosure, the automatic pause and "redeliver all
 * failed" (ADR 0023). A separate catalogue merged into `en`, like the noise copy. Rules as
 * everywhere: plain verbs, one claim at a time, never blame the reader, never claim more than Noti
 * knows. Noti cannot tell whether a destination showed a message twice, so it says "may".
 */
export const ledgerEn = {
  'attempts.title': 'Every attempt',
  'attempts.note':
    'One line for each time Noti tried to send this, or waited instead, oldest first. Noti keeps a short code for what the destination answered, never the answer itself.',
  'attempts.empty':
    'This delivery was made before Noti kept a line for each try, so only the summary above is available.',
  'attempts.list': 'Attempts, oldest first',
  'attempts.item': 'Attempt {number}',
  'attempts.stoppedWaiting': 'Stopped waiting',
  'attempts.waited': 'Waited, nothing sent',
  'attempts.outcome.delivered': 'Delivered',
  'attempts.outcome.accepted': 'Accepted, not confirmed',
  'attempts.outcome.retry_scheduled': 'Did not work, will retry',
  'attempts.outcome.dead_lettered': 'Did not work, stopped',
  'attempts.outcome.deferred': 'Held back',
  'attempts.statusClass.2xx': 'The destination said it worked',
  'attempts.statusClass.3xx': 'The destination redirected the request',
  'attempts.statusClass.4xx': 'The destination refused the request',
  'attempts.statusClass.5xx': 'The destination had an error',
  'attempts.statusClass.timeout': 'No answer in time',
  'attempts.statusClass.network': 'Noti could not connect',
  'attempts.statusClass.none': 'No request was made',
  'attempts.waitedTimes': {
    one: 'Waited, and then {count} more time. Nothing was sent.',
    other: 'Waited, and then {count} more times. Nothing was sent.',
  } satisfies PluralMessage,
  'attempts.reason.circuit_open_timeout':
    'Stopped waiting: the destination kept failing for more than a day. Redeliver it once the destination works.',
  'attempts.reason.destination_paced_timeout':
    'Stopped waiting: the destination kept asking Noti to slow down for more than a day. Redeliver it later.',
  'attempts.reason.claim_expired':
    'A worker stopped in the middle of sending, so this try may have reached the destination.',
  'attempts.duration': 'Took {ms} ms',
  'attempts.retryAfter': 'The destination asked Noti to wait {seconds} seconds.',
  'attempts.possibleDuplicate': 'The destination may already have received this one.',
  'attempts.code': 'Code {code}',
  'attempts.reason.circuit_open': 'Paused automatically because the destination keeps failing.',
  'attempts.reason.destination_paced': 'Waited because the destination asked Noti to slow down.',
  'attempts.reason.workspace_paused':
    'Waited because this workspace sent Discord more refused or rate-limited requests than its share allows. Nothing was sent.',
  'attempts.reason.platform_paused_timeout':
    'Stopped waiting: Noti kept Discord paused for everyone for more than a day. Redeliver it later.',
  'attempts.reason.workspace_paused_timeout':
    'Stopped waiting: this workspace stayed over its Discord request share for more than a day. Fix the failing Discord webhooks, then redeliver.',
  'attempts.reason.platform_paused':
    'Waited because Noti paused sending to this service for everyone while it recovers. Nothing was sent.',

  'delivery.detail.possibleDuplicate.title': 'This may have arrived more than once',
  'delivery.detail.possibleDuplicate.body':
    'An earlier attempt got no clear answer, so Noti tried again. The destination may have shown the message twice. Noti cannot tell, and does not promise it did not.',
  'delivery.detail.suppressed.title': 'Not sent again',
  'delivery.detail.suppressed.duplicate':
    'The source sent this event more than once. Noti kept the first and recorded this repeat instead of sending it again.',
  'delivery.detail.suppressed.claim_conflict':
    'Another worker was already sending this, so Noti did not send it a second time.',
  'delivery.detail.suppressed.provider_idempotency':
    'The destination recognised this as a message it already had.',
  'delivery.detail.suppressed.originalFailed':
    'The first delivery of this event failed. Redeliver that one: this repeat is not sent.',
  'delivery.detail.suppressed.of': 'Repeat of delivery {id}',
  'delivery.detail.suppressed.open': 'Show the first delivery',
  'delivery.detail.paused.circuit_open':
    'Paused automatically because the destination keeps failing. Noti will try again by itself. Nothing is lost, and nothing was turned off.',
  'delivery.detail.paused.destination_paced':
    'Waiting because the destination asked Noti to slow down. Noti sends it as soon as that time has passed.',

  'delivery.detail.paused.platform_paused':
    'Waiting because Noti paused sending to this service for all workspaces for a short while. Noti sends it by itself afterwards. Nothing is lost, and nothing was turned off.',

  'delivery.detail.paused.workspace_paused':
    'Waiting because this workspace sent Discord too many refused or rate-limited requests. Noti slowed this workspace down to protect everyone else, and retries by itself. Check that your Discord webhooks still exist.',

  'health.open.title': 'Paused automatically',
  'health.open.body':
    'This destination failed several times in a row, so Noti stopped sending for a while instead of hammering it. Nothing is lost: deliveries wait, and Noti tries again {time}. Noti never turns an integration off by itself.',
  'health.halfOpen.title': 'Checking the destination',
  'health.halfOpen.body':
    'Noti is sending one message to see whether {destination} is back. The rest wait for the result.',
  'health.paced.title': 'Slowed down by the destination',
  'health.paced.body': '{destination} asked Noti to slow down. Deliveries wait until {time}, then carry on.',
  'health.waiting': 'See the deliveries that are waiting',

  'bulk.button': 'Redeliver all failed',
  'bulk.buttonFor': 'Redeliver all failed for {name}',
  'bulk.title': 'Send failed deliveries again',
  'bulk.loading': 'Counting failed deliveries…',
  'bulk.none':
    'There are no failed deliveries to send again for this selection. Deliveries whose integration is paused or deleted, or whose original message has been removed, are not counted.',
  'bulk.preview': {
    one: '{count} failed delivery will be sent again as a new delivery.',
    other: '{count} failed deliveries will be sent again as new deliveries.',
  } satisfies PluralMessage,
  'bulk.scope.integration': 'For {name}.',
  'bulk.scope.all': 'For every integration in this workspace that matches the filters above.',
  'bulk.more': {
    one: '{count} more is waiting. Noti sends at most {bound} at a time: run this again for the rest.',
    other: '{count} more are waiting. Noti sends at most {bound} at a time: run this again for the rest.',
  } satisfies PluralMessage,
  'bulk.moreMany': 'There are many more. Noti sends at most {bound} at a time: run this again for the rest.',
  'bulk.warning':
    'The failed ones stay in the log. The destination may receive a message more than once. If the cause is not fixed yet, they will fail again.',
  'bulk.typed.label': 'Type {count} to confirm',
  'bulk.typed.hint': 'This sends many messages, so Noti asks you to type the number.',
  'bulk.confirm': 'Send them again',
  'bulk.cancel': 'Cancel',
  'bulk.sending': 'Sending…',
  'bulk.done': {
    one: 'Queued {count} new delivery. It appears in the log as soon as Noti sends it.',
    other: 'Queued {count} new deliveries. They appear in the log as soon as Noti sends them.',
  } satisfies PluralMessage,
  'bulk.done.already': {
    one: '{count} had already been sent again earlier.',
    other: '{count} had already been sent again earlier.',
  } satisfies PluralMessage,
  'bulk.done.refused': {
    one: '{count} could not be sent again: its integration changed or the original is gone.',
    other: '{count} could not be sent again: their integration changed or the originals are gone.',
  } satisfies PluralMessage,
  'bulk.done.more': {
    one: '{count} more is waiting for another round.',
    other: '{count} more are waiting for another round.',
  } satisfies PluralMessage,
  'bulk.stale': 'The list changed since you looked, so nothing was sent. Check the new count and try again.',
  'bulk.recount': 'Count again',
} as const;
