/**
 * Copy for the Discord and custom-webhook destinations (ADR 0014). A separate catalogue merged
 * into `en`, like `messages.filters.en.ts`, so these destinations can change their strings
 * without touching the shared file. Same rules: plain verbs, one claim at a time, never claim
 * more than Noti can do. The setup steps follow the providers' own documentation and the
 * customer-endpoint contract in docs/specs/09-destinations-extended.md.
 */
export const destinationsEn = {
  // --- Discord ------------------------------------------------------------
  'destination.discord': 'Discord',
  'destination.discord.where': 'Posts to the Discord channel you choose.',
  'destination.discord.what':
    'Uses a webhook that you create for one channel. Noti never pings @everyone, @here, roles or people.',
  'destination.discord.urlHint':
    'Starts with https://discord.com/api/webhooks/. You can add ?thread_id=… to post into one thread.',
  'destination.discord.docs': 'Discord’s guide to webhooks',
  'destination.discord.step1':
    'In Discord, open Server Settings, then Integrations, then Webhooks. You need the Manage Webhooks permission.',
  'destination.discord.step2': 'Choose New Webhook, give it a name, and pick the channel it should post to.',
  'destination.discord.step3': 'Choose Copy Webhook URL.',
  'destination.discord.step4': 'Paste it below. Noti accepts only addresses on discord.com.',
  'destination.discord.noteDeleted':
    'If the webhook is deleted in Discord, Noti pauses this integration after the first failure instead of retrying. Discord restricts callers that keep using a deleted webhook. Paste a new URL and turn the integration back on.',
  'destination.discord.noteMentions':
    'A branch named @everyone, or a pull request that mentions a role, is shown as plain text. It cannot notify anyone.',
  'validation.webhookUrl.wrongHost.discord':
    'That isn’t a Discord webhook address. It should start with https://discord.com/api/webhooks/ and be copied whole from Discord.',

  // --- Custom webhook -----------------------------------------------------
  'destination.generic_webhook': 'Custom webhook',
  'destination.generic_webhook.where': 'Posts to an HTTPS endpoint that you run.',
  'destination.generic_webhook.what':
    'Sends each update as signed JSON to your own service. For people who can write a small receiver.',
  'destination.generic_webhook.urlHint':
    'A public https:// address, for example https://hooks.example.com/noti. It may include a secret path or query.',
  'destination.generic_webhook.docs': 'The Standard Webhooks signing specification',
  'destination.generic_webhook.step1':
    'Run an endpoint that accepts a POST with a JSON body and is reachable from the public internet over HTTPS (port 443).',
  'destination.generic_webhook.step2':
    'After you save, Noti shows a signing secret once. Verify the webhook-signature header on every request with it, as the Standard Webhooks specification describes.',
  'destination.generic_webhook.step3':
    'Answer with a 2xx status within 10 seconds. 408, 429 and 5xx are retried. Other 4xx statuses and redirects are reported as failures and not retried.',
  'destination.generic_webhook.step4':
    'Delivery is at least once. Use the webhook-id header to ignore a request you have already handled; it stays the same across retries.',
  'destination.generic_webhook.step5':
    'Paste the address below. Noti does not accept IP addresses, localhost, internal names, other ports or http, and it never follows redirects.',
  'destination.generic_webhook.noteChecked':
    'Noti checks that the hostname resolves to a public address when you save it. It cannot re-check on every delivery, so keep this hostname pointed at your own public server.',
  'destination.generic_webhook.noteEvidence':
    'Your endpoint’s 2xx answer is the only evidence Noti has. It cannot see what happens next. A 202 is shown as Accepted; any other 2xx as Delivered.',
  'validation.webhookUrl.wrongHost.generic_webhook':
    'Use a public https:// address with a normal hostname, for example https://hooks.example.com/noti. IP addresses, localhost, internal names, other ports and http are not accepted.',

  // --- One-time signing secret --------------------------------------------
  'integration.secret.created.title': 'Signing secret for {name}',
  'integration.secret.rotated.title': 'New signing secret for {name}',
  'integration.secret.warning':
    'Copy this secret now. Noti stores it encrypted and cannot show it again. Your endpoint uses it to check that each request really came from Noti.',
  'integration.secret.rotatedNote':
    'The previous secret stopped working when you saved. Update your endpoint now, or its signature checks will fail.',
  'integration.secret.label': 'Signing secret',
  'integration.secret.saved': 'I have saved it',
  'integration.secret.continue': 'Open the integration',
} as const;
