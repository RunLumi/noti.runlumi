import { StaleWorkspaceNotice, useBoundWorkspace } from '../workspace/bound';
import { useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { IconPlus, IconRefresh, IconPlugConnected } from '@tabler/icons-react';
import { Field, SecretInput, focusFirstInvalid } from '../components/form';
import { PageHeader } from '../components/PageHeader';
import { EmptyState, Skeleton } from '../components/state';
import { Button, Input, Notice } from '../components/ui';
import { authApi } from '../lib/api';
import { t, tp } from '../i18n';
import { describeError, fieldErrorsOf } from '../integrations/errors';
import { useOrgId } from '../integrations/hooks';
import { validateName } from '../integrations/validation';
import '../integrations/integrations.css';
import type { SourceWithSecret } from './api';
import {
  EMPTY_DRAFT,
  KIND_LABEL,
  KIND_ORDER,
  SERVER_FIELDS,
  isProviderKind,
  toCreateBody,
  validateCreate,
  type AuthMode,
  type CreateDraft,
  type CreateErrors,
  type SourceKind,
} from './providers';
import { useCreateSource, useSources } from './hooks';
import { SecretReveal } from './SecretReveal';
import { SourceCard } from './SourceCard';
import './sources.css';
import { useLocale } from '../i18n/LocaleProvider';

interface Reveal {
  readonly kind: 'created' | 'rotated';
  readonly source: SourceWithSecret['source'];
  readonly secret: string;
}

/** What to show after a create or rotate: a one-time secret (generic) or a plain notice (providers). */
export type Outcome =
  | { readonly type: 'reveal'; readonly reveal: Reveal }
  | { readonly type: 'notice'; readonly message: string };

export function outcomeOf(kind: 'created' | 'rotated', result: SourceWithSecret): Outcome {
  if (result.secret !== null)
    return { type: 'reveal', reveal: { kind, source: result.source, secret: result.secret } };
  const provider = t(KIND_LABEL[result.source.kind].name);
  return {
    type: 'notice',
    message:
      kind === 'created'
        ? t('sources.created.provider', { name: result.source.name, provider })
        : t('sources.replaced.provider', { name: result.source.name }),
  };
}

function RadioGroup<T extends string | boolean>({
  legend,
  name,
  value,
  options,
  error,
  onChange,
}: {
  readonly legend: string;
  readonly name: string;
  readonly value: T | null;
  readonly options: readonly { readonly value: T; readonly label: string; readonly where: string }[];
  readonly error?: string | undefined;
  readonly onChange: (value: T) => void;
}) {
  useLocale();
  return (
    <fieldset className="destination-choice">
      <legend className="field-label">{legend}</legend>
      {error && (
        <p className="field-error" role="alert">
          <span>{error}</span>
        </p>
      )}
      <div className="destination-options">
        {options.map((o) => (
          <label key={String(o.value)} className="destination-option">
            <input
              type="radio"
              name={name}
              checked={value === o.value}
              aria-invalid={error ? true : undefined}
              data-invalid={error ? '' : undefined}
              onChange={() => onChange(o.value)}
            />
            <span className="destination-option-body">
              <span className="destination-option-name">{o.label}</span>
              <span className="destination-option-where">{o.where}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function CreateForm({
  orgId: liveOrgId,
  onCreated,
}: {
  readonly orgId: string;
  readonly onCreated: (r: SourceWithSecret) => void;
}) {
  useLocale();
  const ws = useBoundWorkspace(liveOrgId);
  const create = useCreateSource(ws.orgId);
  const formRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<CreateDraft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<CreateErrors>({});
  const patch = (next: Partial<CreateDraft>) => setDraft((d) => ({ ...d, ...next }));
  const pickKind = (kind: SourceKind) => patch({ kind, authMode: null, livemode: null, secret: '' });

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending || ws.stale) return;
    const local = validateCreate(draft, validateName(draft.name));
    setErrors(local);
    if (Object.keys(local).length > 0) {
      focusFirstInvalid(formRef.current);
      return;
    }
    try {
      onCreated(await create.mutateAsync(toCreateBody(draft)));
      // Credentials are write-only: nothing typed is kept once saved.
      setDraft({ ...EMPTY_DRAFT, kind: draft.kind });
    } catch (failure) {
      const mapped: { -readonly [K in keyof CreateErrors]: CreateErrors[K] } = {};
      for (const f of fieldErrorsOf(failure)) {
        const field = (SERVER_FIELDS as readonly string[]).includes(f.field)
          ? (f.field as keyof CreateErrors)
          : null;
        if (field) mapped[field] ??= f.message;
      }
      setErrors(mapped);
      focusFirstInvalid(formRef.current);
    }
  };
  const failure = create.isError && Object.keys(errors).length === 0 ? describeError(create.error) : null;
  const provider = isProviderKind(draft.kind) ? draft.kind : null;
  return (
    <section className="source-create" aria-labelledby="source-create-title">
      <h2 id="source-create-title">{t('sources.create.title')}</h2>
      <form ref={formRef} className="source-create-form" noValidate onSubmit={(e) => void onSubmit(e)}>
        <StaleWorkspaceNotice show={ws.stale} />
        <RadioGroup<SourceKind>
          legend={t('sources.kind.legend')}
          name="source-kind"
          value={draft.kind}
          options={KIND_ORDER.map((kind) => ({
            value: kind,
            label: t(KIND_LABEL[kind].name),
            where: t(KIND_LABEL[kind].where),
          }))}
          onChange={pickKind}
        />
        <Field label={t('sources.create.label')} hint={t('sources.create.hint')} error={errors.name}>
          {(ids) => (
            <Input
              id={ids.inputId}
              aria-describedby={ids.describedBy}
              aria-invalid={ids.invalid || undefined}
              value={draft.name}
              maxLength={80}
              autoComplete="off"
              onChange={(e) => patch({ name: e.target.value })}
            />
          )}
        </Field>
        {draft.kind === 'gitlab' && (
          <RadioGroup<AuthMode>
            legend={t('sources.gitlab.auth.legend')}
            name="gitlab-auth"
            value={draft.authMode}
            error={errors.authMode}
            options={[
              {
                value: 'signing_token',
                label: t('sources.gitlab.auth.signing'),
                where: t('sources.gitlab.auth.signing.where'),
              },
              {
                value: 'secret_token',
                label: t('sources.gitlab.auth.secret'),
                where: t('sources.gitlab.auth.secret.where'),
              },
            ]}
            onChange={(authMode) => patch({ authMode })}
          />
        )}
        {draft.kind === 'stripe' && (
          <>
            <RadioGroup<boolean>
              legend={t('sources.stripe.mode.legend')}
              name="stripe-mode"
              value={draft.livemode}
              error={errors.livemode}
              options={[
                {
                  value: false,
                  label: t('sources.stripe.mode.test'),
                  where: t('sources.stripe.mode.test.where'),
                },
                {
                  value: true,
                  label: t('sources.stripe.mode.live'),
                  where: t('sources.stripe.mode.live.where'),
                },
              ]}
              onChange={(livemode) => patch({ livemode })}
            />
            <p className="field-hint">{t('sources.stripe.mode.hint')}</p>
          </>
        )}
        {provider && (draft.kind === 'stripe' || draft.authMode !== null) && (
          <Field
            label={t(provider === 'gitlab' ? 'sources.paste.gitlab.label' : 'sources.paste.stripe.label')}
            hint={
              <>
                {t(
                  provider === 'stripe'
                    ? 'sources.paste.stripe.hint'
                    : draft.authMode === 'signing_token'
                      ? 'sources.paste.gitlab.hintSigning'
                      : 'sources.paste.gitlab.hintSecret',
                )}{' '}
                {t('sources.paste.stored')}
              </>
            }
            error={errors.secret}
          >
            {(ids) => (
              <SecretInput
                ids={ids}
                fieldName={t(
                  provider === 'gitlab' ? 'sources.paste.gitlab.label' : 'sources.paste.stripe.label',
                )}
                value={draft.secret}
                onChange={(e) => patch({ secret: e.target.value })}
              />
            )}
          </Field>
        )}
        <Button type="submit" aria-disabled={create.isPending || ws.stale || undefined}>
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

/**
 * What a create or rotate left to show. The secret lives only in this component state, in memory: dismissing it, or
 * leaving the page, discards it. The list and a source's own page (ADR 0056) both hold it this way.
 */
export function useSourceOutcome() {
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const show = (kind: 'created' | 'rotated', result: SourceWithSecret) => {
    const outcome = outcomeOf(kind, result);
    setReveal(outcome.type === 'reveal' ? outcome.reveal : null);
    setNotice(outcome.type === 'notice' ? outcome.message : null);
  };
  return { reveal, notice, show, dismiss: () => setReveal(null) };
}

export function SourceOutcome({ outcome }: { readonly outcome: ReturnType<typeof useSourceOutcome> }) {
  useLocale();
  const { reveal, notice, dismiss } = outcome;
  return (
    <>
      {reveal && (
        <SecretReveal
          key={reveal.source.id + reveal.kind}
          sourceName={reveal.source.name}
          secret={reveal.secret}
          kind={reveal.kind}
          onDismiss={dismiss}
        />
      )}
      {notice && (
        <Notice kind="success">
          <p>{notice}</p>
        </Notice>
      )}
    </>
  );
}

export function SourcesPage() {
  useLocale();
  const orgId = useOrgId();
  const list = useSources(orgId);
  const me = useQuery({ queryKey: ['me'], queryFn: authApi.me });
  const isAdmin = me.data?.user.role === 'admin';
  const outcome = useSourceOutcome();
  const { show } = outcome;
  const sources = list.data ?? [];
  return (
    <>
      <PageHeader
        eyebrow={t('sources.eyebrow')}
        title={t('sources.title')}
        description={t('sources.description')}
      />
      <SourceOutcome outcome={outcome} />
      {orgId && <CreateForm orgId={orgId} onCreated={(result) => show('created', result)} />}
      {list.isPending ? (
        <Skeleton label={t('sources.loading')} rows={2} />
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
        <EmptyState
          icon={<IconPlugConnected size={24} aria-hidden="true" />}
          title={t('sources.empty.title')}
        >
          <p>{t('sources.empty.body')}</p>
        </EmptyState>
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
                onRotated={(result) => show('rotated', result)}
              />
            ))}
          </div>
        </section>
      )}
    </>
  );
}
