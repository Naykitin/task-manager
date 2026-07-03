export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** HMAC secret for signing session JWTs. Set via `wrangler secret put JWT_SECRET`. */
  JWT_SECRET: string;
  /** Required code to register a new account. Set via `wrangler secret put INVITE_CODE`. */
  INVITE_CODE: string;
}
