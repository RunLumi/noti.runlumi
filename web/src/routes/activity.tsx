import { createFileRoute } from '@tanstack/react-router';
import { Activity } from '../pages';
import { validateActivitySearch } from '../deliveries/search';

export const Route = createFileRoute('/activity')({
  component: Activity,
  // Filters live in the URL so a link shows exactly what the sender saw (F213).
  validateSearch: validateActivitySearch,
});
