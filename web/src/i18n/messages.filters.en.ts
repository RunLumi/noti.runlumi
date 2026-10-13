import type { PluralMessage } from './messages.en';

/**
 * Copy for routing filters (ADR 0010). A separate catalogue merged into `en`, so the filters
 * feature can change its strings without touching the shared file. Same rules as there: plain
 * verbs, one claim at a time, never blame the reader, never claim more than Noti can do.
 */
export const filtersEn = {
  'filters.title': 'Filters',
  'filters.intro':
    'Filters make this integration quieter. An update is sent only if it passes every filter you set. With no filters, every update you chose above is sent.',
  'filters.honest':
    'Filters never add updates and never change who can see them; they only hold back updates this integration would have sent. If a detail a filter needs is missing from an update, that update is held back, and the log says so. Noti keeps a short log of what was held back and why; it does not keep the events themselves.',

  'filters.branches.title': 'Branches',
  'filters.branches.hint':
    'Applies to pushes, pull requests and workflow runs. It checks the branch the work happened on.',
  'filters.branchAllow': 'Only these branches',
  'filters.branchAllow.hint': 'One per line. Leave empty to allow every branch.',
  'filters.branchDeny': 'Never these branches',
  'filters.branchDeny.hint': 'One per line. A branch listed here is always skipped.',
  'filters.patternHelp':
    'Use * for part of a name (release/*) and ** to include slashes (release/**). Capital letters don’t matter.',

  'filters.base.title': 'Pull request target',
  'filters.base.hint': 'Applies to pull requests. It checks the branch the pull request wants to merge into.',
  'filters.baseAllow': 'Only into these branches',
  'filters.baseAllow.hint': 'One per line, for example main. Leave empty to allow every target.',
  'filters.baseDeny': 'Never into these branches',
  'filters.baseDeny.hint': 'One per line.',

  'filters.people.title': 'People and bots',
  'filters.people.hint':
    'Applies to every update. A deleted GitHub account is never skipped, because missing a failure you can no longer attribute is worse than one extra message.',
  'filters.bots': 'Updates from bots',
  'filters.bots.any': 'Send them',
  'filters.bots.exclude': 'Skip them',
  'filters.bots.only': 'Send only bot updates',
  'filters.peopleAllow': 'Only these people',
  'filters.peopleAllow.hint': 'GitHub usernames, one per line. Leave empty to allow everyone.',
  'filters.peopleDeny': 'Never these people',
  'filters.peopleDeny.hint': 'GitHub usernames, one per line, for example dependabot[bot].',

  'filters.drafts.title': 'Draft pull requests',
  'filters.drafts.label': 'Skip updates about draft pull requests',
  'filters.drafts.hint': 'You still hear about a pull request when it is marked ready for review.',

  'filters.labels.title': 'Labels',
  'filters.labels.hint':
    'Applies to issues and pull requests. Matching is by whole label name, not part of a name.',
  'filters.labelsInclude': 'Only with one of these labels',
  'filters.labelsInclude.hint': 'One per line. Leave empty to allow any labels.',
  'filters.labelsExclude': 'Never with any of these labels',
  'filters.labelsExclude.hint': 'One per line.',

  'filters.error.pattern':
    'Line {line}: use only letters, numbers, / . _ - and the wildcards * and **. The characters ? [ ] { } + and a leading ! are not supported.',
  'filters.error.login':
    'Line {line}: use a GitHub username, for example octocat or dependabot[bot]. The deleted-user placeholder can’t be filtered.',
  'filters.error.label': 'Line {line}: use a label name of up to 100 characters.',
  'filters.error.entry': 'Line {line}: this entry isn’t valid.',
  'filters.error.tooMany': 'Use at most 32 lines in this list.',
  'filters.error.total': 'That is too many entries in total. Remove some, up to 128 across all filters.',
  'filters.error.generic': 'These filters aren’t valid. Check each list.',

  'filters.save': 'Save filters',
  'filters.saving': 'Saving…',
  'filters.saved': 'Filters saved. They apply to the next update.',
  'filters.clear': 'Remove all filters',
  'filters.unsaved': 'You have unsaved filter changes.',
  'filters.none': 'No filters. Every update you chose is sent.',
  'filters.invalidStored.title': 'These filters can’t be read, so updates are being held back',
  'filters.invalidStored.body':
    'Noti holds back every update for this integration until the filters are replaced, because a rule you can’t see might be there for privacy. Replace the filters to resume.',

  'filters.summary.none': 'None',
  'filters.summary.count': { one: '{count} filter on', other: '{count} filters on' },
  'filters.name.branch': 'Branches',
  'filters.name.baseBranch': 'Pull request target',
  'filters.name.actor': 'People and bots',
  'filters.name.draft': 'Draft pull requests',
  'filters.name.labels': 'Labels',
  'filters.review.label': 'Filters',

  'filters.try.title': 'Try it',
  'filters.try.intro':
    'Describe an update and see whether these filters would send it. This uses the filters on this screen, saved or not. It is a check, not a real event: nothing is sent.',
  'filters.try.event': 'Update',
  'filters.try.branch': 'Branch',
  'filters.try.branch.hint': 'Leave empty if GitHub would not say.',
  'filters.try.base': 'Pull request target branch',
  'filters.try.person': 'Person',
  'filters.try.person.hint': 'A GitHub username. Leave empty if unknown.',
  'filters.try.bot': 'Is the person a bot?',
  'filters.try.draft': 'Is it a draft pull request?',
  'filters.try.labels': 'Labels',
  'filters.try.labels.hint': 'One per line. Empty means the item has no labels.',
  'filters.try.tri.unknown': 'GitHub doesn’t say',
  'filters.try.tri.yes': 'Yes',
  'filters.try.tri.no': 'No',
  'filters.try.button': 'Check this update',
  'filters.try.invalid': 'Fix the highlighted filters above first, then try again.',
  'filters.result.sent': 'Sent. None of your filters hold this update back.',
  'filters.result.sentGhost': 'Sent. It came from a deleted account, which filters never skip.',
  'filters.result.skipped': 'Skipped by the “{filter}” filter, because {reason}.',

  'filters.reason.not_in_allow_list': 'it is not on your “only” list',
  'filters.reason.in_deny_list': 'it is on your “never” list',
  'filters.reason.draft_excluded': 'it is a draft pull request',
  'filters.reason.bot_excluded': 'it came from a bot',
  'filters.reason.not_a_bot': 'it did not come from a bot',
  'filters.reason.ghost_exempt': 'it came from a deleted account',
  'filters.reason.allowed': 'it passed',
  'filters.reason.not_applicable': 'this filter does not apply to this kind of update',
  'filters.reason.config_invalid': 'its stored filters could not be read, so it was held back to be safe',

  'filters.log.title': 'Recent decisions',
  'filters.log.intro':
    'The most recent updates Noti considered for this integration, and whether they were sent or held back. Kept for 30 days. It records the event type and the reason, never the content.',
  'filters.log.empty':
    'Nothing yet. Updates appear here after Noti receives one this integration subscribes to.',
  'filters.log.loading': 'Loading recent decisions…',
  'filters.log.error': 'We couldn’t load recent decisions. Your filters are not affected.',
  'filters.log.more': 'Show older decisions',
  'filters.log.sent': 'Sent',
  'filters.log.skipped': 'Held back',
  'filters.log.unknownNote': 'A detail was missing',
  'filters.log.entry': '{event}, {outcome}, {when}',
  'filters.reason.unknown_fact':
    'GitHub did not report the detail this filter checks, so the update was held back to be safe',
  'filters.reason.config_newer':
    'its filters were saved by a newer version of Noti that this one cannot read, so nothing was held back',
  'filters.name.config': 'Stored filters',
  'filters.replaceInvalid': 'Replace invalid filters',
  'filters.newer.title': 'These filters were saved by a newer version of Noti',
  'filters.newer.body':
    'This version can’t read them, so it is sending every update you chose. Saving filters here replaces them.',
  'filters.appliesTo.branch':
    'Applies to: pushes, pull requests, workflow runs, releases and deployments. For a release or deployment, only when GitHub names a branch.',
  'filters.appliesTo.base': 'Applies to: pull requests.',
  'filters.appliesTo.people':
    'Applies to: every update. “Bots” checks who caused the update (the sender), not who wrote a pull request: a bot’s pull request merged by a person is not skipped.',
  'filters.appliesTo.drafts': 'Applies to: pull requests.',
  'filters.appliesTo.labels': 'Applies to: issues, issue comments and pull requests.',
  'filters.coverage.blocking':
    'The “only” list in “{filter}” can’t be applied to: {events}. It would not be enforced for them. Remove those updates under “Updates to send”, or remove the list.',
  'filters.coverage.warning':
    'The “{filter}” filter does not apply to: {events}. Those updates are sent regardless.',
  'filters.error.coverageEvents':
    'Your filters can’t be applied to some of these updates ({filters}). Remove those updates, or change the filters first.',
  'filters.caseNote':
    'Branch and label names are compared without regard to capital letters, so “Main” and “main” are the same.',
} as const satisfies Record<string, string | PluralMessage>;
