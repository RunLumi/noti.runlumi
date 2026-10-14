import type { MessageId } from '../i18n';
import type { SetupStepId } from './api';

/**
 * The pages of the `/setup` route space. The server's seven steps (ADR 0025) are the model;
 * `workspace_created` is always done and has no page of its own, so six steps are pages. Each
 * page is a path (`/setup/destination`) so it can be bookmarked, shared with a colleague and
 * reached with the browser's Back and Forward buttons.
 */
export const SETUP_SLUGS = ['github', 'repository', 'destination', 'events', 'test', 'done'] as const;
export type SetupSlug = (typeof SETUP_SLUGS)[number];

export const isSetupSlug = (value: unknown): value is SetupSlug => SETUP_SLUGS.some((s) => s === value);

interface PageDef {
  readonly step: SetupStepId;
  readonly title: MessageId;
  readonly description: MessageId;
}

export const SETUP_PAGES: Readonly<Record<SetupSlug, PageDef>> = {
  github: { step: 'github_connected', title: 'setup.page.github', description: 'setup.flow.desc.github' },
  repository: {
    step: 'repositories_selected',
    title: 'setup.page.repository',
    description: 'setup.flow.desc.repository',
  },
  destination: {
    step: 'destination_connected',
    title: 'setup.page.destination',
    description: 'setup.flow.desc.destination',
  },
  events: { step: 'events_chosen', title: 'setup.page.events', description: 'setup.flow.desc.events' },
  test: { step: 'test_delivered', title: 'setup.page.test', description: 'setup.flow.desc.test' },
  done: { step: 'activated', title: 'setup.page.done', description: 'setup.flow.desc.done' },
};

/** The page that works on a server step; the always-done first step opens the first page. */
export function slugForStep(step: SetupStepId): SetupSlug {
  return SETUP_SLUGS.find((slug) => SETUP_PAGES[slug].step === step) ?? 'github';
}

/** Title of every step as the stepper shows it, including the one with no page. */
export const STEP_TITLE: Readonly<Record<SetupStepId, MessageId>> = {
  workspace_created: 'setup.step.workspace_created',
  github_connected: 'setup.step.github_connected',
  repositories_selected: 'setup.step.repositories_selected',
  destination_connected: 'setup.step.destination_connected',
  events_chosen: 'setup.step.events_chosen',
  test_delivered: 'setup.step.test_delivered',
  activated: 'setup.step.activated',
};
