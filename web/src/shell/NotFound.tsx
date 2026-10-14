import { Link } from '@tanstack/react-router';
import { IconCompass } from '@tabler/icons-react';
import { EmptyState } from '../components/state';
import { t } from '../i18n';
import { useLocale } from '../i18n/LocaleProvider';

/**
 * The page for an address nothing answers (spec 14 F205). It is drawn inside the shell for a
 * signed-in person (the sidebar is still there to get out) and without chrome otherwise; it
 * never redirects, because sending someone to the Overview hides that their link was wrong.
 */
export function RootNotFound() {
  useLocale();
  return (
    <div className="not-found">
      <EmptyState
        level={1}
        icon={<IconCompass size={24} />}
        title={t('notFound.title')}
        action={
          <Link to="/" className="btn btn-primary">
            {t('notFound.home')}
          </Link>
        }
      >
        <p>{t('notFound.body')}</p>
      </EmptyState>
    </div>
  );
}
