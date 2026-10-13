import { createFileRoute } from '@tanstack/react-router';
import { IntegrationSettings } from '../integrations/settings/IntegrationSettings';

export const Route = createFileRoute('/integrations/$id')({
  component: IntegrationSettings,
  // `created` only selects a confirmation message; nothing sensitive is ever in the URL.
  validateSearch: (search: Record<string, unknown>): { created?: boolean } =>
    search.created === true || search.created === 'true' ? { created: true } : {},
});
