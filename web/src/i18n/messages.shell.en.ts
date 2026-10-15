import type { PluralMessage } from './messages.en';

/**
 * English copy for the deep-linkable detail pages and the Destinations health page (ADR 0056).
 * A separate catalogue merged into `en` in `index.ts`, like the other feature catalogues. Same
 * rules: stable ids, `{name}` placeholders, no concatenation, and no figure the server did not
 * report: where the API says nothing, the page says "Not reported".
 */
export const shellEn = {
  // --- Navigation and route titles ---------------------------------------------
  'nav.destinations': 'Destinations health',
  'route.title.delivery': 'Delivery',
  'route.title.source': 'Source',
  'route.title.destinations': 'Destinations health',

  // --- Delivery page (/activity/:id) -------------------------------------------
  'delivery.page.eyebrow': 'DELIVERY',
  'delivery.page.back': 'All activity',
  'delivery.page.loading': 'Loading this delivery…',
  'delivery.page.error.title': 'We couldn’t load this delivery.',
  'delivery.page.retry': 'Try again',
  'delivery.detail.openPage': 'Open as a page',
  'delivery.detail.openPageHint':
    'The page has its own address, so you can bookmark it or paste it into a reply.',

  // --- Source page (/sources/:id) ----------------------------------------------
  'sources.detail.eyebrow': 'SOURCE',
  'sources.detail.back': 'All sources',
  'sources.detail.loading': 'Loading this source…',
  'sources.detail.error.title': 'We couldn’t load this source.',
  'sources.detail.retry': 'Try again',
  'sources.card.open': 'Open page',
  'sources.card.openLabel': 'Open the page for {name}',

  // --- Destinations health (/destinations) -------------------------------------
  'destinations.eyebrow': 'DESTINATIONS',
  'destinations.title': 'Destinations health',
  'destinations.description':
    'Where each integration sends, and whether Noti is sending there right now. Every state on this page is the one the server reported when the page loaded.',
  'destinations.loading': 'Loading destinations…',
  'destinations.empty.title': 'No destinations yet',
  'destinations.empty.body':
    'A destination is added with an integration. Once an integration exists, its destination and health show here.',
  'destinations.error.title': 'We couldn’t load your destinations.',
  'destinations.retry': 'Try again',
  'destinations.count': {
    one: '{count} destination',
    other: '{count} destinations',
  } satisfies PluralMessage,
  'destinations.tableLabel': 'Destinations and their health',
  'destinations.col.integration': 'Integration',
  'destinations.col.destination': 'Sends to',
  'destinations.col.switch': 'Switch',
  'destinations.col.sending': 'Sending',
  'destinations.col.failures': 'Failures in a row',
  'destinations.col.credentials': 'Webhook URL',
  'destinations.col.open': 'Settings',
  'destinations.switch.on': 'On',
  'destinations.switch.off': 'Turned off',
  'destinations.sending.closed': 'Sending normally',
  'destinations.sending.open': 'Paused automatically',
  'destinations.sending.openUntil': 'Tries again {time}',
  'destinations.sending.halfOpen': 'Checking the destination',
  'destinations.sending.paced': 'Slowed down until {time}',
  'destinations.timesOpened': {
    one: 'Paused automatically {count} time so far',
    other: 'Paused automatically {count} times so far',
  } satisfies PluralMessage,
  'destinations.notReported': 'Not reported',
  'destinations.notReported.note':
    '“Not reported” means the server has no health record for that destination. A record starts at the first failure or slow-down request and is cleared after a quiet period, so it does not prove that a message was delivered. Open the integration to see its recent deliveries.',
  'destinations.breakerNote':
    'Noti pauses sending by itself when a destination keeps failing, and tries again later. It never turns an integration off; only a person does.',
  'destinations.credentials.ok': 'Stored',
  'destinations.credentials.legacy': 'Needs to be entered again',
  'destinations.credentials.quarantined': 'Unreadable: nothing is sent',
  'destinations.credentials.revoked': 'Revoked: nothing is sent',
} as const satisfies Record<string, string | PluralMessage>;
