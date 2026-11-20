import type { UserHub } from "./hub.ts";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Live-sync hub (Durable Object per user); optional so the app degrades gracefully. */
  USER_HUB?: DurableObjectNamespace<UserHub>;
  /** HMAC secret for signing session JWTs. Set via `wrangler secret put JWT_SECRET`. */
  JWT_SECRET: string;
  /** Required code to register a new account. Set via `wrangler secret put INVITE_CODE`. */
  INVITE_CODE: string;
  /** Claude API key for voice-note structuring. Set via `wrangler secret put ANTHROPIC_API_KEY`. */
  ANTHROPIC_API_KEY: string;
  /** Feature flag: Voice Inbox is only reachable when this is exactly "true". */
  VOICE_INBOX_ENABLED?: string;
  /**
   * Optional comma-separated browser Origins allowed to call /mcp (e.g.
   * "https://claude.ai"). Requests without an Origin header (CLI/server
   * clients) are always allowed once authenticated.
   */
  MCP_ALLOWED_ORIGINS?: string;
  /** Rate limiting bindings (wrangler.jsonc "ratelimits"); optional. */
  MCP_LIMITER?: RateLimit;
  AUTH_LIMITER?: RateLimit;
}
