/**
 * Copy for "Send a test notification" and the setup-progress card (ADR 0018). A separate
 * catalogue merged into `en`, like the noise copy. Rules as everywhere: say what happened and
 * what to do next, never blame the reader, and never claim more than Noti saw. In particular
 * "sent" means the destination confirmed it, and "accepted" means it did not say either way.
 */
export const setupEn = {
  // --- Send a test notification -----------------------------------------------
  'test.title': 'Send a test notification',
  'test.hint':
    'Noti sends a short message marked as a test through this integration, the same way it sends real updates, and tells you what {destination} answered.',
  'test.button': 'Send a test notification',
  'test.buttonAgain': 'Send another test',
  'test.buttonShort': 'Send test',
  'test.buttonFor': 'Send a test notification for {name}',
  'test.sending': 'Sending the test…',
  'test.waiting': 'Waiting for {destination} to answer…',
  'test.resultLabel': 'Test result',

  'test.sent.title': 'Test sent',
  'test.sent.body': '{destination} confirmed it received the message.',
  'test.accepted.title': 'Test accepted, not confirmed',
  'test.accepted.body':
    '{destination} accepted the message but does not tell Noti whether it was shown. It usually appears within a minute.',
  'test.accepted.teams':
    'Microsoft Teams accepts messages from a workflow without confirming that they were posted, so Noti cannot know that it appeared. Open the chat or channel your workflow posts to. If nothing shows up within a minute, open the workflow’s run history in Power Automate.',
  'test.failed.title': 'The test did not go through',
  'test.failed.fix': 'Replace the webhook URL',
  'test.retrying.title': 'The first try did not work',
  'test.retrying.body':
    'Noti is trying again by itself. Open Activity in a minute to see how it ended; nothing more is needed from you.',
  'test.timeout.title': 'Still waiting for an answer',
  'test.timeout.body':
    'This is taking longer than usual. The test is not lost: its result will appear in Activity.',
  'test.viewActivity': 'See it in Activity',

  'test.where.title': 'Where to look',
  'test.where.lark': 'Look in the Lark group where you added the custom bot.',
  'test.where.slack': 'Look in the Slack channel you chose when you created the webhook.',
  'test.where.teams': 'Look in the Teams chat or channel your workflow posts to.',
  'test.where.discord': 'Look in the Discord channel you created the webhook for.',
  'test.where.generic_webhook':
    'Look at your own endpoint’s logs. Noti signed the request with your signing secret.',

  'test.blocked.paused': 'This integration is paused. Turn it on first, then send a test.',
  'test.blocked.quarantined':
    'Noti stopped using this integration’s saved webhook URL. Paste the URL again in the credentials section, then send a test.',
  'test.error.unavailable':
    'This integration can’t receive a test right now. If the workspace is scheduled for deletion, cancel that in Settings first. Otherwise reload the page and try again.',
  'test.error.inFlight':
    'A test is already running for this integration. Wait for its result, then send another.',
  'test.error.rateLimited': 'You have sent a lot of tests. Wait {seconds} seconds, then try again.',

  'delivery.testBadge': 'Test',

  // --- Create wizard: the optional last step ---------------------------------
  'wizard.step.test': 'Test it (optional)',
  'wizard.test.title': '“{name}” is saved',
  'wizard.test.intro':
    'You can send a test message now to check that {destination} receives it. This step is optional, and you can do it later from the integration’s settings.',
  'wizard.test.skip': 'Skip for now',
  'wizard.test.done': 'Go to the integration',

  // --- Setup progress (Overview) ---------------------------------------------
  'setup.title': 'Finish setting up',
  'setup.summary': '{done} of {total} steps done',
  'setup.honest': 'Noti works this out from what has actually happened in your workspace.',
  'setup.listLabel': 'Setup steps',
  'setup.since': 'Since {when}',
  'setup.action.send_test': 'Send a test',
  'setup.action.trigger_real_event': 'Open Activity',
} as const;
