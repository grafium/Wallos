import type { ImagesBinding } from "./lib/image";

export interface Env {
  DB: D1Database;
  /** R2 bucket with uploaded logos, icons and avatars. */
  FILES: R2Bucket;
  /** Static files of the web interface (Workers Static Assets). */
  ASSETS?: Fetcher;
  /** Optional Cloudflare Images binding; resizes uploads. Without it images are stored as uploaded. */
  IMAGES?: ImagesBinding;
  /** Lifetime of a login session in days (string because it is a wrangler var). */
  SESSION_TTL_DAYS?: string;
  /** Resend API key (secret: `wrangler secret put RESEND_API_KEY`). Without it no e-mail is sent. */
  RESEND_API_KEY?: string;
  /** Sender of every e-mail, e.g. "Wallos <wallos@example.com>"; the domain must be verified in Resend. */
  EMAIL_FROM?: string;
  /** Public base URL used in e-mailed links when the admin has not set server_url. */
  APP_URL?: string;
  /** Optional Workers AI binding: offers "Workers AI" as a provider for AI recommendations. */
  AI?: Ai;
  /** Optional Workers Rate Limiting binding checked before every login attempt (per client address). */
  LOGIN_RATE_LIMITER?: RateLimit;
  /**
   * OIDC overrides, as in PHP Wallos' environment variables (OIDC_ENABLED,
   * OIDC_CLIENT_SECRET, OIDC_ISSUER, ...); see src/services/oidc.ts. A field
   * set here is shown read-only on the admin page.
   */
  [oidcVariable: `OIDC_${string}`]: string | undefined;
}

export interface AuthUser {
  id: number;
  timezone?: string;
  username: string;
  email: string;
  main_currency: number | null;
  language: string | null;
  budget: number | null;
}

export type AppBindings = {
  Bindings: Env;
  Variables: {
    user: AuthUser;
    /** How the request authenticated; sessions can manage credentials, API keys cannot. */
    authMethod: "session" | "api_key";
    /** The session token, when authenticated with one (Bearer or cookie). */
    sessionToken?: string;
  };
};

/** Wallos treats the first account as the instance administrator. */
export const ADMIN_USER_ID = 1;
