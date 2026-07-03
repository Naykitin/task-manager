import type { Env } from "../env.ts";
import type { User } from "../../shared/types.ts";
import {
  clearSessionCookie,
  createSessionToken,
  hashPassword,
  sessionCookie,
  verifyPassword,
} from "../auth.ts";
import { HttpError, json, newId, readJson, requireString } from "../util.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Seed a fresh account with one default board + To Do / In Progress / Done. */
async function createDefaultBoard(env: Env, userId: string): Promise<void> {
  const boardId = newId();
  const stmts = [
    env.DB.prepare(
      "INSERT INTO boards (id, user_id, name) VALUES (?, ?, ?)",
    ).bind(boardId, userId, "My Board"),
  ];
  const cols = ["To Do", "In Progress", "Done"];
  cols.forEach((name, i) => {
    stmts.push(
      env.DB.prepare(
        "INSERT INTO columns (id, board_id, name, position) VALUES (?, ?, ?, ?)",
      ).bind(newId(), boardId, name, i),
    );
  });
  await env.DB.batch(stmts);
}

export async function register(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{
    email?: string;
    password?: string;
    inviteCode?: string;
  }>(req);

  const email = requireString(body.email, "email", { max: 254 }).toLowerCase();
  const password = requireString(body.password, "password", { min: 8, max: 200 });
  const inviteCode = requireString(body.inviteCode, "inviteCode", { max: 200 });

  if (!EMAIL_RE.test(email)) {
    throw new HttpError(400, "Please enter a valid email address");
  }
  if (!env.INVITE_CODE) {
    throw new HttpError(500, "Server misconfigured: INVITE_CODE is not set");
  }
  if (inviteCode !== env.INVITE_CODE) {
    throw new HttpError(403, "Invalid invite code");
  }

  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(email)
    .first();
  if (existing) {
    throw new HttpError(409, "An account with that email already exists");
  }

  const id = newId();
  const passwordHash = await hashPassword(password);
  await env.DB.prepare(
    "INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)",
  )
    .bind(id, email, passwordHash)
    .run();

  await createDefaultBoard(env, id);

  const user = await env.DB.prepare(
    "SELECT id, email, created_at FROM users WHERE id = ?",
  )
    .bind(id)
    .first<User>();

  const token = await createSessionToken(id, env);
  return json(
    { user },
    { status: 201, headers: { "Set-Cookie": sessionCookie(token) } },
  );
}

export async function login(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{ email?: string; password?: string }>(req);
  const email = requireString(body.email, "email", { max: 254 }).toLowerCase();
  const password = requireString(body.password, "password", { max: 200 });

  const row = await env.DB.prepare(
    "SELECT id, email, password_hash, created_at FROM users WHERE email = ?",
  )
    .bind(email)
    .first<User & { password_hash: string }>();

  // Always run a verify to reduce timing side-channels on unknown emails.
  const ok =
    row != null && (await verifyPassword(password, row.password_hash));
  if (!row || !ok) {
    throw new HttpError(401, "Invalid email or password");
  }

  const token = await createSessionToken(row.id, env);
  const user: User = {
    id: row.id,
    email: row.email,
    created_at: row.created_at,
  };
  return json(
    { user },
    { headers: { "Set-Cookie": sessionCookie(token) } },
  );
}

export function logout(): Response {
  return json(
    { ok: true },
    { headers: { "Set-Cookie": clearSessionCookie() } },
  );
}

export async function me(userId: string, env: Env): Promise<Response> {
  const user = await env.DB.prepare(
    "SELECT id, email, created_at FROM users WHERE id = ?",
  )
    .bind(userId)
    .first<User>();
  if (!user) throw new HttpError(401, "Not authenticated");
  return json({ user });
}
