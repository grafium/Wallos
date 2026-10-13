/*
  Outbound requests to user-supplied URLs (webhooks, Gotify, ntfy, ...).

  A Worker runs on Cloudflare's network, not next to the user's LAN, so the
  DNS-rebinding defences of PHP Wallos (includes/ssrf_helper.php) are not
  needed: private addresses are simply not reachable from there. What is
  still refused, so a request cannot be aimed at something surprising, are
  non-http(s) schemes, credentials in the URL, and hosts that name loopback,
  private or link-local addresses directly.
*/

const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT
];

export function checkOutboundUrl(value: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "Not a valid URL." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "Only http(s) URLs are allowed." };
  if (url.username || url.password) return { ok: false, reason: "Credentials in the URL are not allowed." };

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, reason: "Local host names are not reachable from Cloudflare." };
  }
  if (PRIVATE_V4.some((re) => re.test(host))) return { ok: false, reason: "Private IP addresses are not reachable from Cloudflare." };
  if (host.includes(":") && (host === "::1" || /^f[cd]/.test(host) || host.startsWith("fe80") || host === "::")) {
    return { ok: false, reason: "Private IP addresses are not reachable from Cloudflare." };
  }
  return { ok: true, url };
}

export class OutboundError extends Error {}

/** fetch() with a timeout that throws on HTTP errors and refuses unsafe URLs. */
export async function outboundFetch(value: string, init: RequestInit = {}): Promise<Response> {
  const check = checkOutboundUrl(value);
  if (!check.ok) throw new OutboundError(check.reason);
  const response = await fetch(check.url, { ...init, redirect: "manual", signal: AbortSignal.timeout(15_000) });
  if (response.status >= 300) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw new OutboundError(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return response;
}

/**
 * Custom headers as PHP Wallos stored them: a JSON object, a JSON array of
 * "Name: value" strings, or one "Name: value" per line.
 */
export function parseHeaders(raw: string | undefined | null): Record<string, string> {
  const headers: Record<string, string> = {};
  const text = (raw ?? "").trim();
  if (!text) return headers;

  const addLine = (line: string) => {
    const index = line.indexOf(":");
    if (index > 0) headers[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  };

  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) {
      parsed.forEach((line) => typeof line === "string" && addLine(line));
      return headers;
    }
    if (parsed && typeof parsed === "object") {
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value !== "string" && typeof value !== "number") continue;
        // {"0": "X-Token: abc"} is a list that went through json_encode as an object.
        if (/^\d+$/.test(key)) addLine(String(value));
        else headers[key] = String(value);
      }
      return headers;
    }
  } catch {
    // Not JSON: one header per line.
  }
  text.split(/\r\n|\n|\r/).forEach(addLine);
  return headers;
}
