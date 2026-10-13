import { JSON_HEADERS, type DestinationAdapter } from '../adapter';
import { capabilitiesFor } from '../capabilities';
import { validateConfigFor, type DiscordDestinationConfig } from '../config';
import type { OutboundRequest } from '../types';
import { classifyDiscordResponse } from './classify';
import { renderDiscord } from './render';

/** The documented Execute Webhook version segment (reference section 4). */
const API_VERSION_PATH = '/api/v10/';

export const discordAdapter: DestinationAdapter<DiscordDestinationConfig> = {
  kind: 'discord',
  adapterVersion: '1',
  capabilities: () => capabilitiesFor('discord'),
  validateConfig: (raw) => validateConfigFor('discord', raw),
  render: renderDiscord,
  // `wait=true` is mandatory, not a default: without it Discord answers 204 even when a
  // message was not saved, so a silent drop is indistinguishable from a delivery (F107).
  buildRequest: (message, config): Promise<OutboundRequest> => {
    const url = new URL(config.webhookUrl);
    url.pathname = url.pathname.replace(/^\/api\/(?:v\d{1,2}\/)?/, API_VERSION_PATH);
    url.searchParams.set('wait', 'true');
    return Promise.resolve({
      kind: 'discord',
      url: url.href,
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(message.payload),
    });
  },
  classifyResponse: classifyDiscordResponse,
};
