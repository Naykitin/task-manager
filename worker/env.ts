export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** HMAC secret for signing session JWTs. Set via `wrangler secret put JWT_SECRET`. */
  JWT_SECRET: string;
  /** Required code to register a new account. Set via `wrangler secret put INVITE_CODE`. */
  INVITE_CODE: string;
  /** Claude API key for voice-note structuring. Set via `wrangler secret put ANTHROPIC_API_KEY`. */
  ANTHROPIC_API_KEY: string;
}
