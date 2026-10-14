/**
 * Session lifetime, in one dependency-free module so the retention matrix
 * (`src/compliance/retention.ts`) reads the value the auth configuration really uses.
 */
export const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 30;
export const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;
