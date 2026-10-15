import { createFileRoute } from '@tanstack/react-router';
import { SourcesPage } from '../sources/SourcesPage';

export const Route = createFileRoute('/sources/')({ component: SourcesPage });
