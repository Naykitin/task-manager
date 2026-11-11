import type { Env } from "../env.ts";
import { HttpError, json } from "../util.ts";

// Management endpoints for the Settings > Integrations UI (session cookie auth):
// connected OAuth apps and the MCP activity log.

/** GET /api/oauth/grants - one row per connected app with live tokens. */
export async function listGrants(userId: string, env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `WITH active_tokens AS (
       SELECT t.client_id, t.scopes, t.created_at, t.last_used_at,
              ROW_NUMBER() OVER (PARTITION BY t.client_id ORDER BY t.created_at DESC) AS rn,
              MIN(t.created_at) OVER (PARTITION BY t.client_id) AS connected_at,
              MAX(t.last_used_at) OVER (PARTITION BY t.client_id) AS max_last_used
         FROM oauth_tokens t
        WHERE t.user_id = ?2 AND t.revoked_at IS NULL AND t.refresh_expires_at > ?1
     )
     SELECT c.client_id, c.client_name, a.scopes, a.connected_at, a.max_last_used AS last_used_at
       FROM active_tokens a
       JOIN oauth_clients c ON c.client_id = a.client_id
      WHERE a.rn = 1
      ORDER BY a.connected_at DESC`,
  )
    .bind(new Date().toISOString(), userId)
    .all();
  return json({ grants: results });
}

/** DELETE /api/oauth/grants/:clientId - revoke every token of that app. */
export async function revokeGrant(
  clientId: string,
  userId: string,
  env: Env,
): Promise<Response> {
  const res = await env.DB.prepare(
    "UPDATE oauth_tokens SET revoked_at = ? WHERE client_id = ? AND user_id = ? AND revoked_at IS NULL",
  )
    .bind(new Date().toISOString(), clientId, userId)
    .run();
  if (!res.meta.changes) throw new HttpError(404, "Connected app not found");
  return json({ ok: true });
}

/** GET /api/mcp/activity?limit= - most recent MCP tool calls. */
export async function listActivity(
  url: URL,
  userId: string,
  env: Env,
): Promise<Response> {
  const limit = Math.min(
    Math.max(Number(url.searchParams.get("limit") ?? "100") || 100, 1),
    500,
  );
  const { results } = await env.DB.prepare(
    `SELECT id, source, credential, tool, ok, error, created_at
       FROM mcp_audit_log WHERE user_id = ?
      ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(userId, limit)
    .all();
  return json({ activity: results });
}
