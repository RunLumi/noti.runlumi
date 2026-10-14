import type { PluralMessage } from './messages.en';

/**
 * Copy for "Where you are signed in" on Settings (ADR 0030). Plain words: what the list is, what signing a
 * device out does, and the two limits on how long a sign-in lasts. Browser and system names stay English.
 */
export const sessionsEn = {
  'sessions.title': 'Where you are signed in',
  'sessions.body':
    'Every browser or device signed in to your account. If you do not recognise one, sign it out and change your password.',
  'sessions.lifetime':
    'A sign-in ends after {idleDays} days without use, and always {maxDays} days after you signed in.',
  'sessions.activityNote': 'Last active times are updated about once a day.',
  'sessions.listLabel': 'Devices signed in to your account',
  'sessions.loading': 'Loading your devices…',
  'sessions.error': 'We couldn’t load your devices. Nothing has been changed.',
  'sessions.retry': 'Try again',
  'sessions.current': 'This device',
  'sessions.signedIn': 'Signed in {date}',
  'sessions.lastActive': 'Last active {date}',
  'sessions.address': 'Address {ip}',
  'sessions.addressUnknown': 'Address unknown',
  'sessions.device.both': '{browser} on {os}',
  'sessions.device.browser': '{browser}',
  'sessions.device.os': '{os}',
  'sessions.device.unknown': 'Unknown device',
  'sessions.revoke': 'Sign out',
  'sessions.revokeFor': 'Sign out {device}',
  'sessions.revoking': 'Signing out…',
  'sessions.revokeOthers': 'Sign out all other devices',
  'sessions.revokeOthersNone': 'You are not signed in anywhere else.',
  'sessions.revokedOne': 'That device was signed out.',
  'sessions.revokedOthers': {
    one: '{count} other device was signed out.',
    other: '{count} other devices were signed out.',
  } satisfies PluralMessage,
  'sessions.revokedNone': 'There was no other device to sign out.',
  'sessions.error.revoke': 'We couldn’t sign that device out. Try again.',
  'sessions.error.gone': 'That device was already signed out. The list has been refreshed.',
  'sessions.error.tooMany': 'Too many requests. Wait a minute and try again.',
} as const;
