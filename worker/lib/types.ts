export type Role = "itu-admin" | "itu-editor" | "member-submitter";

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DB: D1Database;
  /** "stub" enables the local stub; anything else (including unset) fails closed. */
  AUTH_MODE?: string;
  /** Cloudflare Access team hostname and application audience; both required. */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** Queue-consumer-only email credentials; never exposed to browser assets. */
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  // OIDC relying party (AUTH_MODE="oidc"). Required: ISSUER, CLIENT_ID, and
  // CLIENT_SECRET (a Worker secret) unless OIDC_CLIENT_AUTH="none". All optional
  // knobs map to assumptions A1-A11 in docs/identity-accounts.adoc. No defaults
  // point anywhere real; missing/invalid config fails closed.
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_CLIENT_AUTH?: string;
  OIDC_AUTHORIZATION_ENDPOINT?: string;
  OIDC_TOKEN_ENDPOINT?: string;
  OIDC_JWKS_URI?: string;
  OIDC_END_SESSION_ENDPOINT?: string;
  OIDC_POST_LOGOUT_REDIRECT_URI?: string;
  OIDC_REDIRECT_URI?: string;
  OIDC_SCOPES?: string;
  OIDC_SUB_KEY?: string;
  OIDC_ID_TOKEN_ALGS?: string;
  /** Authoritative action repository, explicitly configured for real publishing. */
  PATCH_REPO?: string;
  /** GitHub App credentials; the private key is PKCS8 PEM in a Worker secret. */
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  GITHUB_SITE_REPO?: string;
  GITHUB_DATA_GITLINK?: string;
  GITHUB_STAGING_BRANCH?: string;
  /** GitHub webhook secret (Worker secret). Unset: /api/github/webhook fails closed with 503. */
  GITHUB_WEBHOOK_SECRET?: string;
  /** Notification carrier queue (`ituob-notify`); absent locally/unprovisioned: rows stay queued. */
  NOTIFY_Q?: Queue<{ notification_ids: string[] }>;
}

/** Shared contract with #102 (docs/identity-accounts.adoc). */
export interface Session {
  userId: string;
  roles: Role[];
  memberStateId: string | null;
}

/** Verified Cloudflare Access identity for /admin/* and /api/admin/*. */
export interface AccessIdentity {
  email: string;
}
