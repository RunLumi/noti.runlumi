import { createFileRoute } from '@tanstack/react-router';
import { SetupResume } from '../setup/SetupResume';

export const Route = createFileRoute('/setup/')({ component: SetupResume });
