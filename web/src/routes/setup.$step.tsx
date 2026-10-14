import { createFileRoute } from '@tanstack/react-router';
import { SetupFlow } from '../setup/SetupFlow';

/** `github` is GitHub's status code on return from the install trip; any other value is dropped. */
const RETURN_CODE = /^[a-z_]{1,40}$/;

export const Route = createFileRoute('/setup/$step')({
  component: SetupFlow,
  validateSearch: (search: Record<string, unknown>): { github?: string } =>
    typeof search.github === 'string' && RETURN_CODE.test(search.github) ? { github: search.github } : {},
});
