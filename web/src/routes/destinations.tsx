import { createFileRoute } from '@tanstack/react-router';
import { DestinationsHealthPage } from '../destinations/DestinationsHealthPage';

/** Each integration's destination with its health as the server reports it (ADR 0056, F205). */
export const Route = createFileRoute('/destinations')({ component: DestinationsHealthPage });
