import { createFileRoute } from '@tanstack/react-router';
import { AuthPage } from '../pages';

export const Route = createFileRoute('/signin')({
  component: () => <AuthPage mode="signin" />,
  // Carried through as text; `safeReturnTo` decides after sign-in whether it may be followed.
  validateSearch: (search: Record<string, unknown>): { returnTo?: string } =>
    typeof search.returnTo === 'string' ? { returnTo: search.returnTo } : {},
});
