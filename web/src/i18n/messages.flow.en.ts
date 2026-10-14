/**
 * Copy for the `/setup` flow, the shell's 404 and breadcrumbs, destination abilities, the
 * four-part error panel, and the integration repair and health sections (ADR 0025). Rules as
 * everywhere: say what happened and what to do next, never blame the reader, never claim more
 * than Noti saw. `error-copy.test.ts` rejects filler such as "Something went wrong".
 */
export const flowEn = {
  // --- Shell ------------------------------------------------------------------
  'shell.breadcrumbs': 'Breadcrumb',
  'route.title.setup': 'Setup',
  'nav.failed': { one: '{count} failed delivery', other: '{count} failed deliveries' },
  'notFound.title': 'We can’t find that page',
  'notFound.body':
    'The address may have a typo, or the page may have moved. Nothing was lost. Use the menu, or go back to the Overview.',
  'notFound.home': 'Go to the Overview',

  // --- Four-part errors: what happened (screen), why, what to do, how to get help ---
  'errorpanel.what.generic': 'Noti couldn’t finish that.',
  'errorpanel.what.integration': 'We couldn’t load this integration.',
  'errorpanel.what.setup': 'We couldn’t load your setup progress.',
  'errorpanel.what.history': 'We couldn’t load this integration’s deliveries.',
  'errorpanel.why.network': 'Your device could not reach Noti.',
  'errorpanel.why.session': 'Your sign-in has expired.',
  'errorpanel.why.forbidden': 'Your role in this workspace does not allow this.',
  'errorpanel.why.blocked': 'A security check stopped the request before it was handled.',
  'errorpanel.why.notFound': 'What you asked for no longer exists, or it belongs to another workspace.',
  'errorpanel.why.quota': 'This workspace is at a limit.',
  'errorpanel.why.rateLimited': 'Too many requests were sent in a short time.',
  'errorpanel.why.tooLarge': 'The request was larger than Noti accepts.',
  'errorpanel.why.validation': 'Some of what was entered could not be accepted.',
  'errorpanel.why.server': 'Noti hit a problem on its own side. Nothing you entered caused it.',
  'errorpanel.do.network': 'Check your connection, then try again.',
  'errorpanel.do.session': 'Sign in again. Your work on this page is not saved yet.',
  'errorpanel.do.forbidden': 'Ask a workspace admin to make the change or to change your role.',
  'errorpanel.do.blocked': 'Reload the page, then try again.',
  'errorpanel.do.notFound': 'Go back to the list and pick something that is still there.',
  'errorpanel.do.quota': 'Remove something you no longer use, then try again.',
  'errorpanel.do.rateLimited': 'Wait a minute, then try again.',
  'errorpanel.do.rateLimitedFor': 'Wait {seconds} seconds, then try again.',
  'errorpanel.do.tooLarge': 'Shorten the longest field, then try again.',
  'errorpanel.do.validation': 'Check the highlighted fields, then try again.',
  'errorpanel.do.server': 'Try again in a minute. Anything already saved is safe.',
  'errorpanel.help': 'Still stuck? Tell your workspace admin what you were doing and quote this reference.',
  'errorpanel.reference': 'Reference: HTTP {status}',
  'errorpanel.reference.none': 'Reference: the request did not reach Noti',

  // --- Setup: steps and states ------------------------------------------------
  'setup.optional': 'Optional',
  'setup.state.todo': 'To do',
  'setup.state.doing': 'Next',
  'setup.state.done': 'Done',
  'setup.state.blocked': 'Blocked',
  'setup.state.skipped': 'Skipped',
  'setup.blocked.because': 'Blocked because:',
  'setup.step.workspace_created': 'Create your workspace',
  'setup.step.workspace_created.body': 'Your workspace exists.',
  'setup.step.github_connected': 'Connect GitHub',
  'setup.step.github_connected.body':
    'Noti is installed on a GitHub account, so it can see its repositories.',
  'setup.step.repositories_selected': 'Choose a repository',
  'setup.step.repositories_selected.body': 'An integration names the repository whose updates you want.',
  'setup.step.destination_connected': 'Choose where messages go',
  'setup.step.destination_connected.body': 'A chat or endpoint is saved for the integration.',
  'setup.step.events_chosen': 'Choose what to send',
  'setup.step.events_chosen.body':
    'The updates sent are set. Until you change them, Noti sends failed builds only.',
  'setup.step.test_delivered': 'Send a test',
  'setup.step.test_delivered.body':
    'A test or a real message reached the destination in the last {days} days.',
  'setup.step.test_delivered.accepted':
    'The destination accepted a message but does not confirm it was shown (Microsoft Teams works this way). Look in the chat to be sure.',
  'setup.step.activated': 'See a real event',
  'setup.step.activated.body':
    'Something that happened in your source created a notification. Tests do not count.',
  'setup.action.connect_github': 'Connect GitHub',
  'setup.action.pick_repository': 'Choose a repository',
  'setup.action.choose_destination': 'Choose where messages go',
  'setup.action.refine_events': 'Choose what to send',
  'setup.action.repair_integration': 'Fix the webhook URL',
  'setup.action.resume_integration': 'Turn the integration back on',
  'setup.complete.title': 'Setup is complete',
  'setup.complete.body':
    'Your connection works. Noti has not yet seen a real event, only your test. The first one will appear in Activity.',
  'setup.complete.view': 'See what is live',

  'setup.blocked.githubApp.title': 'GitHub can’t be connected on this server yet',
  'setup.blocked.githubApp.body':
    'This Noti server has no GitHub App configured. That is a server setting, not something in your account, and only whoever runs the server can change it. Tell them, or send events from a signed webhook source instead.',
  'setup.blocked.githubFirst.title': 'Connect GitHub first',
  'setup.blocked.githubFirst.body':
    'Noti can only offer repositories once GitHub is connected, and GitHub can’t be connected yet.',
  'setup.blocked.quarantined.title': 'The saved webhook URL is not being used',
  'setup.blocked.quarantined.body':
    'Noti stopped using the saved webhook URL because it failed an integrity check. Paste the URL again to continue.',
  'setup.blocked.paused.title': 'This integration is paused',
  'setup.blocked.paused.body':
    'A paused integration sends nothing, so a test would not go out. Turn it on first.',

  // --- Setup: the flow --------------------------------------------------------
  'setup.flow.eyebrow': 'SETUP',
  'setup.flow.progress': 'Setup steps',
  'setup.flow.loading': 'Loading your setup progress…',
  'setup.flow.later': 'Finish later',
  'setup.flow.continue': 'Continue',
  'setup.flow.skip': 'Skip for now',
  'setup.flow.leaveConfirm':
    'Leave setup? What you typed on this step will be lost. Steps already saved are kept.',
  'setup.page.github': 'Connect GitHub',
  'setup.page.repository': 'Choose a repository',
  'setup.page.destination': 'Choose where messages go',
  'setup.page.events': 'Choose what to send',
  'setup.page.test': 'Send a test',
  'setup.page.done': 'All set',
  'setup.flow.desc.github':
    'Let Noti see the repositories you want updates from. You can disconnect it on GitHub at any time.',
  'setup.flow.desc.repository': 'Pick the repository whose updates should reach your team.',
  'setup.flow.desc.destination': 'Choose a chat and paste the webhook address you created there.',
  'setup.flow.desc.events': 'Optional. Noti starts with failed builds only; change that if you like.',
  'setup.flow.desc.test': 'Send one message through the integration and see what the destination answers.',
  'setup.flow.desc.done': 'What is live now, and what has not happened yet.',
  'setup.flow.prereq.title': 'This step comes after another one',
  'setup.flow.prereq.body': 'Finish the earlier step first, then come back here.',
  'setup.flow.prereq.go.github': 'Go to Connect GitHub',
  'setup.flow.prereq.go.repository': 'Go to Choose a repository',
  'setup.flow.prereq.go.destination': 'Go to Choose where messages go',
  'setup.flow.prereq.go.events': 'Go to Choose what to send',
  'setup.flow.prereq.go.test': 'Go to Send a test',
  'setup.flow.prereq.go.done': 'Go to All set',

  'setup.flow.github.title': 'Connect your GitHub account',
  'setup.flow.github.body':
    'GitHub will ask which account and which repositories Noti may see. Noti only reads repository events; it never changes your code.',
  'setup.flow.github.connected': 'Connected GitHub accounts',
  'setup.flow.github.wrong.title': 'Connected the wrong account?',
  'setup.flow.github.wrong.body':
    'Connect another account. Accounts already connected stay until you uninstall Noti from them on GitHub.',
  'setup.flow.github.skipped':
    'You are using a different source, so GitHub is not needed. You can still connect it later.',
  'setup.flow.github.useSource': 'Use a signed webhook source instead',
  'setup.flow.github.next': 'Next: choose a repository',
  'setup.flow.repository.created': 'A repository is already chosen for this workspace’s integration.',
  'setup.flow.repository.none':
    'No active GitHub connection covers any repository yet. Connect GitHub again to choose one.',
  'setup.flow.destination.repo': 'Repository: {repo}',
  'setup.flow.destination.save': 'Save integration',
  'setup.flow.destination.created': '“{name}” sends to {destination}.',
  'setup.flow.destination.createdPlain': 'The integration is saved.',
  'setup.flow.events.intro':
    'Failed builds are sent unless you pick something else. Press Continue to keep them, or choose other updates.',
  'setup.flow.events.more': 'Filters, quiet hours and summaries are in the integration’s settings.',
  'setup.flow.events.moreLink': 'Open the filters',
  'setup.flow.events.keep': 'Keep these and continue',
  'setup.flow.events.save': 'Save and continue',
  'setup.flow.events.saving': 'Saving…',
  'setup.flow.events.source':
    'This integration sends everything from its source, so there is nothing to choose here.',
  'setup.flow.test.intro': 'A test message is marked as a test and goes through the same path as real ones.',
  'setup.flow.test.confirmed': 'Verified: the destination confirmed it received a message.',
  'setup.flow.test.accepted':
    'The destination accepted a message but does not confirm it was shown. Look in the chat to be sure.',
  'setup.flow.done.title': 'You’re set up',
  'setup.flow.done.live': 'Updates from {source} now go to {destination}.',
  'setup.flow.done.accepted':
    'Your destination accepts messages without confirming them, so check the chat once.',
  'setup.flow.done.realYes': 'A real event has already come through.',
  'setup.flow.done.realNo':
    'No real event has come through yet. Tests don’t count. The first one will appear in Activity.',
  'setup.flow.done.activity': 'Open Activity',
  'setup.flow.done.manage': 'Manage this integration',
  'setup.flow.done.another': 'Add another destination',
  'setup.flow.done.unfinished.title': 'Setup isn’t finished yet',
  'setup.flow.done.unfinished.body': 'Something earlier still needs doing. Continue where you left off.',

  // --- What a destination can show -------------------------------------------
  'ability.title': 'What {destination} can show',
  'ability.included': 'Included',
  'ability.limit': 'Limitation',
  'ability.card': 'A formatted card with a title and the key details.',
  'ability.json': 'A structured JSON message sent to your own endpoint.',
  'ability.links': 'A link back to the pull request, issue or workflow run.',
  'ability.plain': 'Plain text if the card can’t be shown.',
  'ability.confirmed': 'Noti is told when the message was received.',
  'ability.accepted': '{destination} accepts the message but does not tell Noti it was shown.',
  'ability.signed': 'Each request is signed, so you can check it came from Noti.',
  'ability.noMentions': 'Noti does not @mention people, so a message never pings anyone.',
  'ability.redacts': '{destination} hides phone numbers and personal emails in messages.',

  // --- GitHub: repository picker and accounts ---------------------------------
  'github.connectAnother': 'Connect another account',
  'repo.search': 'Search repositories',
  'repo.search.hint': 'Type part of a name to shorten the list below.',
  'repo.search.count': {
    one: '{count} repository matches',
    other: '{count} repositories match',
  },
  'repo.scope.all': '{account}: GitHub shares every repository, including new ones.',
  'repo.scope.selected': {
    one: '{account}: GitHub shares only the {count} repository you chose.',
    other: '{account}: GitHub shares only the {count} repositories you chose.',
  },
  'repo.notListed':
    'Not listed? Change which repositories Noti can see on GitHub, then reload this page. If it is still missing, reconnect GitHub.',
  'repo.notListed.link': 'Change access for {account} on GitHub',

  // --- Integration settings: sections, repair, health, history ----------------
  'settings.destination.title': 'Destination',
  'settings.health.title': 'Health',
  'settings.history.title': 'History',
  'repair.title': 'Needs attention',
  'repair.quarantined.title': 'The saved webhook URL is not being used',
  'repair.quarantined.body':
    'It failed an integrity check, so Noti stopped sending rather than guess. Nothing is lost; deliveries wait to be redelivered.',
  'repair.quarantined.action': 'Replace the webhook URL',
  'repair.rejected.title': 'The destination rejected the saved address',
  'repair.rejected.body':
    'The latest delivery failed because the destination no longer accepts this webhook. Create a new one there and paste it here.',
  'repair.rejected.action': 'Replace the webhook URL',
  'repair.breaker.title': 'Noti paused sending to protect the destination',
  'repair.breaker.body':
    'Several deliveries in a row failed, so Noti is trying again less often. It will probe again by itself. A test shows right away whether it works.',
  'repair.breaker.action': 'Send a test',
  'repair.filters.title': 'The saved filters can’t be read',
  'repair.filters.body': 'Until you save them again, every chosen update is sent without filtering.',
  'repair.filters.action': 'Open the filters',
  'repair.noise.title': 'The saved quiet-hours settings can’t be read',
  'repair.noise.body': 'Until you save them again, updates are sent normally.',
  'repair.noise.action': 'Open quiet hours',
  'health.none': 'No deliveries yet for this integration. Send a test to see how it behaves.',
  'health.lastDelivered': 'Last delivered',
  'health.lastFailed': 'Last failure',
  'health.noneDelivered': 'None among the recent deliveries',
  'health.noneFailed': 'None among the recent deliveries',
  'health.acceptedOnly': 'accepted, not confirmed',
  'health.basis': {
    one: 'Based on the {count} most recent delivery.',
    other: 'Based on the {count} most recent deliveries.',
  },
  'history.body':
    'Every delivery for this integration is kept in Activity, where failed ones can be redelivered.',
  'history.all': 'See all deliveries for this integration',
  'history.failed': 'See failed deliveries and redeliver them',
} as const;
