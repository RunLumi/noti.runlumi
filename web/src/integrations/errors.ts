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

function idFor(status: number, serverMessage: string): MessageId {
  if (status === 0) return 'error.network';
  if (status === 401) return 'error.session';
  // 403 is either a missing capability or the Origin check; only the first is about the role.
  if (status === 403)
    return serverMessage.startsWith('Missing capability') ? 'error.forbidden' : 'error.blocked';
  if (status === 404) return 'error.notFound';
  if (status === 409) return 'error.quota';
  if (status === 413) return 'error.tooLarge';
  if (status === 429) return 'error.rateLimited';
  if (status === 415 || status === 400) return 'error.blocked';
  if (status === 422) return 'error.validation';
  return 'error.server';
}

export function describeError(error: unknown): UserError {
  if (error instanceof ApiError) {
    if (error.status === 429 && error.retryAfter !== null)
      return {
        message: t('error.rateLimitedFor', { seconds: error.retryAfter }),
        reference: t('error.reference', { status: '429' }),
      };
    return {
      message: t(idFor(error.status, error.message)),
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
