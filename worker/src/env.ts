export interface Env {
  DB: D1Database;
  /** Lifetime of a login session in days (string because it is a wrangler var). */
  SESSION_TTL_DAYS?: string;
}

export interface AuthUser {
  id: number;
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
