import type { Env } from "../env";

/*
  E-mail through Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email).

  Workers cannot speak SMTP comfortably, so instead of PHP Wallos' per-user
  SMTP settings there is one sender for the instance: the RESEND_API_KEY
  secret and the EMAIL_FROM variable.
*/

export interface EmailMessage {
  to: string | string[];
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
}

export class EmailNotConfigured extends Error {
  constructor() {
    super("E-mail is not configured: set the RESEND_API_KEY secret and the EMAIL_FROM variable.");
  }
}

export function emailConfigured(env: Env): boolean {
  return Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
}

export async function sendEmail(env: Env, message: EmailMessage): Promise<{ id: string }> {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) throw new EmailNotConfigured();

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: Array.isArray(message.to) ? message.to : [message.to],
      ...(message.cc?.length ? { cc: message.cc } : {}),
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const body = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!response.ok || !body.id) {
    throw new Error(`Resend answered ${response.status}: ${body.message ?? "no message"}`);
  }
  return { id: body.id };
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
