/**
 * English message catalogue (F224). Ids are stable keys; values are templates with `{name}`
 * placeholders. Plural messages carry ICU-style categories and are resolved by `tp()`.
 *
 * Copy rules (F220, DESIGN.md §12/§14): plain verbs, one claim at a time, say what happened
 * and what to do next, never blame the reader, never claim a success the system has not seen.
 */
import { filtersEn } from './messages.filters.en';

export type PluralMessage = { readonly one?: string; readonly other: string };

export const en = {
  ...filtersEn,

  // --- Integrations list --------------------------------------------------
  'integrations.eyebrow': 'CONNECTIONS',
  'integrations.title': 'Integrations',
  'integrations.description':
    'Each integration sends chosen GitHub updates from one repository to one Lark, Slack or Microsoft Teams chat.',
  'integrations.new': 'New integration',
  'integrations.loading': 'Loading integrations…',
  'integrations.count': { one: '{count} integration', other: '{count} integrations' },
  'integrations.paused.count': { one: '{count} paused', other: '{count} paused' },
  'integrations.listLabel': 'Integrations in this workspace',
  'integrations.empty.title': 'No integrations yet',
  'integrations.empty.body':
    'An integration watches one GitHub repository and posts the updates you choose — like a failed build or a merged pull request — to a Lark group or a Slack channel.',
  'integrations.empty.action': 'Set up your first integration',
  'integrations.roadmap':
    'More sources and destinations are on the roadmap. We do not list integrations we cannot connect today.',
  'integrations.error.title': 'We couldn’t load your integrations.',
  'integrations.error.body': 'Nothing has been changed. Your saved integrations are not affected.',
  'integrations.retry': 'Try again',
  'integrations.truncated':
    'Showing the 200 most recently created integrations. Older ones still work but are not listed here yet.',

  // --- One integration in the list ----------------------------------------
  'integration.repo': 'Repository',
  'integration.destination': 'Sends to',
  'integration.destinationValue': '{destination} · {host}',
  'integration.destinationNoHost': '{destination}',
  'integration.events': 'Updates',
  'integration.events.more': { one: '+{count} more', other: '+{count} more' },
  'integration.events.unknown': 'No longer supported: {type}',
  'integration.manage': 'Manage',
  'integration.manageLabel': 'Manage {name}',
  'integration.toggle.label': 'Send notifications',
  'integration.toggle.labelFor': 'Send notifications for {name}',
  'integration.toggle.on': 'On',
  'integration.toggle.off': 'Paused',
  'integration.toggle.saving': 'Saving…',
  'integration.toggle.errorOn': 'We couldn’t turn {name} back on, so it is still paused.',
  'integration.toggle.errorOff': 'We couldn’t pause {name}, so it is still on.',

  // --- Credential states --------------------------------------------------
  'credentials.legacy.title': 'Re-enter the webhook URL to finish a security upgrade',
  'credentials.legacy.body':
    'This integration was saved before Noti began sealing each webhook URL with its own encryption key. It still works, but pasting the URL again stores it the new way.',
  'credentials.quarantined.title': 'Notifications stopped: we can’t read the saved webhook URL',
  'credentials.quarantined.body':
    'The stored webhook URL failed an integrity check, so Noti stopped using it rather than guess. Paste the URL from {destination} again to resume.',
  'credentials.fix': 'Replace webhook URL',
  'credentials.ok': 'Stored encrypted. Noti never shows it again.',

  // --- Destinations -------------------------------------------------------
  'destination.lark': 'Lark',
  'destination.slack': 'Slack',
  'destination.lark.where': 'Posts to a Lark group you choose.',
  'destination.slack.where': 'Posts to the Slack channel you choose.',
  'destination.lark.what': 'Uses a custom bot that you add to the group. No admin approval is needed.',
  'destination.slack.what': 'Uses an incoming webhook from a Slack app in your workspace.',
  'destination.lark.urlHint':
    'Starts with https://open.larksuite.com/open-apis/bot/v2/hook/ (or open.feishu.cn).',
  'destination.slack.urlHint': 'Starts with https://hooks.slack.com/services/.',
  'destination.lark.docs': 'Lark’s guide to custom bots',
  'destination.slack.docs': 'Slack’s guide to incoming webhooks',
  'destination.teams': 'Microsoft Teams',
  'destination.teams.where': 'Posts to the Teams channel you choose.',
  'destination.teams.what':
    'Uses a Power Automate “Workflows” flow whose trigger is a web request. It runs under your account.',
  'destination.teams.urlHint':
    'A https://…logic.azure.com/… address, shown on the flow’s first step after you save it.',
  'destination.teams.docs': 'Microsoft’s guide to webhooks with Workflows',
  'destination.teams.step1':
    'In Teams, open the channel’s “…” menu, choose Workflows, and pick “Post to a channel when a webhook request is received”. You can also start from Power Automate.',
  'destination.teams.step2': 'Name the flow, check the team and channel, then choose Next and Create flow.',
  'destination.teams.step3':
    'Open the flow’s first step (“When a Teams webhook request is received”). Under Who can trigger the flow, choose Anyone. Noti cannot sign in as a Microsoft user.',
  'destination.teams.step4': 'Save, then copy the HTTP POST URL from that step.',
  'destination.teams.step5': 'Paste it below. Noti accepts only addresses on logic.azure.com.',
  'destination.teams.noteOwner':
    'The flow belongs to the person who created it, not to the team. If they leave the company, notifications stop. Ask them to add a co-owner.',
  'destination.teams.noteAccepted':
    'Teams only says “accepted” when we send a message. It cannot confirm the flow posted it, so Noti shows these as Accepted, never Delivered. If your admin has not approved Workflows, messages are accepted and then lost.',
  'destination.guideTitle': 'Where to find the webhook URL',
  'destination.guideNote':
    'These steps follow the provider’s own documentation. If a screen looks different, use their guide.',
  'destination.lark.step1':
    'Open the Lark group where notifications should appear. Everyone in it will see them.',
  'destination.lark.step2': 'Open the group’s Settings (设置), then Bots (群机器人).',
  'destination.lark.step3':
    'Choose Add Bot (添加机器人), then Custom Bot (自定义机器人). Name it and add it.',
  'destination.lark.step4': 'Copy the webhook address and paste it below.',
  'destination.lark.step5':
    'Optional: turn on signature verification (签名校验) and copy the secret as well. Noti then signs every message.',
  'destination.slack.step1': 'Open your Slack app at api.slack.com/apps, or create one for your workspace.',
  'destination.slack.step2': 'Under Features, open Incoming Webhooks and turn them on.',
  'destination.slack.step3': 'Choose Add New Webhook, pick the channel and allow access.',
  'destination.slack.step4': 'Copy the Webhook URL and paste it below.',

  // --- Wizard -------------------------------------------------------------
  'wizard.eyebrow': 'NEW INTEGRATION',
  'wizard.title': 'Set up an integration',
  'wizard.description': 'Six short steps. Nothing is saved until you choose Create integration.',
  'wizard.progress': 'Setup steps',
  'wizard.stepOf': 'Step {current} of {total}: {title}',
  'wizard.step.github': 'Connect GitHub',
  'wizard.step.destination': 'Choose where messages go',
  'wizard.step.webhook': 'Paste the webhook URL',
  'wizard.step.source': 'Choose the repository',
  'wizard.step.events': 'Choose what to send',
  'wizard.step.filters': 'Add filters (optional)',
  'wizard.step.review': 'Review and create',
  'wizard.back': 'Back',
  'wizard.continue': 'Continue',
  'wizard.cancel': 'Cancel',
  'wizard.create': 'Create integration',
  'wizard.creating': 'Creating…',
  'wizard.leaveConfirm': 'Leave setup? What you entered here will be discarded.',
  'wizard.fixErrors': 'Check the highlighted fields.',
  'wizard.serverErrors':
    'Noti couldn’t save this yet. Fix the fields marked below; your other answers are kept.',
  'wizard.destination.legend': 'Where should notifications go?',
  'wizard.destination.changeNote': 'You can’t switch destination later, because the URL belongs to it.',
  'wizard.review.intro': 'Check the details. You can change the name, repository and updates later.',
  'wizard.review.edit': 'Change',
  'wizard.review.editLabel': 'Change {field}',
  'wizard.review.webhook': 'Webhook URL',
  'wizard.review.webhookValue': 'Provided — stored encrypted after you create',
  'wizard.review.secret': 'Signing secret',
  'wizard.review.secretValue': 'Provided',
  'wizard.review.secretNone': 'Not used',

  // --- Fields -------------------------------------------------------------
  'field.webhookUrl': 'Webhook URL',
  'field.webhookUrl.warning':
    'Anyone with this URL can post to your chat. Treat it like a password. We store it encrypted and never show it again.',
  'field.signingSecret': 'Signing secret (optional)',
  'field.signingSecret.hint': 'Only if you turned on signature verification (签名校验) for the bot.',
  'field.signingSecret.rotateHint':
    'If the bot uses signature verification, paste its secret again. Leaving this empty turns signing off.',
  'field.name': 'Name (optional)',
  'field.name.hint': 'A short label for your team. If you leave it empty we use the repository.',
  'field.nameRequired': 'Name',
  'field.repo': 'GitHub repository',
  'field.repo.hint':
    'Owner and repository name, as in github.com/owner/repository. Capital letters don’t matter.',
  'field.repo.placeholder': 'owner/repository',
  'field.events': 'Updates to send',
  'field.events.hint':
    'We start with failed and timed-out builds because it is the quietest useful setting. You can change it any time.',
  'field.events.selectAll': 'Select all',
  'field.events.clearAll': 'Clear',
  'field.events.selectAllLabel': 'Select all {group} updates',
  'field.events.clearAllLabel': 'Clear all {group} updates',
  'field.events.selected': { one: '{count} update selected', other: '{count} updates selected' },
  'field.show': 'Show',
  'field.hide': 'Hide',
  'field.showLabel': 'Show {field}',
  'field.hideLabel': 'Hide {field}',

  // --- Client-side validation (mirrors src/api/integration-input.ts) -------
  'validation.destination': 'Choose Lark, Slack or Microsoft Teams.',
  'validation.name': 'Use 1–80 characters, without line breaks.',
  'validation.repo': 'Use the form owner/repository, for example acme/website.',
  'validation.events': 'Choose at least one update.',
  'validation.webhookUrl.empty': 'Paste the webhook URL from {destination}.',
  'validation.webhookUrl.invalid': 'This isn’t a complete web address. Copy the whole URL again.',
  'validation.webhookUrl.wrongHost.lark':
    'That isn’t a Lark webhook address. It should start with https://open.larksuite.com/open-apis/bot/v2/hook/ (or open.feishu.cn).',
  'validation.webhookUrl.wrongHost.slack':
    'That isn’t a Slack webhook address. It should start with https://hooks.slack.com/services/.',
  'validation.webhookUrl.wrongHost.teams':
    'That isn’t a Workflows web-request address. It should start with https:// and end its host with logic.azure.com.',
  'validation.signingSecret': 'Paste the secret exactly as Lark shows it, without spaces.',

  // --- Event categories ---------------------------------------------------
  'eventGroup.builds': 'Builds and checks',
  'eventGroup.builds.hint': 'GitHub Actions workflow results.',
  'eventGroup.pullRequests': 'Pull requests',
  'eventGroup.reviews': 'Reviews and code comments',
  'eventGroup.issues': 'Issues and comments',
  'eventGroup.code': 'Code',
  'eventGroup.releases': 'Releases and deployments',

  // --- Event labels (keyed by src/connectors/sources/github/catalog.ts) ----
  'event.workflow_run.failure': 'A workflow fails',
  'event.workflow_run.timed_out': 'A workflow times out',
  'event.workflow_run.cancelled': 'A workflow is cancelled',
  'event.workflow_run.success': 'A workflow succeeds',
  'event.pull_request.opened': 'A pull request is opened',
  'event.pull_request.ready_for_review': 'A draft pull request is ready for review',
  'event.pull_request.reopened': 'A pull request is reopened',
  'event.pull_request.merged': 'A pull request is merged',
  'event.pull_request.closed': 'A pull request is closed without merging',
  'event.pull_request_review.submitted': 'Someone submits a review',
  'event.pull_request_review_comment.created': 'Someone comments on a line of code',
  'event.issues.opened': 'An issue is opened',
  'event.issues.closed': 'An issue is closed',
  'event.issues.reopened': 'An issue is reopened',
  'event.issue_comment.created': 'Someone comments on an issue or pull request',
  'event.push': 'Commits are pushed',
  'event.release.published': 'A release is published',
  'event.deployment_status.created': 'A deployment reports a new status',

  // --- Settings (one integration) -----------------------------------------
  'settings.eyebrow': 'INTEGRATION',
  'settings.back': 'All integrations',
  'settings.loading': 'Loading integration…',
  'settings.notFound.title': 'This integration doesn’t exist in this workspace.',
  'settings.notFound.body': 'It may have been deleted, or the link belongs to another workspace.',
  'settings.created':
    '{name} is saved. Matching GitHub updates from this repository will be sent from now on.',
  'settings.status.title': 'Status',
  'settings.status.on': 'On. New events for this repository are sent to {destination}.',
  'settings.status.onBlocked':
    'On, but nothing can be sent until the webhook URL is replaced. See Destination and webhook URL below.',
  'settings.status.off':
    'Paused. Nothing is sent. Settings and credentials are kept, and you can turn it back on.',
  'settings.details.title': 'Repository and updates',
  'settings.save': 'Save changes',
  'settings.saving': 'Saving…',
  'settings.saved': 'Changes saved.',
  'settings.noChanges': 'Nothing has changed yet.',
  'settings.unsaved': 'You have unsaved changes.',
  'settings.leaveConfirm': 'Leave this page? Your unsaved changes will be lost.',
  'settings.credentials.title': 'Destination and webhook URL',
  'settings.credentials.destination': 'Destination',
  'settings.credentials.host': 'Webhook host',
  'settings.credentials.state': 'Stored URL',
  'settings.credentials.stateOk': 'Encrypted',
  'settings.credentials.stateLegacy': 'Needs re-entry',
  'settings.credentials.stateQuarantined': 'Unreadable — replace it',
  'settings.credentials.destinationFixed':
    'To send to a different kind of destination, create a new integration.',
  'settings.credentials.replace': 'Replace webhook URL',
  'settings.credentials.replaceIntro':
    'Paste a new URL from {destination}. Noti stops using the old one as soon as you save, and its encryption key is discarded.',
  'settings.credentials.save': 'Save new webhook URL',
  'settings.credentials.saved': 'New webhook URL saved. The old one is no longer used.',
  'settings.danger.title': 'Delete integration',
  'settings.danger.body':
    'Deleting removes this integration and destroys its stored webhook URL and signing secret. They cannot be recovered. To stop messages for a while instead, pause it above.',
  'settings.delete': 'Delete integration',

  // --- Delete dialog --------------------------------------------------------
  'delete.title': 'Delete {name}?',
  'delete.body':
    'Noti stops sending updates from {repo} to {destination} and destroys the stored webhook URL and signing secret. This cannot be undone.',
  'delete.confirmLabel': 'Type {name} to confirm',
  'delete.cancel': 'Keep integration',
  'delete.confirm': 'Delete permanently',
  'delete.deleting': 'Deleting…',
  'delete.done': '{name} was deleted.',

  // --- Request errors (F220: what happened, then what to do) --------------
  'error.network': 'We couldn’t reach Noti. Check your connection, then try again.',
  'error.session': 'Your session has ended. Sign in again to continue.',
  'error.forbidden': 'Your role can’t make this change. Ask a workspace admin.',
  'error.blocked': 'The request was blocked by a security check. Reload the page, then try again.',
  'error.notFound': 'This integration no longer exists. It may have been deleted.',
  'error.quota':
    'This workspace has reached its limit of 100 integrations. Delete one you no longer use, then try again.',
  'error.rateLimited': 'That was a lot of changes in a short time. Wait a minute, then try again.',
  'error.rateLimitedFor':
    'That was a lot of changes in a short time. Wait {seconds} seconds, then try again.',
  'error.tooLarge': 'That is more than Noti accepts in one request. Shorten the longest field.',
  'error.server': 'Something went wrong on our side. Reload to see what was saved.',
  'error.validation': 'Some fields need attention.',
  'error.reference': 'Reference for support: HTTP {status}',

  // --- GitHub connection (ADR 0008) ----------------------------------------
  'github.title': 'GitHub connection',
  'github.loading': 'Checking your GitHub connection…',
  'github.error': 'We couldn’t check your GitHub connection.',
  'github.intro.none':
    'Noti reads GitHub updates through the Noti GitHub App. Install it on your account or organization and choose which repositories Noti may see.',
  'github.intro.connected':
    'Integrations can use the repositories these GitHub accounts let Noti see. Connect again to add an account or change which repositories are included.',
  'github.connect': 'Connect GitHub',
  'github.reconnect': 'Reconnect to refresh repository access',
  'github.connecting': 'Opening GitHub…',
  'github.samlHint':
    'If your organization uses single sign-on, sign in to it on GitHub first, or GitHub will not show the installation to Noti.',
  'github.notConfigured.title': 'GitHub App not configured on this server',
  'github.notConfigured.body':
    'This Noti server has no GitHub App credentials yet, so GitHub can’t be connected and no integration can be created. An administrator of this server needs to register the App first.',
  'github.type.org': 'Organization',
  'github.type.user': 'Personal account',
  'github.status.active': 'Connected',
  'github.status.suspended': 'Suspended',
  'github.status.uninstalled': 'Uninstalled',
  'github.scope.all': 'All repositories of {account}, including new ones',
  'github.scope.selected': { one: '{count} selected repository', other: '{count} selected repositories' },
  'github.suspended.body':
    'The Noti App is suspended for {account} in GitHub, so no updates arrive from it. An owner of {account} can unsuspend it in GitHub’s settings.',
  'github.uninstalled.body':
    'The Noti App was uninstalled from {account}, so its integrations receive nothing. Connect GitHub again to restore access.',
  'github.resync.title': 'Noti’s repository list may be out of date',
  'github.resync.body':
    'GitHub changed which repositories of {account} Noti may see, and only part of the change reached us. Reconnect to refresh the list.',
  'github.return.connected': 'GitHub is connected. You can now choose its repositories in an integration.',
  'github.return.next': 'Set up an integration',
  'github.return.state_invalid':
    'That GitHub connection link expired or was already used. Choose Connect GitHub to start again.',
  'github.return.state_user_mismatch':
    'The GitHub connection was started by a different Noti user. Start it again while signed in as yourself.',
  'github.return.installation_id_invalid':
    'GitHub sent back an installation Noti could not recognise. Choose Connect GitHub to try again.',
  'github.return.oauth_failed':
    'GitHub didn’t confirm who you are, so nothing was connected. Try again, and approve the request on GitHub.',
  'github.return.installation_not_accessible':
    'Your GitHub account can’t see that installation. If the organization uses single sign-on, sign in to it on GitHub, then try again.',
  'github.return.installation_admin_required':
    'Only an owner or admin of a GitHub organization can connect it to Noti. Ask one of them to choose Connect GitHub from this workspace.',
  'github.return.installation_bound_elsewhere':
    'That GitHub installation is already connected to another Noti workspace. It can belong to only one.',
  'github.return.installation_deleted':
    'That installation was removed from GitHub before it could be connected. Install the App again.',
  'github.return.installation_too_large':
    'That installation includes more than 1,000 selected repositories, which Noti can’t track yet. Choose fewer repositories, or all repositories, in GitHub.',
  'github.return.workspace_access_lost':
    'You no longer have access to this workspace, so nothing was connected. Ask a workspace admin to check your role.',
  'github.return.github_unavailable':
    'GitHub didn’t respond, so nothing was connected. Try again in a few minutes.',
  'github.return.not_configured':
    'This Noti server has no GitHub App configured, so GitHub can’t be connected yet.',
  'github.return.signin_required': 'Sign in to Noti, then choose Connect GitHub again.',
  'github.return.unexpected_error':
    'Something went wrong while connecting GitHub, and nothing was connected. Try again; if it keeps happening, contact support.',

  // --- Repository picker ----------------------------------------------------
  'repo.picker': 'GitHub repository',
  'repo.picker.hint': 'Only repositories your GitHub connection lets Noti see are listed.',
  'repo.picker.placeholder': 'Choose a repository',
  'repo.picker.allOption': 'Another repository in {account}…',
  'repo.picker.notCovered': '{repo} (no longer visible to Noti)',
  'repo.name': 'Repository name in {account}',
  'repo.name.hint': 'Type the name as it appears after {account}/ on GitHub.',
  'repo.none.title': 'Connect GitHub first',
  'repo.none.body':
    'An integration watches a repository that the Noti GitHub App can see. Connect GitHub and choose the repositories. GitHub then brings you back to Integrations, where you can start this setup again.',
  'validation.repoNotCovered':
    'Noti can’t see this repository. Choose one from the list, or reconnect GitHub to grant access.',

  // --- Overview -------------------------------------------------------------
  'overview.integrations': 'Integrations',
  'overview.integrations.loading': 'Loading…',
  'overview.integrations.error': 'Couldn’t load',
  'overview.integrations.breakdown': '{enabled} on · {paused} paused',
  'overview.integrations.none': 'None set up yet',
  'overview.delivered': 'Delivered, last 24 hours',
  'overview.delivered.accepted': {
    one: '+{count} accepted but not confirmed',
    other: '+{count} accepted but not confirmed',
  },
  'overview.delivered.none': 'No deliveries in the last 24 hours',
  'overview.delivered.confirmed': 'Confirmed by the destination',
  'overview.failed': 'Failed, last 24 hours',
  'overview.failed.retrying': { one: '{count} still retrying', other: '{count} still retrying' },
  'overview.failed.clear': 'Nothing has failed',
  'overview.failed.view': 'View failed deliveries',
  'overview.stats.loading': 'Loading…',
  'overview.stats.error': 'Couldn’t load',

  // --- Delivery log (ADR 0009) ----------------------------------------------
  'deliveries.eyebrow': 'DELIVERY LOG',
  'deliveries.title': 'Activity',
  'deliveries.description':
    'Every notification Noti tried to send, what happened to it, and what to do about the ones that failed.',
  'deliveries.model':
    'Noti delivers at least once. A notification may occasionally be delivered more than once.',
  'deliveries.loading': 'Loading deliveries…',
  'deliveries.filters.label': 'Filter deliveries',
  'deliveries.filter.state': 'Outcome',
  'deliveries.filter.state.all': 'All outcomes',
  'deliveries.filter.integration': 'Integration',
  'deliveries.filter.integration.all': 'All integrations',
  'deliveries.filter.from': 'From',
  'deliveries.filter.to': 'To',
  'deliveries.filter.clear': 'Clear filters',
  'deliveries.filter.dateHint': 'Dates are in UTC and include the whole day.',
  'deliveries.count': { one: '{count} delivery shown.', other: '{count} deliveries shown.' },
  'deliveries.count.more': 'More are available.',
  'deliveries.count.end': 'That is every delivery that matches.',
  'deliveries.loadMore': 'Load more',
  'deliveries.loadingMore': 'Loading…',
  'deliveries.tableLabel': 'Deliveries, newest first',
  'deliveries.col.state': 'Outcome',
  'deliveries.col.integration': 'Integration',
  'deliveries.col.destination': 'Sends to',
  'deliveries.col.attempts': 'Attempts',
  'deliveries.col.updated': 'Last change',
  'deliveries.col.details': 'Details',
  'deliveries.details': 'Details',
  'deliveries.detailsFor': 'Details for the delivery to {name}, {state}',
  'deliveries.redelivery': 'Redelivery',
  'deliveries.redelivery.of': 'Redelivery of an earlier delivery',
  'deliveries.integrationDeleted': 'Deleted integration',
  'deliveries.empty.none.title': 'No deliveries yet',
  'deliveries.empty.none.body':
    'When a GitHub event reaches one of your integrations, each notification Noti sends appears here with its outcome.',
  'deliveries.empty.filtered.title': 'No deliveries match these filters',
  'deliveries.empty.filtered.body':
    'Nothing matches the outcome, integration and dates you chose. Clear the filters to see everything.',
  'deliveries.error.title': 'We couldn’t load the delivery log.',
  'deliveries.error.body': 'Nothing has been changed. The log may be out of date until it loads.',
  'deliveries.error.stale': 'This list may be out of date: the last refresh failed.',
  'deliveries.retry': 'Try again',
  'deliveries.error.notFound': 'This delivery isn’t in this workspace.',
  'deliveries.error.conflict': 'This delivery can’t be redelivered right now.',

  // --- Delivery states (text and icon, never colour alone: WCAG 1.4.1) --------
  'delivery.state.pending': 'Waiting',
  'delivery.state.claimed': 'Sending',
  'delivery.state.sent': 'Delivered',
  'delivery.state.accepted': 'Accepted',
  'delivery.state.retrying': 'Retrying',
  'delivery.state.dead_lettered': 'Failed',
  'delivery.state.suppressed': 'Suppressed',
  'delivery.state.pending.meaning': 'Noti has the notification and will send it shortly.',
  'delivery.state.claimed.meaning': 'Noti is sending this notification now.',
  'delivery.state.sent.meaning': 'The destination confirmed it received this notification.',
  'delivery.state.accepted.meaning':
    'The destination accepted this notification but cannot confirm it was shown. It probably arrived; Noti cannot promise it did.',
  'delivery.state.retrying.meaning': 'The last attempt did not work. Noti will try again by itself.',
  'delivery.state.dead_lettered.meaning':
    'Noti stopped trying. The notification was not delivered by this attempt.',
  'delivery.state.suppressed.meaning':
    'Noti recognised this as a duplicate of a notification it already handled, and did not send it again.',

  // --- Delivery detail --------------------------------------------------------
  'delivery.detail.title': 'Delivery to {name}',
  'delivery.detail.close': 'Close details',
  'delivery.detail.loading': 'Loading details…',
  'delivery.detail.error': 'We couldn’t load these details. The summary above is still correct.',
  'delivery.detail.whatHappened': 'What happened',
  'delivery.detail.whatNext': 'What to do',
  'delivery.detail.nextRetry': 'Next attempt: {time}.',
  'delivery.detail.retryable': 'Noti stopped after its retries ran out.',
  'delivery.detail.permanent':
    'Noti did not retry, because trying again would fail the same way until the cause is fixed.',
  'delivery.detail.fixLink': 'Open integration settings',
  'delivery.detail.noFix': 'Nothing you change will help; redelivering later may.',
  'delivery.detail.facts': 'Record',
  'delivery.detail.attempts': 'Attempts',
  'delivery.detail.created': 'Created',
  'delivery.detail.updated': 'Last change',
  'delivery.detail.id': 'Delivery ID',
  'delivery.detail.replayOf': 'Redelivery of',
  'delivery.detail.destination': 'Sends to',
  'delivery.detail.timeline': 'What Noti recorded',
  'delivery.detail.timeline.note':
    'Noti records when a delivery was created, its first and latest attempt, and when it stopped. It does not keep a log of every attempt.',
  'delivery.timeline.created': 'Created',
  'delivery.timeline.first_attempt': 'First attempt',
  'delivery.timeline.last_attempt': 'Latest attempt',
  'delivery.timeline.next_attempt': 'Next attempt scheduled',
  'delivery.timeline.dead_lettered': 'Noti stopped trying',
  'delivery.detail.replays': 'Redeliveries of this delivery',
  'delivery.detail.replays.none': 'None yet.',
  'delivery.detail.support': 'Details for support',
  'delivery.detail.supportCode': 'Error code',
  'delivery.detail.supportId': 'Delivery ID',
  'delivery.detail.noMessage': 'Noti has no further explanation for this failure.',

  // --- Redeliver --------------------------------------------------------------
  'redeliver.button': 'Redeliver',
  'redeliver.title': 'Send this notification again?',
  'redeliver.body':
    'Noti will send the original notification to {destination} again as a new delivery. The failed one stays in the log. The destination may receive it more than once.',
  'redeliver.brokenWarning':
    'If the cause above has not been fixed, this will most likely fail again. Fix it first if you can.',
  'redeliver.confirm': 'Yes, redeliver',
  'redeliver.sending': 'Queuing…',
  'redeliver.cancel': 'Cancel',
  'redeliver.queued':
    'Queued as a new delivery. It appears in the log as soon as Noti sends it. This does not mean it has arrived yet.',
  'redeliver.already': 'A redelivery of this notification was already queued, so Noti did not send another.',
  'redeliver.viewNew': 'Show the new delivery',
  'redeliver.adminOnly': 'Only workspace admins can redeliver. Ask an admin if this notification matters.',
  'redeliver.inFlight': 'A redelivery is already {state}. Check the redeliveries below.',
  'redeliver.succeeded': 'This was redelivered and the redelivery went through.',
  'redeliver.integration.missing':
    'The integration this was sent through has been deleted, so it cannot be redelivered.',
  'redeliver.integration.disabled':
    'This integration is paused. Turn it back on in its settings first, then come back to redeliver.',
  'redeliver.integration.quarantined':
    'Noti stopped using this integration’s saved webhook URL. Paste the URL again in its settings first, then come back to redeliver.',
  'redeliver.notOffered': 'Only failed deliveries can be redelivered. This one is not failed.',
  'redeliver.deletionPending':
    'This workspace is scheduled for deletion, so nothing can be redelivered. Cancel the deletion in Settings first.',

  // --- Failure explanations, selected by the server's message id (F220) ------
  'errors.destination_url_rejected':
    'The saved address isn’t one Noti is allowed to send to, so it was not used.',
  'errors.destination_credentials_invalid':
    '{destination} rejected the credentials Noti saved. Replace the webhook URL to fix it.',
  'errors.destination_revoked':
    'This connection was removed in {destination}, so notifications can’t be sent to it. Create a new webhook there and replace the URL.',
  'errors.destination_unauthorized':
    '{destination} refused the request. The connection may need new permission or a new webhook URL.',
  'errors.destination_rate_limited': '{destination} asked Noti to slow down. Noti retries automatically.',
  'errors.destination_unavailable':
    '{destination} didn’t respond. Noti retries automatically, and gave up on this one after its retries ran out.',
  'errors.payload_too_large':
    'This notification was larger than {destination} accepts. It can’t be sent as it is.',
  'errors.render_failed': 'Noti couldn’t build a message this destination accepts from this event.',
  'errors.config_invalid':
    'This integration has a setting Noti can’t read. Open its settings and save them again.',
  'errors.internal_error':
    'Something went wrong on Noti’s side. Your notification was not lost and can be redelivered.',

  // --- Workspace data and deletion (Settings) ---------------------------------
  'workspace.export.title': 'Export workspace data',
  'workspace.export.body':
    'Download a JSON file with your workspace’s members, integrations, GitHub connections and up to the 2,000 most recent deliveries and audit events. It never contains webhook URLs, signing secrets or other credentials.',
  'workspace.export.button': 'Download export',
  'workspace.export.exporting': 'Preparing…',
  'workspace.export.done': 'Export downloaded as {file}.',
  'workspace.export.truncated': 'Older deliveries or audit events exist that this file does not include.',
  'workspace.export.error': 'We couldn’t prepare the export. Nothing was changed. Try again.',
  'workspace.adminOnly': 'Only workspace admins can do this. Your role is member.',
  'workspace.danger.title': 'Delete workspace',
  'workspace.danger.intro':
    'Deleting a workspace stops all of its notifications and, after a 7-day waiting period, permanently removes its data.',
  'workspace.danger.point1': 'Right away: every integration is paused and nothing more is delivered.',
  'workspace.danger.point2':
    'For 7 days: you can cancel, and the integrations that were on are turned back on.',
  'workspace.danger.point3':
    'After 7 days: the integrations, delivery history, members, audit log and the workspace itself are deleted. Stored webhook URLs become unrecoverable.',
  'workspace.danger.backup':
    'Backups: Cloudflare D1 Time Travel can restore the database to any point in the last 30 days, so deleted data may remain in Cloudflare’s point-in-time history for up to 30 days after the purge. Noti does not promise faster erasure than that.',
  'workspace.danger.exportFirst': 'Export your data first if you may need it.',
  'workspace.danger.button': 'Delete workspace…',
  'workspace.danger.loading': 'Checking deletion status…',
  'workspace.danger.error': 'We couldn’t check whether a deletion is scheduled.',
  'workspace.danger.scheduled.title': 'Deletion is scheduled',
  'workspace.danger.scheduled.body':
    'Integrations are paused and nothing is being delivered. Everything is permanently removed after {date}.',
  'workspace.danger.purgeStarted': 'Removal has already started and can no longer be cancelled.',
  'workspace.danger.cancel': 'Cancel deletion',
  'workspace.danger.cancelling': 'Cancelling…',
  'workspace.danger.cancelled': 'Deletion cancelled. Integrations that were on have been turned back on.',
  'workspace.danger.dialog.title': 'Delete {name}?',
  'workspace.danger.dialog.body':
    'This pauses every integration now and permanently deletes the workspace after 7 days unless you cancel. Type the workspace name to confirm.',
  'workspace.danger.dialog.label': 'Type {name} to confirm',
  'workspace.danger.dialog.keep': 'Keep workspace',
  'workspace.danger.dialog.confirm': 'Schedule deletion',
  'workspace.danger.dialog.scheduling': 'Scheduling…',
  'workspace.error.wrongName': 'That doesn’t match the workspace name. Type it exactly, including capitals.',
  'workspace.error.already': 'A deletion is already scheduled for this workspace.',
  'workspace.error.purgeStarted': 'Removal has already started and can’t be cancelled.',
  // --- Sources (generic signed webhook source, ADR 0012) --------------------
  'sources.nav': 'Sources',
  'sources.eyebrow': 'CONNECTIONS',
  'sources.title': 'Sources',
  'sources.description':
    'A source is your own system sending events to Noti. Each source has a private signing secret that proves an event really came from you, and every event it accepts can be sent to a Lark, Slack or Microsoft Teams chat.',
  'sources.loading': 'Loading sources…',
  'sources.count': { one: '{count} source', other: '{count} sources' },
  'sources.listLabel': 'Sources in this workspace',
  'sources.empty.title': 'No sources yet',
  'sources.empty.body':
    'Add a source to get a private address and a signing secret. Then your system can POST a small JSON event whenever something happens — a failed deploy, a new order, a finished job.',
  'sources.error.title': 'We couldn’t load your sources.',
  'sources.error.body': 'Nothing has been changed. Your saved sources are not affected.',
  'sources.retry': 'Try again',
  'sources.create.title': 'Add a source',
  'sources.create.label': 'Source name',
  'sources.create.hint': 'For example “CI pipeline” or “Billing service”.',
  'sources.create.submit': 'Create source',
  'sources.create.submitting': 'Creating…',
  'sources.create.failed': 'The source was not created.',
  'sources.secret.created.title': 'Signing secret for {name}',
  'sources.secret.rotated.title': 'New signing secret for {name}',
  'sources.secret.warning':
    'This is the only time Noti shows this secret. Copy it now and keep it in your secret manager. Noti cannot show it again; if it is lost, rotate the secret to get a new one.',
  'sources.secret.rotatedNote':
    'The previous secret stopped working immediately. Update your sender to use this one; events signed with the old secret are refused.',
  'sources.secret.label': 'Signing secret',
  'sources.secret.copy': 'Copy secret',
  'sources.secret.copied': 'Copied',
  'sources.secret.copyFailed': 'Copying did not work. Select the secret and copy it yourself.',
  'sources.secret.saved': 'I have saved it',
  'sources.card.endpoint': 'Endpoint URL',
  'sources.card.endpointHint':
    'Your system sends signed POST requests here. The address is not a secret; the signature is what proves who sent an event.',
  'sources.card.copyUrl': 'Copy URL',
  'sources.card.lastReceived': 'Last event',
  'sources.card.neverReceived': 'No events received yet',
  'sources.card.chats': 'Sends to',
  'sources.card.chatsCount': { one: '{count} chat', other: '{count} chats' },
  'sources.card.chatsNone': 'No chat yet — events are accepted but sent nowhere.',
  'sources.card.rotated': 'Secret changed',
  'sources.card.reused': {
    one: '{count} event was rejected because its id was reused.',
    other: '{count} events were rejected because their id was reused.',
  },
  'sources.card.reusedHelp':
    'Each event needs its own webhook-id. A request that reuses an id with different content is refused with HTTP 409 so it is never silently dropped. Give every event a new id; only retry the same event with the same id and the same body.',
  'sources.adminOnly': 'Only workspace admins can rotate the secret or delete a source.',
  'sources.card.created': 'Created',
  'sources.toggle.label': 'Receive events',
  'sources.toggle.labelFor': 'Receive events for {name}',
  'sources.toggle.on': 'Receiving events',
  'sources.toggle.off': 'Paused: events are refused',
  'sources.toggle.saving': 'Saving…',
  'sources.toggle.error': 'We couldn’t change {name}. It is still {state}.',
  'sources.toggle.state.on': 'receiving',
  'sources.toggle.state.off': 'paused',
  'sources.guide.summary': 'Send a test event',
  'sources.guide.intro':
    'Events are JSON, signed with your secret using the Standard Webhooks method. Put the secret in an environment variable first so it never lands in your shell history.',
  'sources.guide.formatTitle': 'Event format',
  'sources.guide.format':
    'Required: type (such as deploy.failed) and title. Optional: summary, url (https only, shown as a link, never opened by Noti), severity (info, warning, error or critical), actor, and up to 10 simple fields. Maximum body size is 256 KiB.',
  'sources.guide.signTitle': 'How events are signed',
  'sources.guide.sign':
    'Send three headers: webhook-id (unique per event), webhook-timestamp (seconds; must be within 5 minutes) and webhook-signature (v1, then a comma, then the base64 HMAC-SHA256 of “id.timestamp.body”, keyed with the decoded secret). Ids must be unique per event: repeating a webhook-id with the same body is safe (Noti accepts that event once), but reusing it for different content is refused with HTTP 409.',
  'sources.guide.bash': 'Shell (curl and openssl)',
  'sources.guide.node': 'Node.js',
  'sources.guide.copy': 'Copy example',
  'sources.guide.copied': 'Copied',
  'sources.guide.copyFailed': 'Copying did not work. Select the example and copy it yourself.',
  'sources.guide.result':
    'A successful request answers 202. 401 means the signature or timestamp was wrong; 400 names the field that was invalid.',
  'sources.chat.summary': 'Send these events to a chat',
  'sources.chat.intro':
    'Every event this source accepts is posted to the chat you connect. Connect more than one chat to post to several places.',
  'sources.chat.name': 'Name',
  'sources.chat.nameHint': 'How this connection appears in your Integrations list.',
  'sources.chat.destination': 'Chat app',
  'sources.chat.submit': 'Connect chat',
  'sources.chat.submitting': 'Connecting…',
  'sources.chat.done': 'Connected. New events from {name} now go to {destination}.',
  'sources.chat.failed': 'The chat was not connected.',
  'sources.rotate.open': 'Rotate secret…',
  'sources.rotate.title': 'Rotate the secret for {name}?',
  'sources.rotate.body':
    'A new secret is created and shown once. The current secret stops working immediately, so events from your system will be refused (401) until you update it. There is no overlap period.',
  'sources.rotate.keep': 'Keep current secret',
  'sources.rotate.confirm': 'Rotate secret',
  'sources.rotate.rotating': 'Rotating…',
  'sources.rotate.failed': 'The secret was not changed.',
  'sources.delete.open': 'Delete source…',
  'sources.delete.title': 'Delete {name}?',
  'sources.delete.body': {
    one: 'The endpoint stops working at once and the signing secret is destroyed. {count} connected chat is deleted with it, including the webhook URL saved for it. This cannot be undone.',
    other:
      'The endpoint stops working at once and the signing secret is destroyed. {count} connected chats are deleted with it, including the webhook URLs saved for them. This cannot be undone.',
  },
  'sources.delete.bodyNoChats':
    'The endpoint stops working at once and the signing secret is destroyed. This cannot be undone.',
  'sources.delete.confirmLabel': 'Type {name} to confirm',
  'sources.delete.keep': 'Keep source',
  'sources.delete.confirm': 'Delete source',
  'sources.delete.deleting': 'Deleting…',
  'sources.delete.failed': 'The source was not deleted.',
  'integration.source': 'Source',
  'integration.source.value': 'Events from your own system',
  'integration.source.manage': 'Manage sources',
  'settings.details.source':
    'This integration sends every event from its source. To change what it receives, change or pause the source.',
} as const satisfies Record<string, string | PluralMessage>;

export type MessageId = keyof typeof en;
