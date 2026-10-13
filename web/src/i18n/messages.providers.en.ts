/**
 * Copy for the GitLab and Stripe sources (ADR 0015). A separate catalogue merged into `en`
 * (the same pattern as `messages.filters.en.ts`), so the provider screens can change their
 * strings without touching the shared file. Rules as there: plain verbs, one claim at a time,
 * never blame the reader, never claim more than Noti does.
 */
export const providersEn = {
  'sources.kind.legend': 'What sends the events?',
  'sources.kind.generic.name': 'Your own system',
  'sources.kind.generic.where': 'A signed webhook you build or configure. Noti makes the secret.',
  'sources.kind.gitlab.name': 'GitLab',
  'sources.kind.gitlab.where': 'GitLab.com pipelines, merge requests, issues and pushes.',
  'sources.kind.stripe.name': 'Stripe',
  'sources.kind.stripe.where': 'Failed payments, disputes and subscription changes.',
  'sources.kind.sentry.note':
    'Sentry is not offered. Its webhook signature is documented in a way Noti cannot verify safely yet.',

  'sources.paste.stored': 'Noti stores it encrypted and never shows it again.',
  'sources.paste.gitlab.label': 'Token from GitLab',
  'sources.paste.gitlab.hintSigning':
    'Paste the signing token exactly as GitLab showed it. It starts with whsec_ and GitLab shows it once.',
  'sources.paste.gitlab.hintSecret':
    'Paste the secret token you typed in the GitLab webhook form (8 to 255 characters, no spaces).',
  'sources.paste.stripe.label': 'Signing secret from Stripe',
  'sources.paste.stripe.hint':
    'In Stripe Workbench, open the endpoint and reveal the signing secret. It starts with whsec_.',

  'sources.gitlab.auth.legend': 'Which GitLab credential will you paste?',
  'sources.gitlab.auth.signing': 'Signing token (recommended)',
  'sources.gitlab.auth.signing.where': 'GitLab signs every event, so a changed message is detected.',
  'sources.gitlab.auth.secret': 'Secret token',
  'sources.gitlab.auth.secret.where':
    'GitLab sends it as plain text. Weaker: it cannot show that a message was changed.',

  'sources.stripe.mode.legend': 'Which Stripe mode is this endpoint for?',
  'sources.stripe.mode.test': 'Test mode',
  'sources.stripe.mode.test.where': 'Events from your Stripe sandbox.',
  'sources.stripe.mode.live': 'Live mode',
  'sources.stripe.mode.live.where': 'Real customers and real money.',
  'sources.stripe.mode.hint':
    'Test and live endpoints have different secrets, so each is its own source. An event from the other mode is dropped.',

  'sources.validation.authMode': 'Choose which GitLab credential you will paste.',
  'sources.validation.livemode': 'Choose test or live mode.',
  'sources.validation.gitlabSigning':
    'A signing token starts with whsec_ followed by base64. Paste it exactly as GitLab showed it.',
  'sources.validation.gitlabSecret': 'Use 8 to 255 visible characters without spaces.',
  'sources.validation.stripeSecret':
    'A Stripe signing secret starts with whsec_. Copy it from the endpoint in Stripe Workbench.',

  'sources.created.provider':
    '{name} is ready. Finish in {provider} with the steps under “Set up {provider}” on the card below.',
  'sources.replaced.provider': 'The credential for {name} was replaced. The old one no longer works.',

  'sources.card.type': 'Source type',
  'sources.card.dropped': {
    one: '{count} event was dropped because the source exceeded the rate limit',
    other: '{count} events were dropped because the source exceeded the rate limit',
  },
  'sources.card.droppedHelp':
    'GitLab disables a webhook that gets error answers, so Noti answers 200 and drops the extra events instead. Pause noisy pipelines in GitLab or narrow its triggers. Last drop:',
  'sources.rotate.downgrade.label': 'Replace the signing token with a plain secret token',
  'sources.rotate.downgrade.help':
    'A plain secret token cannot show that a message was changed and a captured request can be replayed.',
  'sources.validation.downgrade': 'Tick the box to confirm the weaker credential.',
  'sources.card.auth': 'Verified with',
  'sources.card.auth.signing': 'Signed with a signing token',
  'sources.card.auth.secret': 'Plain secret token (weaker)',
  'sources.card.mode': 'Mode',
  'sources.card.mode.live': 'Live',
  'sources.card.mode.test': 'Test',

  'sources.rotate.provider.open': 'Replace credential…',
  'sources.rotate.provider.title': 'Replace the credential for {name}?',
  'sources.rotate.provider.body':
    'Paste the new credential from {provider}. The current one stops working the moment you save, so replace it in {provider} first or right after.',
  'sources.rotate.provider.confirm': 'Replace credential',
  'sources.rotate.provider.replacing': 'Replacing…',
  'sources.rotate.provider.failed': 'The credential was not replaced.',

  'sources.events.legend': 'Which events should this chat get?',
  'sources.events.hint': 'Leave all unticked to send every event in this list.',

  'sources.event.push': 'Pushes to a branch',
  'sources.event.tag_push': 'Tags pushed',
  'sources.event.merge_request.opened': 'Merge request opened',
  'sources.event.merge_request.merged': 'Merge request merged',
  'sources.event.merge_request.closed': 'Merge request closed',
  'sources.event.merge_request.reopened': 'Merge request reopened',
  'sources.event.issue.opened': 'Issue opened',
  'sources.event.issue.closed': 'Issue closed',
  'sources.event.issue.reopened': 'Issue reopened',
  'sources.event.pipeline.failed': 'Pipeline failed',
  'sources.event.pipeline.succeeded': 'Pipeline succeeded',
  'sources.event.invoice.payment_failed': 'Invoice payment failed',
  'sources.event.payment_intent.payment_failed': 'Payment failed',
  'sources.event.charge.dispute.created': 'Dispute opened',
  'sources.event.charge.dispute.closed': 'Dispute closed',
  'sources.event.customer.subscription.created': 'Subscription created',
  'sources.event.customer.subscription.updated': 'Subscription status changed',
  'sources.event.customer.subscription.deleted': 'Subscription canceled',

  'sources.guide.gitlab.summary': 'Set up GitLab',
  'sources.guide.gitlab.step1':
    'In GitLab, open your project, then Settings, then Webhooks, and choose Add new webhook.',
  'sources.guide.gitlab.step2': 'Paste the endpoint URL from this card into the URL box.',
  'sources.guide.gitlab.step3':
    'Paste the signing token, or the secret token you typed, into the matching box. It must be the same value you gave Noti.',
  'sources.guide.gitlab.step4':
    'Tick Push events, Tag push events, Merge request events, Issue events and Pipeline events.',
  'sources.guide.gitlab.step5': 'Save, then use Test. A 2xx answer means Noti accepted the event.',
  'sources.guide.gitlab.comOnly':
    'Noti supports GitLab.com only. A webhook from a self-managed GitLab is refused.',
  'sources.guide.gitlab.disable':
    'GitLab pauses a webhook after four failed deliveries in a row and turns it off for good after forty. Noti answers quickly and keeps answering 200 even when it is busy, dropping extra events instead of failing. If events stop, check the webhook in GitLab.',
  'sources.guide.gitlab.pushLimit':
    'GitLab sends no webhook at all for a push that touches more than three branches or tags, so Noti cannot show that push.',
  'sources.guide.gitlab.weak':
    'A secret token proves the sender knows the token, not that the message is unchanged, and a captured request can be replayed. Use a signing token if your GitLab offers one.',
  'sources.guide.gitlab.docs': 'GitLab webhook documentation',
  'sources.guide.gitlab.ignored':
    'Events outside the list above, and merge request updates, are accepted and not sent to chat.',

  'sources.guide.stripe.summary': 'Set up Stripe',
  'sources.guide.stripe.step1':
    'In Stripe, open Workbench, then Webhooks, and choose Create an event destination.',
  'sources.guide.stripe.step2':
    'Choose Your account, and the Snapshot payload format. Thin events are not supported.',
  'sources.guide.stripe.step3':
    'Select these events: invoice.payment_failed, payment_intent.payment_failed, charge.dispute.created, charge.dispute.closed, customer.subscription.created, customer.subscription.updated, customer.subscription.deleted.',
  'sources.guide.stripe.step4': 'Choose Webhook endpoint and paste the endpoint URL from this card.',
  'sources.guide.stripe.step5':
    'Reveal the signing secret, which starts with whsec_, and paste it into Noti when you create the source or replace the credential.',
  'sources.guide.stripe.modes':
    'Test mode and live mode have different secrets and different endpoints. Create one Noti source for each.',
  'sources.guide.stripe.privacy':
    'A notification shows ids, the amount and the currency. Customer names, emails and card details are never copied into a chat.',
  'sources.guide.stripe.retries':
    'Stripe retries a failed delivery for up to three days. Noti shows each Stripe event once, even when Stripe sends it again.',
  'sources.guide.stripe.roll':
    'When you roll the secret in Stripe, keep the old one active for a while, then replace the credential in Noti.',
  'sources.guide.stripe.docs': 'Stripe webhook documentation',
} as const;
