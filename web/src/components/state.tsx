import type { ReactNode } from 'react';
import { useId } from 'react';
import { useLocale } from '../i18n/LocaleProvider';
import './state.css';
import '../integrations/integrations.css';

/**
 * The three states every list and page has besides "loaded" (spec 14 F225): waiting, nothing
 * here yet, and could not load. They are shared so a screen can't invent its own wording
 * or layout for them.
 */

interface SkeletonProps {
  /** What is loading, spoken to assistive technology ("Loading integrations…"). */
  readonly label: string;
  /** Number of placeholder rows. */
  readonly rows?: number;
}

/**
 * Placeholder rows shaped like the content. The container is `aria-busy` and named; the
 * decorative bars are hidden from assistive technology so nothing reads as empty content.
 * The shimmer stops under `prefers-reduced-motion`.
 */
export function Skeleton({ label, rows = 3 }: SkeletonProps) {
  useLocale();
  return (
    <div className="state-skeleton" aria-busy="true" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="state-skeleton-row" aria-hidden="true">
          <span className="skeleton skeleton-title" />
          <span className="skeleton skeleton-line" />
        </div>
      ))}
    </div>
  );
}

interface EmptyStateProps {
  readonly icon: ReactNode;
  readonly title: string;
  /** One or two sentences: what this place is for and what to do to fill it. */
  readonly children?: ReactNode;
  /** The one thing to do next. */
  readonly action?: ReactNode;
  /** Heading level; pages put the empty state under their `h1`, a page that is only this state is the `h1`. */
  readonly level?: 1 | 2 | 3;
}

/** Nothing here yet: a heading that names the situation, a sentence of help and one action. */
export function EmptyState({ icon, title, children, action, level = 2 }: EmptyStateProps) {
  useLocale();
  const titleId = useId();
  const Heading = level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3';
  return (
    <section className="empty state-empty" aria-labelledby={titleId}>
      <div className="empty-icon" aria-hidden="true">
        {icon}
      </div>
      <Heading id={titleId}>{title}</Heading>
      {children && <div className="state-empty-body">{children}</div>}
      {action && <div className="state-empty-action">{action}</div>}
    </section>
  );
}
