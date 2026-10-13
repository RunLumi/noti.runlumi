import { createFileRoute } from '@tanstack/react-router';
import { ResetPage } from '../pages';

export const Route = createFileRoute('/reset')({ component: ResetPage });
