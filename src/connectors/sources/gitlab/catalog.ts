import { GITLAB_DESCRIPTORS } from '../../../events/catalog';

/**
 * The closed set of GitLab notification types an integration can select (spec 06 F83, a
 * deliberately small subset of the F83 list). Classification starts from the `X-Gitlab-Event`
 * header and, where GitLab puts the action in the body, `object_attributes.action`; a verified
 * event outside this set is acknowledged and ignored, never rejected.
 *
 * Not offered yet (named, not hidden): `Note Hook`, `Job Hook`, `Release Hook`, `Wiki Page Hook`,
 * `Milestone Hook`, `Emoji Hook`, merge request `update`/approval actions (GitLab sends `update`
 * even when `changes` is empty, so it has no single canonical meaning), group-only hooks.
 *
 * Derived from the event-type registry (src/events/catalog.ts).
 */
export type GitlabEventType = (typeof GITLAB_DESCRIPTORS)[number]['type'];

export const GITLAB_EVENT_TYPES: readonly GitlabEventType[] = GITLAB_DESCRIPTORS.map((d) => d.type);

/** Instance GitLab.com sends in `X-Gitlab-Instance`. Self-managed instances are not supported yet. */
export const GITLAB_COM_HOST = 'gitlab.com';
