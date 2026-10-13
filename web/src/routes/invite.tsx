import { createFileRoute } from '@tanstack/react-router';
import { InvitePage } from '../onboarding';

export const Route = createFileRoute('/invite')({ component: InvitePage });
