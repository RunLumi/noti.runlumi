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
    'Filters never add updates and never change who can see them; they only hold back updates this integration would have sent. Noti keeps a short log of what was held back and why.',

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
  'filters.invalidStored.title': 'These filters can’t be read, so they are not being applied',
  'filters.invalidStored.body':
    'Noti is sending every update you chose rather than risk silently hiding one. Saving filters again replaces what is stored.',

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
  'filters.result.sentUnknown':
    'Sent. A detail a filter needed was not reported, and that filter does not skip on missing details.',
  'filters.result.sentGhost': 'Sent. It came from a deleted account, which filters never skip.',
  'filters.result.skipped': 'Skipped by the “{filter}” filter, because {reason}.',

  'filters.reason.not_in_allow_list': 'it is not on your “only” list',
  'filters.reason.in_deny_list': 'it is on your “never” list',
  'filters.reason.field_unknown':
    'GitHub did not report the detail, so Noti can’t confirm it is on your “only” list',
  'filters.reason.draft_excluded': 'it is a draft pull request',
  'filters.reason.bot_excluded': 'it came from a bot',
  'filters.reason.not_a_bot': 'it did not come from a bot',
  'filters.reason.ghost_exempt': 'it came from a deleted account',
  'filters.reason.allowed': 'it passed',
  'filters.reason.not_applicable': 'this filter does not apply to this kind of update',
  'filters.reason.no_filters': 'this integration has no filters',
  'filters.reason.config_invalid': 'its stored filters could not be read, so nothing was held back',

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
} as const satisfies Record<string, string | PluralMessage>;
