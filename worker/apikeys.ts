import type { Env } from "./env.ts";
import { HttpError, json, newId, readJson, requireString } from "./util.ts";

// ---------------------------------------------------------------------------
// API keys for the MCP endpoint. Only the SHA-256 hash is stored.
// Scopes: read (list/get/search), write (create/update/move/timers),
// delete (destructive tools; opt-in).
// The same principal shape is produced for OAuth access tokens (oauth.ts).
// ---------------------------------------------------------------------------

export type Scope = "read" | "write" | "delete";
export const ALL_SCOPES: Scope[] = ["read", "write", "delete"];

export interface ApiPrincipal {
  userId: string;
  scopes: Set<Scope>;
  /** How the caller authenticated, and a human label (key name / client name). */
  source: "api_key" | "oauth";
  credential: string;
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** URL-safe random token with a prefix, e.g. tm_..., tmo_..., tmr_... */
export function randomToken(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${prefix}${b64}`;
}

export function parseScopes(raw: string): Set<Scope> {
  return new Set(
    raw.split(/[,\s]+/).filter((s): s is Scope => ALL_SCOPES.includes(s as Scope)),
  );
}

/** Reads the key from `Authorization: Bearer` or `X-API-Key`. */
function extractKey(req: Request): string | null {
  const auth = req.headers.get("Authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m) return m[1].trim();
  }
  return req.headers.get("X-API-Key")?.trim() || null;
}

async function authenticateOAuthToken(
  token: string,
  env: Env,
  ctx?: ExecutionContext,
): Promise<ApiPrincipal | null> {
  const row = await env.DB.prepare(
    `SELECT t.id, t.user_id, t.scopes, t.last_used_at, c.client_name
       FROM oauth_tokens t JOIN oauth_clients c ON c.client_id = t.client_id
      WHERE t.access_hash = ? AND t.revoked_at IS NULL AND t.access_expires_at > ?`,
  )
    .bind(await sha256Hex(token), new Date().toISOString())
    .first<{ id: string; user_id: string; scopes: string; last_used_at: string | null; client_name: string }>();
  if (!row) return null;

  // Throttle updates: only touch DB if not updated in the last 5 minutes
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  if (!row.last_used_at || row.last_used_at < fiveMinAgo) {
    const p = env.DB.prepare(
      "UPDATE oauth_tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)",
    )
      .bind(new Date().toISOString(), row.id, fiveMinAgo)
      .run()
      .catch(() => undefined);
    if (ctx) ctx.waitUntil(p);
  }

  return {
    userId: row.user_id,
    scopes: parseScopes(row.scopes),
    source: "oauth",
    credential: row.client_name,
  };
}

/**
 * Resolves the request's credential (API key `tm_...` or OAuth access token
 * `tmo_...`) to a principal, or null if invalid/revoked/expired.
 */
export async function authenticateApiKey(
  req: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<ApiPrincipal | null> {
  const key = extractKey(req);
  if (!key) return null;
  if (key.startsWith("tmo_")) return authenticateOAuthToken(key, env, ctx);
  if (!key.startsWith("tm_")) return null;
  const hash = await sha256Hex(key);
  const row = await env.DB.prepare(
    "SELECT id, user_id, scopes, name, last_used_at FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL",
  )
    .bind(hash)
    .first<{ id: string; user_id: string; scopes: string; name: string; last_used_at: string | null }>();
  if (!row) return null;

  // Throttle updates: only touch DB if not updated in the last 5 minutes
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  if (!row.last_used_at || row.last_used_at < fiveMinAgo) {
    const p = env.DB.prepare(
      "UPDATE api_keys SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)",
    )
      .bind(new Date().toISOString(), row.id, fiveMinAgo)
      .run()
      .catch(() => undefined);
    if (ctx) ctx.waitUntil(p);
  }

  return {
    userId: row.user_id,
    scopes: parseScopes(row.scopes),
    source: "api_key",
    credential: row.name,
  };
}

// ---- Management routes (session-cookie authenticated) ----

/** POST /api/api-keys  { name, scopes? } - plaintext key is returned once. */
export async function createApiKey(
  req: Request,
  userId: string,
  env: Env,
): Promise<Response> {
  const body = await readJson<{ name?: string; scopes?: unknown }>(req);
  const name = requireString(body.name, "name", { max: 100 });
  let scopes: Scope[] = ["read", "write"];
  if (body.scopes !== undefined) {
    if (
      !Array.isArray(body.scopes) ||
      body.scopes.length === 0 ||
      !body.scopes.every((s) => ALL_SCOPES.includes(s as Scope))
    ) {
      throw new HttpError(400, "scopes must be a non-empty array of read|write|delete");
    }
    scopes = [...new Set(body.scopes as Scope[])];
  }
  const key = randomToken("tm_");
  const id = newId();
  await env.DB.prepare(
    "INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, scopes) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, userId, name, await sha256Hex(key), key.slice(0, 10), scopes.join(","))
    .run();
  return json(
    { id, name, scopes, key, note: "Store this key now; it cannot be shown again." },
    { status: 201 },
  );
}

/** GET /api/api-keys */
export async function listApiKeys(userId: string, env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, name, key_prefix, scopes, created_at, last_used_at, revoked_at
       FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`,
  )
    .bind(userId)
    .all();
  return json({ keys: results });
}

/** DELETE /api/api-keys/:id - revokes (keeps the row for audit). */
export async function revokeApiKey(
  id: string,
  userId: string,
  env: Env,
): Promise<Response> {
  const res = await env.DB.prepare(
    "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
  )
    .bind(new Date().toISOString(), id, userId)
    .run();
  if (!res.meta.changes) throw new HttpError(404, "API key not found");
  return json({ ok: true });
}
