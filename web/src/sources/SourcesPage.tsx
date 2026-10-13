import { useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { IconPlus, IconRefresh, IconPlugConnected } from '@tabler/icons-react';
import { Field, focusFirstInvalid } from '../components/form';
import { PageHeader } from '../components/PageHeader';
import { Button, Input, Notice } from '../components/ui';
import { authApi } from '../lib/api';
import { t, tp } from '../i18n';
import { describeError, fieldErrorsOf } from '../integrations/errors';
import { useOrgId } from '../integrations/hooks';
import { fromServer, validateName } from '../integrations/validation';
import '../integrations/integrations.css';
import type { SourceWithSecret } from './api';
import { useCreateSource, useSources } from './hooks';
import { SecretReveal } from './SecretReveal';
import { SourceCard } from './SourceCard';
import './sources.css';

interface Reveal {
  readonly kind: 'created' | 'rotated';
  readonly result: SourceWithSecret;
}

function CreateForm({
  orgId,
  onCreated,
}: {
  readonly orgId: string;
  readonly onCreated: (r: SourceWithSecret) => void;
}) {
  const create = useCreateSource(orgId);
  const formRef = useRef<HTMLFormElement>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    const local = validateName(name);
    setError(local);
    if (local) {
      focusFirstInvalid(formRef.current);
      return;
    }
    try {
      onCreated(await create.mutateAsync(name.trim()));
      setName('');
    } catch (failure) {
      setError(fromServer(fieldErrorsOf(failure)).fields.name);
      focusFirstInvalid(formRef.current);
    }
  };
  const failure = create.isError && !error ? describeError(create.error) : null;
  return (
    <section className="source-create" aria-labelledby="source-create-title">
      <h2 id="source-create-title">{t('sources.create.title')}</h2>
      <form ref={formRef} className="source-create-form" noValidate onSubmit={(e) => void onSubmit(e)}>
        <Field label={t('sources.create.label')} hint={t('sources.create.hint')} error={error}>
          {(ids) => (
            <Input
              id={ids.inputId}
              aria-describedby={ids.describedBy}
              aria-invalid={ids.invalid || undefined}
              value={name}
              maxLength={80}
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" aria-disabled={create.isPending || undefined}>
          <IconPlus size={18} aria-hidden="true" />
          {create.isPending ? t('sources.create.submitting') : t('sources.create.submit')}
        </Button>
      </form>
      {failure && (
        <Notice kind="error">
          <p className="notice-title">{t('sources.create.failed')}</p>
          <p>{failure.message}</p>
          {failure.reference && <p className="error-reference">{failure.reference}</p>}
        </Notice>
      )}
    </section>
  );
}

function ListSkeleton() {
  return (
    <div className="integration-list" aria-busy="true" aria-label={t('sources.loading')}>
      {[0, 1].map((i) => (
        <div key={i} className="integration-card skeleton-card" aria-hidden="true">
          <span className="skeleton skeleton-title" />
          <span className="skeleton skeleton-line" />
          <span className="skeleton skeleton-line skeleton-short" />
        </div>
      ))}
    </div>
  );
}

export function SourcesPage() {
  const orgId = useOrgId();
  const list = useSources(orgId);
  const me = useQuery({ queryKey: ['me'], queryFn: authApi.me });
  const isAdmin = me.data?.user.role === 'admin';
  // The secret lives only here, in memory. Dismissing it, or leaving the page, discards it.
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const sources = list.data ?? [];
  return (
    <>
      <PageHeader
        eyebrow={t('sources.eyebrow')}
        title={t('sources.title')}
        description={t('sources.description')}
      />
      {reveal && (
        <SecretReveal
          key={reveal.result.source.id + reveal.kind}
          sourceName={reveal.result.source.name}
          secret={reveal.result.secret}
          kind={reveal.kind}
          onDismiss={() => setReveal(null)}
        />
      )}
      {orgId && <CreateForm orgId={orgId} onCreated={(result) => setReveal({ kind: 'created', result })} />}
      {list.isPending ? (
        <ListSkeleton />
      ) : list.isError ? (
        // A failed query is an error, never an empty list.
        <Notice kind="error">
          <p className="notice-title">{t('sources.error.title')}</p>
          <p>
            {describeError(list.error).message} {t('sources.error.body')}
          </p>
          <Button variant="outline" onClick={() => void list.refetch()} disabled={list.isFetching}>
            <IconRefresh size={18} aria-hidden="true" />
            {t('sources.retry')}
          </Button>
        </Notice>
      ) : sources.length === 0 ? (
        <section className="empty integrations-empty" aria-labelledby="sources-empty-title">
          <div className="empty-icon">
            <IconPlugConnected size={24} aria-hidden="true" />
          </div>
          <h2 id="sources-empty-title">{t('sources.empty.title')}</h2>
          <p>{t('sources.empty.body')}</p>
        </section>
      ) : (
        <section aria-labelledby="sources-list-title">
          <div className="list-summary">
            <h2 id="sources-list-title">{tp('sources.count', sources.length)}</h2>
          </div>
          <div className="integration-list" aria-label={t('sources.listLabel')}>
            {sources.map((source) => (
              <SourceCard
                key={source.id}
                orgId={orgId ?? ''}
                source={source}
                isAdmin={isAdmin}
                onRotated={(result) => setReveal({ kind: 'rotated', result })}
              />
            ))}
          </div>
        </section>
      )}
    </>
  );
}
