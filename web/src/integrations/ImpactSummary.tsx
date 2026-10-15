import { formatNumber, t, tp, type MessageId } from '../i18n';
import { useLocale } from '../i18n/LocaleProvider';
import type { BoundedCount, IntegrationImpact } from '../lib/api';

export type ImpactAction = 'pause' | 'delete';

interface ImpactSummaryProps {
  readonly action: ImpactAction;
  readonly impact: IntegrationImpact | undefined;
  readonly isPending: boolean;
  readonly isError: boolean;
}

/** "1,284", or "More than 10,000" when the server stopped counting at its cap. */
function amount({ count, capped }: BoundedCount): string {
  return capped ? t('impact.moreThan', { count }) : formatNumber(count);
}

const COPY: Readonly<Record<ImpactAction, Readonly<Record<'unsent' | 'held' | 'history', MessageId>>>> = {
  pause: { unsent: 'impact.pause.unsent', held: 'impact.pause.held', history: 'impact.pause.history' },
  delete: { unsent: 'impact.delete.unsent', held: 'impact.delete.held', history: 'impact.delete.history' },
};

/**
 * The consequence of pausing or deleting, in counts the server took (F217, ADR 0050). Each line is
 * one fact about one group of rows and what happens to it; a group with nothing in it is left out
 * rather than shown as "0 …". While the count is on its way the list says so; if it fails, the
 * dialog says the number is unknown instead of showing a zero it did not measure.
 */
export function ImpactSummary({ action, impact, isPending, isError }: ImpactSummaryProps) {
  useLocale();
  // One live region that stays mounted, so the counts are announced when they arrive.
  return (
    <div className="impact" role="status">
      <p className="impact-title">{t('impact.title')}</p>
      <ImpactBody action={action} impact={impact} isPending={isPending} isError={isError} />
    </div>
  );
}

function ImpactBody({ action, impact, isPending, isError }: ImpactSummaryProps) {
  useLocale();
  if (isError) return <p>{t(action === 'pause' ? 'impact.error.pause' : 'impact.error.delete')}</p>;
  if (isPending || !impact) return <p className="muted">{t('impact.counting')}</p>;
  const copy = COPY[action];
  // A pause keeps saved updates; one that already failed to release stays failed and is not mentioned.
  const held = action === 'pause' ? impact.heldWaiting : impact.heldWaiting + impact.heldFailed;
  const lines: string[] = [];
  if (impact.unsent.count === 0 && impact.sending.count === 0) lines.push(t('impact.unsent.none'));
  if (impact.unsent.count > 0)
    lines.push(tp(copy.unsent, impact.unsent.count, { amount: amount(impact.unsent) }));
  if (impact.sending.count > 0)
    lines.push(tp('impact.sending', impact.sending.count, { amount: amount(impact.sending) }));
  if (held > 0) lines.push(tp(copy.held, held, { amount: formatNumber(held) }));
  if (impact.total.count > 0)
    lines.push(tp(copy.history, impact.total.count, { amount: amount(impact.total) }));
  if (action === 'delete') lines.push(t('impact.delete.log'));
  return (
    <ul className="impact-list">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}
