/**
 * Copy-paste examples for sending a signed event (docs/API.md "Generic source"). They never
 * contain the signing secret: the reader exports it as an environment variable first, so a
 * copied snippet cannot leak it into shell history, a ticket or a chat.
 *
 * Both examples sign exactly as the Worker verifies: HMAC-SHA256 over `id.timestamp.body`,
 * keyed with the base64-decoded part of the secret after `whsec_`, sent as `v1,<base64>`.
 * `tests/sources/snippets.test.ts` runs them against that rule.
 */
export const SECRET_ENV = 'NOTI_SIGNING_SECRET';

/** A minimal valid event; every field is documented in docs/API.md. */
export const SAMPLE_BODY =
  '{"type":"deploy.failed","title":"Deploy failed on production","severity":"error"}';

export function bashSnippet(endpointUrl: string): string {
  return [
    `# Paste your secret once in this shell session: export ${SECRET_ENV}='whsec_…'`,
    `URL='${endpointUrl}'`,
    `BODY='${SAMPLE_BODY}'`,
    'ID="msg_$(date +%s)_$RANDOM"',
    'TS=$(date +%s)',
    `KEY=$(printf '%s' "\${${SECRET_ENV}#whsec_}" | openssl base64 -d -A | xxd -p -c 256)`,
    `SIG=$(printf '%s.%s.%s' "$ID" "$TS" "$BODY" | openssl dgst -sha256 -mac HMAC -macopt hexkey:"$KEY" -binary | openssl base64 -A)`,
    'curl -sS -X POST "$URL" \\',
    "  -H 'content-type: application/json' \\",
    '  -H "webhook-id: $ID" \\',
    '  -H "webhook-timestamp: $TS" \\',
    '  -H "webhook-signature: v1,$SIG" \\',
    '  --data-binary "$BODY"',
  ].join('\n');
}

export function nodeSnippet(endpointUrl: string): string {
  return [
    "import { createHmac, randomUUID } from 'node:crypto';",
    '',
    `const secret = process.env.${SECRET_ENV}; // whsec_…`,
    `const url = '${endpointUrl}';`,
    `const body = '${SAMPLE_BODY}';`,
    '',
    'const id = `msg_${randomUUID()}`;',
    'const timestamp = String(Math.floor(Date.now() / 1000));',
    "const key = Buffer.from(secret.slice('whsec_'.length), 'base64');",
    "const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');",
    '',
    'const response = await fetch(url, {',
    "  method: 'POST',",
    '  headers: {',
    "    'content-type': 'application/json',",
    "    'webhook-id': id,",
    "    'webhook-timestamp': timestamp,",
    "    'webhook-signature': `v1,${signature}`,",
    '  },',
    '  body,',
    '});',
    'console.log(response.status, await response.text());',
  ].join('\n');
}
