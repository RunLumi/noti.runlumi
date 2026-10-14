import { createFileRoute } from '@tanstack/react-router';
import { AuditPage } from '../audit/AuditPage';
import { validateAuditSearch } from '../audit/search';

export const Route = createFileRoute('/audit')({
  component: AuditPage,
  // Filters live in the URL so a link shows exactly what the sender saw.
  validateSearch: validateAuditSearch,
});
