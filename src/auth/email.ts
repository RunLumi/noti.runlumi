/**
 * Cloudflare Email Sending (not inbound Email Routing).
 * Requires the domain to be onboarded for Email Sending and Workers Paid.
 * Sender and all URLs are server-controlled, never taken from request JSON.
 */
export interface EmailBinding {
  send(message: { from: string; to: string; subject: string; text: string; html?: string }): Promise<unknown>;
}
export interface EmailEnvironment {
  AUTH_EMAIL: EmailBinding;
  AUTH_FROM_EMAIL: string;
  APP_ORIGIN: string;
}
export async function sendAuthEmail(env: EmailEnvironment, input: {
  to: string;
  subject: string;
  intro: string;
  url: string;
}): Promise<void> {
  const site = new URL(env.APP_ORIGIN);
  const link = new URL(input.url);
  if (link.origin !== site.origin && link.origin !== new URL("/api/auth/",site).origin) {
    throw new Error("Refusing to send an off-site authentication link");
  }
  // HTML is intentionally omitted to avoid template/link injection from user input.
  await env.AUTH_EMAIL.send({
    from: env.AUTH_FROM_EMAIL,
    to: input.to,
    subject: input.subject,
    text: input.intro + "\n\n" + link.toString() + "\n\nIf you did not request this, you can ignore this email.",
  });
}
