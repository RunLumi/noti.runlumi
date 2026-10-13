import { JSON_HEADERS, type DestinationAdapter } from '../adapter';
import { capabilitiesFor } from '../capabilities';
import { validateConfigFor, type SlackDestinationConfig } from '../config';
import type { OutboundRequest } from '../types';
import { classifySlackResponse } from './classify';
import { renderSlack } from './render';

export const slackAdapter: DestinationAdapter<SlackDestinationConfig> = {
  kind: 'slack',
  adapterVersion: '1',
  capabilities: () => capabilitiesFor('slack'),
  validateConfig: (raw) => validateConfigFor('slack', raw),
  render: renderSlack,
  buildRequest: (message, config): Promise<OutboundRequest> =>
    Promise.resolve({
      kind: 'slack',
      url: config.webhookUrl,
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(message.payload),
    }),
  classifyResponse: classifySlackResponse,
};
