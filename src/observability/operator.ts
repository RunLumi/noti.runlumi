/**
 * Platform operators (ADR 0024). Per-job state and the health of the alert webhook describe the PLATFORM,
 * not a workspace, and any person who signs up is the admin of their own workspace, so workspace roles
 * cannot gate them. A platform operator is a user id on the secret `PLATFORM_OPERATOR_USER_IDS` (comma
 * separated, matched exactly, checked server-side). Unset or empty means nobody: the default exposes
 * nothing. Tenants get only the coarse `jobsStatus`.
 */
export function isPlatformOperator(
  env: { readonly PLATFORM_OPERATOR_USER_IDS?: string },
  userId: string,
): boolean {
  const raw = env.PLATFORM_OPERATOR_USER_IDS;
  if (!raw || userId === '') return false;
  return raw
    .split(',')
    .map((id) => id.trim())
    .some((id) => id !== '' && id === userId);
}
