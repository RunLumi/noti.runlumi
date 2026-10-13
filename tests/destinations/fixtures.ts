import type { CanonicalNotification, ProviderResponse } from '../../src/connectors/destinations/types';

export const NOW = Date.parse('2026-10-13T00:00:00Z');

export const BASE: CanonicalNotification = {
  title: 'CI failed on main',
  eventType: 'workflow_run.failure',
  url: 'https://github.com/acme/api/actions/runs/1',
  repo: 'acme/api',
  actor: 'octocat',
  status: 'failure',
  summary: 'Job `test` failed after 3m 2s.',
};

export function response(
  status: number,
  bodyText = '',
  headers: Record<string, string> = {},
): ProviderResponse {
  return { status, bodyText, headers: new Headers(headers) };
}

export const SLACK_URL = 'https://hooks.slack.com/services/T000/B000/XXXX';
export const TEAMS_URL =
  'https://prod-12.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?sig=s';
export const LARK_URL = 'https://open.larksuite.com/open-apis/bot/v2/hook/abc';
