export interface Env {
  DB: D1Database;
  /** Lifetime of a login session in days (string because it is a wrangler var). */
  SESSION_TTL_DAYS?: string;
  /** Resend API key (secret: `wrangler secret put RESEND_API_KEY`). Without it no e-mail is sent. */
  RESEND_API_KEY?: string;
  /** Sender of every e-mail, e.g. "Wallos <wallos@example.com>"; the domain must be verified in Resend. */
  EMAIL_FROM?: string;
  /** Public base URL used in e-mailed links when the admin has not set server_url. */
  APP_URL?: string;
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
  };
};

/** Wallos treats the first account as the instance administrator. */
export const ADMIN_USER_ID = 1;
