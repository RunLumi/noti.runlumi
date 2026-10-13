import { createFileRoute } from '@tanstack/react-router';
import { Team } from '../pages';

export const Route = createFileRoute('/team')({ component: Team });
