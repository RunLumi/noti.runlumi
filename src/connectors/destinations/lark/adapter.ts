import { JSON_HEADERS, type DestinationAdapter } from '../adapter';
import { capabilitiesFor } from '../capabilities';
import { validateConfigFor, type LarkDestinationConfig } from '../config';
import type { JsonObject, OutboundRequest, RenderedMessage } from '../types';
import { classifyLarkResponse } from './classify';
import { renderLark } from './render';
import { larkSignatureFields } from './sign';

async function signedPayload(
  message: RenderedMessage,
  config: LarkDestinationConfig,
  now: number,
): Promise<JsonObject> {
  if (!config.signingSecret) return message.payload;
  return { ...message.payload, ...(await larkSignatureFields(config.signingSecret, now)) };
}

export const larkAdapter: DestinationAdapter<LarkDestinationConfig> = {
  kind: 'lark',
  adapterVersion: '2',
  capabilities: () => capabilitiesFor('lark'),
  validateConfig: (raw) => validateConfigFor('lark', raw),
  render: renderLark,
  buildRequest: async (message, config, now): Promise<OutboundRequest> => ({
    kind: 'lark',
    url: config.webhookUrl,
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(await signedPayload(message, config, now)),
  }),
  classifyResponse: classifyLarkResponse,
};
