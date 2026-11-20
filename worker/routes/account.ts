import type { Env } from "../env.ts";
import { createSessionToken, hashPassword, sessionCookie, verifyPassword } from "../auth.ts";
import { HttpError, json, readJson, requireString } from "../util.ts";

async function invalidateOtherSessions(env: Env, userId: string): Promise<Response> {
  await env.DB.prepare("UPDATE users SET sessions_valid_after = ? WHERE id = ?")
    .bind(new Date().toISOString(), userId)
    .run();
  // The current device gets a fresh session; every older one stops working.
  const token = await createSessionToken(userId, env);
  return json({ ok: true }, { headers: { "Set-Cookie": sessionCookie(token) } });
}

/** POST /api/account/password - { current_password, new_password } */
export async function changePassword(req: Request, userId: string, env: Env): Promise<Response> {
  const body = await readJson<{ current_password?: unknown; new_password?: unknown }>(req);
  const current = requireString(body.current_password, "current_password", { max: 200 });
  const next = requireString(body.new_password, "new_password", { min: 8, max: 200 });

  const row = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?")
    .bind(userId)
    .first<{ password_hash: string }>();
  if (!row || !(await verifyPassword(current, row.password_hash))) {
    throw new HttpError(403, "Current password is incorrect");
  }
  if (current === next) throw new HttpError(400, "New password must be different");

  await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
    .bind(await hashPassword(next), userId)
    .run();
  return invalidateOtherSessions(env, userId);
}

/** POST /api/account/sign-out-everywhere - ends sessions on all other devices. */
export async function signOutEverywhere(userId: string, env: Env): Promise<Response> {
  return invalidateOtherSessions(env, userId);
}
