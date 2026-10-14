import { Link } from '@tanstack/react-router';
import { IconTool } from '@tabler/icons-react';
import { Notice } from '../../components/ui';
import { t, type MessageId } from '../../i18n';
import { useLocale } from '../../i18n/LocaleProvider';
import type { Repair, RepairKind } from './repair';

const COPY: Readonly<Record<RepairKind, { title: MessageId; body: MessageId; action: MessageId }>> = {
  quarantined: {
    title: 'repair.quarantined.title',
    body: 'repair.quarantined.body',
    action: 'repair.quarantined.action',
  },
  destination_rejected: {
    title: 'repair.rejected.title',
    body: 'repair.rejected.body',
    action: 'repair.rejected.action',
  },
  breaker_open: {
    title: 'repair.breaker.title',
    body: 'repair.breaker.body',
    action: 'repair.breaker.action',
  },
  filters_unreadable: {
    title: 'repair.filters.title',
    body: 'repair.filters.body',
    action: 'repair.filters.action',
  },
  noise_unreadable: {
    title: 'repair.noise.title',
    body: 'repair.noise.body',
    action: 'repair.noise.action',
  },
};

/**
 * One warning per thing that needs fixing, each with the single action that fixes it and a link
 * to the section where it is done. The first thing to read on the page when something is wrong
 * (F217); it renders nothing when nothing is.
 */
export function RepairPanel({
  repairs,
  integrationId,
}: {
  repairs: readonly Repair[];
  integrationId: string;
}) {
  useLocale();
  if (repairs.length === 0) return null;
  return (
    <section className="repair-panel" aria-labelledby="repair-title">
      <h2 id="repair-title" className="repair-title">
        <IconTool size={20} aria-hidden="true" />
        {t('repair.title')}
      </h2>
      {repairs.map((repair) => {
        const copy = COPY[repair.kind];
        return (
          <Notice key={repair.kind} kind="warning">
            <p className="notice-title">{t(copy.title)}</p>
            <p>{t(copy.body)}</p>
            <p>
              <Link
                to="/integrations/$id"
                params={{ id: integrationId }}
                hash={repair.target}
                className="text-link"
              >
                {t(copy.action)}
              </Link>
            </p>
          </Notice>
        );
      })}
    </section>
  );
}
