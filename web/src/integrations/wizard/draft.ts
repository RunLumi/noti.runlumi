import type { CreateIntegrationBody, DestinationKind, GithubInstallation } from '../../lib/api';
import type { MessageId } from '../../i18n';
import { t } from '../../i18n';
import { DEFAULT_EVENTS, type GithubEventType } from '../events';
import { isCovered } from '../github/coverage';
import { EMPTY_FILTER_DRAFT, filterCount, validateFilterDraft, type FilterDraft } from '../filters/model';
import {
  compact,
  validateEvents,
  validateName,
  validateRepo,
  validateSigningSecret,
  validateWebhookUrl,
  type FieldErrors,
  type FormField,
} from '../validation';

/** Everything the wizard collects. Kept in memory only; never in the URL or storage. */
export interface Draft {
  readonly destination: DestinationKind | null;
  readonly webhookUrl: string;
  readonly signingSecret: string;
  readonly repo: string;
  /** Set when the repository is typed under an `all` installation's account. */
  readonly repoAccount: string | null;
  readonly name: string;
  readonly eventTypes: readonly GithubEventType[];
  /** Optional routing filters, as typed. Empty means none. */
  readonly filters: FilterDraft;
}

export type WizardField = FormField | 'destination';
export type WizardErrors = FieldErrors & { destination?: string };

export const EMPTY_DRAFT: Draft = {
  destination: null,
  webhookUrl: '',
  signingSecret: '',
  repo: '',
  repoAccount: null,
  name: '',
  eventTypes: DEFAULT_EVENTS,
  filters: EMPTY_FILTER_DRAFT,
};

/**
 * Repository first: it needs a GitHub connection, which is a full-page trip to GitHub, so it
 * happens before anything has been typed that the trip would lose.
 */
export const STEPS: readonly MessageId[] = [
  'wizard.step.source',
  'wizard.step.destination',
  'wizard.step.webhook',
  'wizard.step.events',
  'wizard.step.filters',
  'wizard.step.review',
];

/** Which step owns a field, so a server error can send the person back to the right place. */
const STEP_OF: Readonly<Record<WizardField, number>> = {
  repo: 0,
  name: 0,
  destination: 1,
  webhookUrl: 2,
  signingSecret: 2,
  eventTypes: 3,
  filters: 4,
};

export function stepOf(field: WizardField): number {
  return STEP_OF[field];
}

export function earliestStep(errors: WizardErrors, fallback: number): number {
  const steps = (Object.keys(errors) as WizardField[]).map(stepOf);
  return steps.length ? Math.min(...steps) : fallback;
}

/** The repository must be well formed and visible through an active installation. */
export function validateRepoChoice(
  repo: string,
  installations: readonly GithubInstallation[],
): string | undefined {
  return validateRepo(repo) ?? (isCovered(repo, installations) ? undefined : t('validation.repoNotCovered'));
}

/** Validate only what the given step asks for. */
export function validateStep(
  step: number,
  draft: Draft,
  installations: readonly GithubInstallation[],
): WizardErrors {
  switch (step) {
    case 0:
      return compact({
        repo: validateRepoChoice(draft.repo, installations),
        name: draft.name.trim() === '' ? undefined : validateName(draft.name),
      });
    case 1:
      return draft.destination ? {} : { destination: t('validation.destination') };
    case 2:
      if (!draft.destination) return { destination: t('validation.destination') };
      return compact({
        webhookUrl: validateWebhookUrl(draft.webhookUrl, draft.destination),
        signingSecret: draft.destination === 'lark' ? validateSigningSecret(draft.signingSecret) : undefined,
      });
    case 3:
      return compact({ eventTypes: validateEvents(draft.eventTypes) });
    case 4: {
      const checked = validateFilterDraft(draft.filters, draft.eventTypes);
      // The step shows each message beside its control; this carries only "has errors".
      return checked.ok ? {} : { filters: Object.values(checked.errors)[0] ?? t('filters.error.generic') };
    }
    default:
      return {};
  }
}

export function validateAll(draft: Draft, installations: readonly GithubInstallation[]): WizardErrors {
  return STEPS.reduce<WizardErrors>(
    (all, _step, index) => ({ ...validateStep(index, draft, installations), ...all }),
    {},
  );
}

const NAME_MAX = 80;

/** Filters are sent only when there are some, so an untouched step changes nothing. */
function filtersBody(draft: FilterDraft): Pick<CreateIntegrationBody, 'filters'> {
  const checked = validateFilterDraft(draft);
  return checked.ok && filterCount(checked.config) > 0 ? { filters: checked.config } : {};
}

/** The request body. A blank name falls back to the repository, cut to the name limit. */
export function toBody(draft: Draft & { destination: DestinationKind }): CreateIntegrationBody {
  return {
    name: draft.name.trim() || draft.repo.slice(0, NAME_MAX),
    repo: draft.repo,
    eventTypes: draft.eventTypes,
    destination: draft.destination,
    webhookUrl: draft.webhookUrl,
    ...(draft.destination === 'lark' && draft.signingSecret !== ''
      ? { signingSecret: draft.signingSecret }
      : {}),
    ...filtersBody(draft.filters),
  };
}

/** True once the person has typed or chosen anything worth warning about on leave. */
export function isDirty(draft: Draft): boolean {
  return (
    draft.destination !== null ||
    draft.webhookUrl !== '' ||
    draft.signingSecret !== '' ||
    draft.repo !== '' ||
    draft.name !== ''
  );
}
