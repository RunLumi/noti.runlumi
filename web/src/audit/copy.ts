import { en, type MessageId } from '../i18n/messages.en';
import { t, formatNumber } from '../i18n';
import { formatDateTime } from '../i18n/format';
import { isDestinationKind } from '../lib/api';
import { destinationName } from '../deliveries/copy';
import { roleLabel } from '../lib/role-label';
import { isAuditAction, type AuditEvent, type FieldChange, type SummaryItem } from './api';

const has = (id: string): id is MessageId => Object.prototype.hasOwnProperty.call(en, id);

/** The plain-language name of an action; "Other event" for one this release does not know. */
export function actionLabel(action: string): string {
  const id = `audit.action.${action}`;
  return t(isAuditAction(action) && has(id) ? id : 'audit.action.unknown');
}

export function subjectTypeLabel(type: string): string {
  const id = `audit.subject.${type}`;
  return has(id) ? t(id) : type;
}

export function outcomeLabel(outcome: AuditEvent['outcome']): string {
  return t(outcome === 'denied' ? 'audit.outcome.denied' : 'audit.outcome.success');
}

export function actorLabel(actor: AuditEvent['actor']): string {
  switch (actor.kind) {
    case 'member':
      return actor.name;
    case 'system':
      return t('audit.actor.system');
    case 'former':
      return t('audit.actor.former');
    case 'other':
      return t('audit.actor.other');
    case 'installation':
      return actor.account
        ? t('audit.actor.installation.named', { account: actor.account })
        : t('audit.actor.installation');
  }
}

export function detailLabel(key: string): string {
  const id = `audit.detail.${key}`;
  return has(id) ? t(id) : key;
}

/** A value as a sentence fragment: Yes/No, localised numbers and dates, known destination names. */
export function detailValue(item: SummaryItem): string {
  const { key, value } = item;
  if (typeof value === 'boolean') return t(value ? 'audit.value.true' : 'audit.value.false');
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value !== 'string') return value.join(', ');
  if (key === 'destination' && isDestinationKind(value)) return destinationName(value);
  if (key === 'purgeAfter') return formatDateTime(value);
  if (key === 'role' || key === 'previousRole') return roleLabel(value);
  return value;
}

/**
 * "Label: value" pairs for display and for the CSV. A fact the "what changed" block already shows
 * with its before and after is left out here, so one cell never says the same thing twice.
 */
export function detailPairs(event: AuditEvent): readonly { label: string; text: string }[] {
  const diffed = new Set<string>(event.changes.map((c) => c.field));
  return event.summary
    .filter((item) => !diffed.has(item.key))
    .map((item) => ({ label: detailLabel(item.key), text: detailValue(item) }));
}

const yesNo = (v: string | boolean): string =>
  typeof v === 'boolean' ? t(v ? 'audit.value.true' : 'audit.value.false') : v;

/** "Label: before → after" lines for the fields an update changed; empty for a row with no diff. */
export function changePairs(event: AuditEvent): readonly { label: string; text: string }[] {
  return event.changes.flatMap((c: FieldChange) => {
    if (c.kind === 'value')
      return [
        {
          label: t(c.field === 'enabled' ? 'audit.change.enabled' : 'audit.change.repo'),
          text: t('audit.change.arrow', { before: yesNo(c.before), after: yesNo(c.after) }),
        },
      ];
    return [
      ...(c.added.length > 0
        ? [{ label: t('audit.change.eventTypes.added'), text: c.added.join(', ') }]
        : []),
      ...(c.removed.length > 0
        ? [{ label: t('audit.change.eventTypes.removed'), text: c.removed.join(', ') }]
        : []),
    ];
  });
}
