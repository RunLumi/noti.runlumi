import { createFileRoute } from '@tanstack/react-router';
import { SourceDetailPage } from '../sources/SourceDetailPage';

/** A source's own address (ADR 0056); an id the workspace does not own renders the shell 404. */
export const Route = createFileRoute('/sources/$sourceId')({ component: SourceDetailPage });
