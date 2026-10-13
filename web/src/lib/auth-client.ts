import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";

// Same-origin Hono Worker route; Vite proxies /api locally.
export const authClient = createAuthClient({
  baseURL: typeof window === "undefined" ? undefined : window.location.origin,
  plugins: [organizationClient(), passkeyClient()],
  fetchOptions: { credentials: "include" },
});

export function assertAuthSuccess<T>(result: { data: T; error?: { message?: string; status?: number } | null }): T {
  if (result.error) throw new Error(result.error.message || "Authentication request failed");
  return result.data;
}
