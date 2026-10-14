import { ApiError } from '../lib/api';
import { fromServer } from './validation';
import { t, type MessageId } from '../i18n';

/**
 * Plain-language copy for a failed request (F220). The primary message is chosen from our
 * catalogue by status; server text is never the headline. The status code is kept only as a
 * support reference.
 */
export interface UserError {
  readonly message: string;
  readonly reference: string | null;
}

/** What kind of failure a request had; copy is chosen from this, never from server text. */
export type ErrorKind =
  | 'network'
  | 'session'
  | 'forbidden'
  | 'blocked'
  | 'notFound'
  | 'quota'
  | 'rateLimited'
  | 'tooLarge'
  | 'validation'
  | 'server';

export function errorKind(error: unknown): ErrorKind {
  if (!(error instanceof ApiError)) return 'server';
  const { status } = error;
  if (status === 0) return 'network';
  if (status === 401) return 'session';
  // 403 is either a missing capability or the Origin check; only the first is about the role.
  if (status === 403) return error.message.startsWith('Missing capability') ? 'forbidden' : 'blocked';
  if (status === 404) return 'notFound';
  if (status === 409) return 'quota';
  if (status === 413) return 'tooLarge';
  if (status === 429) return 'rateLimited';
  if (status === 415 || status === 400) return 'blocked';
  if (status === 422) return 'validation';
  return 'server';
}

const KIND_MESSAGE: Readonly<Record<ErrorKind, MessageId>> = {
  network: 'error.network',
  session: 'error.session',
  forbidden: 'error.forbidden',
  blocked: 'error.blocked',
  notFound: 'error.notFound',
  quota: 'error.quota',
  rateLimited: 'error.rateLimited',
  tooLarge: 'error.tooLarge',
  validation: 'error.validation',
  server: 'error.server',
};

export function describeError(error: unknown): UserError {
  if (error instanceof ApiError) {
    if (error.status === 429 && error.retryAfter !== null)
      return {
        message: t('error.rateLimitedFor', { seconds: error.retryAfter }),
        reference: t('error.reference', { status: '429' }),
      };
    return {
      message: t(KIND_MESSAGE[errorKind(error)]),
      reference: error.status > 0 ? t('error.reference', { status: String(error.status) }) : null,
    };
  }
  return { message: t('error.server'), reference: null };
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

export function fieldErrorsOf(error: unknown) {
  return error instanceof ApiError && error.status === 422 ? error.fields : [];
}

/**
 * The form-level message for a failed save, or null when every problem is already shown next
 * to a field. A 422 about something no field renders (e.g. "Nothing to change") is shown here
 * with the server's message, which never echoes input.
 */
export function formLevelError(error: unknown): UserError | null {
  if (error === null || error === undefined) return null;
  const server = fromServer(fieldErrorsOf(error));
  if (Object.keys(server.fields).length > 0 && server.other.length === 0) return null;
  if (server.other.length > 0) return { message: server.other.join(' '), reference: null };
  return describeError(error);
}
