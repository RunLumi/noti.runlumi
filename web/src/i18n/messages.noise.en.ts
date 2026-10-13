import type { PluralMessage } from './messages.en';

/**
 * Copy for quiet hours, grouping, summaries and resolved notices (ADR 0016). A separate
 * catalogue merged into `en`, like the filters copy. Rules as everywhere: plain verbs, one claim
 * at a time, never blame the reader, never claim more than Noti does. "Saved" is used for an
 * update that is waiting to be sent, because the filters copy already uses "held back" for an
 * update that is NOT sent.
 */
export const noiseEn = {
  'noise.title': 'Quiet hours and summaries',
  'noise.intro':
    'Calm a busy chat without missing anything. Updates are never dropped: they are saved and sent together later.',
  'noise.honest':
    'For each saved update Noti keeps only a short title, a link and a summary line, not the event itself, and removes it a few days after it is sent.',

  'noise.quiet.title': 'Quiet hours',
  'noise.quiet.hint': 'Save non-urgent updates overnight and send them together when quiet hours end.',
  'noise.quiet.enable': 'Save updates during quiet hours',
  'noise.quiet.start': 'Quiet hours start',
  'noise.quiet.end': 'Quiet hours end',
  'noise.timezone': 'Time zone',
  'noise.timezone.hint': 'All times use this zone, including daylight-saving changes.',

  'noise.group.title': 'Combine bursts',
  'noise.group.hint':
    'Wait this long before sending, so several updates about the same pull request, issue or branch arrive as one message with a count.',
  'noise.group.label': 'Combine updates for',
  'noise.group.w0': 'Off: send each update',
  'noise.group.w60': '1 minute',
  'noise.group.w300': '5 minutes',
  'noise.group.w900': '15 minutes',
  'noise.group.w3600': '1 hour',

  'noise.digest.title': 'Summaries',
  'noise.digest.hint': 'Save non-urgent updates and send them as one summary on a schedule.',
  'noise.digest.label': 'Send non-urgent updates',
  'noise.digest.off': 'Right away',
  'noise.digest.hourly': 'As a summary every hour',
  'noise.digest.daily': 'As a summary once a day',
  'noise.digest.at': 'Daily summary time',

  'noise.resolution.title': 'Resolved notices',
  'noise.resolution.label': 'Tell me when a failing workflow passes again',
  'noise.resolution.hint':
    'Sends a short “Resolved” message when a workflow that failed on a branch succeeds on the same branch.',
  'noise.resolution.needsFailures':
    'Choose “workflow run failed” or “timed out” among this integration’s updates to use this.',

  'noise.preview.title': 'What this will do',
  'noise.preview.none': 'Every update is sent right away.',
  'noise.preview.quiet': 'During quiet hours Noti will hold updates and send one summary at {time}.',
  'noise.preview.urgent':
    'Failures and other urgent updates are always sent right away, even during quiet hours.',
  'noise.preview.group':
    'Updates about the same thing that arrive within {window} are sent as one message with a count.',
  'noise.preview.digestHourly': 'Non-urgent updates are saved and sent as one summary every hour.',
  'noise.preview.digestDaily': 'Non-urgent updates are saved and sent as one summary every day at {time}.',
  'noise.preview.resolution': 'When a failing workflow passes again, Noti sends a “Resolved” message.',

  'noise.status.title': 'Waiting to be sent',
  'noise.status.loading': 'Checking what is waiting…',
  'noise.status.none': 'Nothing is waiting right now.',
  'noise.status.waiting': {
    one: '{count} update is waiting. Next send: {when}.',
    other: '{count} updates are waiting. Next send: {when}.',
  } satisfies PluralMessage,
  'noise.status.error': 'We couldn’t check what is waiting. Nothing is lost.',

  'noise.invalid.title': 'The saved settings could not be read',
  'noise.invalid.body': 'Updates are being sent normally. Saving new settings replaces the unreadable ones.',
  'noise.newer.title': 'Saved by a newer version of Noti',
  'noise.newer.body':
    'This version ignores those settings and sends updates normally. Saving here replaces them.',

  'noise.save': 'Save settings',
  'noise.saving': 'Saving…',
  'noise.saved': 'Settings saved.',
  'noise.clear': 'Turn everything off',
  'noise.unsaved': 'Unsaved changes',

  'noise.error.time': 'Use a time like 22:00.',
  'noise.error.sameTime': 'Start and end must be different times.',
  'noise.error.timezone': 'Choose a time zone from the list.',
  'noise.error.resolution':
    'Choose “workflow run failed” or “timed out” among this integration’s updates first.',
  'noise.error.generic': 'These settings could not be saved. Check the highlighted fields.',

  'noise.log.held': 'Saved for later',
  'noise.log.quiet_hours': 'Saved during quiet hours and sent in a summary.',
  'noise.log.digest': 'Saved for the next summary.',
  'noise.log.grouped': 'Combined with similar updates into one message.',
  'noise.log.critical_bypass': 'Urgent: sent right away, ignoring quiet hours, summaries and combining.',
  'noise.log.hold_capacity': 'Sent right away because too many updates were already waiting.',
} as const satisfies Record<string, string | PluralMessage>;
