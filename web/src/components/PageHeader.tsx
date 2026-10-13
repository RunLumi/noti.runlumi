import type { ReactNode } from 'react';
import { useLocale } from '../i18n/LocaleProvider';

interface PageHeaderProps {
  readonly eyebrow: string;
  readonly title: string;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  /** Rendered above the eyebrow, e.g. a back link. */
  readonly before?: ReactNode;
}

export function PageHeader({ eyebrow, title, description, action, before }: PageHeaderProps) {
  useLocale();
  return (
    <div className="page-header">
      <div>
        {before}
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {description && <p className="muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}
