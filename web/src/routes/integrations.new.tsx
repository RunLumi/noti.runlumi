import { createFileRoute } from '@tanstack/react-router';
import { CreateWizard } from '../integrations/wizard/CreateWizard';

export const Route = createFileRoute('/integrations/new')({ component: CreateWizard });
