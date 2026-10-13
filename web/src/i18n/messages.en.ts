/**
 * English message catalogue (F224). Ids are stable keys; values are templates with `{name}`
 * placeholders. Plural messages carry ICU-style categories and are resolved by `tp()`.
 *
 * Copy rules (F220, DESIGN.md §12/§14): plain verbs, one claim at a time, say what happened
 * and what to do next, never blame the reader, never claim a success the system has not seen.
 */
export type PluralMessage = { readonly one?: string; readonly other: string };

export const en = {
  // --- Integrations list --------------------------------------------------
  'integrations.eyebrow': 'CONNECTIONS',
  'integrations.title': 'Integrations',
  'integrations.description':
    'Each integration sends chosen GitHub updates from one repository to one Lark or Slack chat.',
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
  'wizard.description': 'Five short steps. Nothing is saved until you choose Create integration.',
  'wizard.progress': 'Setup steps',
  'wizard.stepOf': 'Step {current} of {total}: {title}',
  'wizard.step.github': 'Connect GitHub',
  'wizard.step.destination': 'Choose where messages go',
  'wizard.step.webhook': 'Paste the webhook URL',
  'wizard.step.source': 'Choose the repository',
  'wizard.step.events': 'Choose what to send',
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
  'validation.destination': 'Choose Lark or Slack.',
  'validation.name': 'Use 1–80 characters, without line breaks.',
  'validation.repo': 'Use the form owner/repository, for example acme/website.',
  'validation.events': 'Choose at least one update.',
  'validation.webhookUrl.empty': 'Paste the webhook URL from {destination}.',
  'validation.webhookUrl.invalid': 'This isn’t a complete web address. Copy the whole URL again.',
  'validation.webhookUrl.wrongHost.lark':
    'That isn’t a Lark webhook address. It should start with https://open.larksuite.com/open-apis/bot/v2/hook/ (or open.feishu.cn).',
  'validation.webhookUrl.wrongHost.slack':
    'That isn’t a Slack webhook address. It should start with https://hooks.slack.com/services/.',
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
} as const satisfies Record<string, string | PluralMessage>;

export type MessageId = keyof typeof en;
