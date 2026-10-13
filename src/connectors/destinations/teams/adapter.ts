import { JSON_HEADERS, type DestinationAdapter } from '../adapter';
import { capabilitiesFor } from '../capabilities';
import { validateConfigFor, type TeamsDestinationConfig } from '../config';
import type { OutboundRequest } from '../types';
import { classifyTeamsResponse } from './classify';
import { renderTeams } from './render';

export const teamsAdapter: DestinationAdapter<TeamsDestinationConfig> = {
  kind: 'teams',
  adapterVersion: '1',
  capabilities: () => capabilitiesFor('teams'),
  validateConfig: (raw) => validateConfigFor('teams', raw),
  render: renderTeams,
  // `triggerAuth` is always `anyone` here, and with `anyone` an Authorization header makes
  // every POST fail, so none is sent.
  buildRequest: (message, config): Promise<OutboundRequest> =>
    Promise.resolve({
      kind: 'teams',
      url: config.webhookUrl,
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(message.payload),
    }),
  classifyResponse: classifyTeamsResponse,
};
