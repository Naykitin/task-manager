import type { Env } from "./env.ts";
import { json } from "./util.ts";

// Rate limiting via Cloudflare's Workers Rate Limiting bindings (see
// wrangler.jsonc "ratelimits"). If a binding is absent (e.g. an older local
// setup) limiting is skipped rather than blocking requests.

export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}

/** True if the request is allowed under `limiter` for `key`. Fails open. */
export async function allow(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return true;
  try {
    return (await limiter.limit({ key })).success;
  } catch {
    return true;
  }
}

export function tooManyRequests(): Response {
  return json(
    { error: "Too many requests, slow down" },
    { status: 429, headers: { "retry-after": "60" } },
  );
}

export type { Env };
