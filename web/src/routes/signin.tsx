import { createFileRoute } from '@tanstack/react-router';
import { AuthPage } from '../pages';

export const Route = createFileRoute('/signin')({
  component: () => <AuthPage mode="signin" />,
});
