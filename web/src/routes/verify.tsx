import { createFileRoute } from '@tanstack/react-router';
import { VerifyPage } from '../pages';

export const Route = createFileRoute('/verify')({ component: VerifyPage });
