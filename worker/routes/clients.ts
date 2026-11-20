import type { Env } from "../env.ts";
import type { Client } from "../../shared/types.ts";
import { assertClientOwner } from "../db.ts";
import { HttpError, json, newId, readJson, requireString } from "../util.ts";

interface ClientRow {
  id: string;
  name: string;
  color: string | null;
  is_personal: number;
  rate_minor: number | null;
  currency: string;
  archived_at: string | null;
  board_count: number;
}

const SELECT = `SELECT c.id, c.name, c.color, c.is_personal, c.rate_minor, c.currency, c.archived_at,
                       (SELECT COUNT(*) FROM boards b WHERE b.client_id = c.id) AS board_count
                  FROM clients c`;

function toClient(r: ClientRow): Client {
  return { ...r, is_personal: r.is_personal === 1 };
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

function parseColor(v: unknown): string | null {
  if (v === null || v === "") return null;
  if (typeof v !== "string" || !COLOR_RE.test(v)) {
    throw new HttpError(400, "color must be a #rrggbb hex value");
  }
  return v.toLowerCase();
}

function parseRate(v: unknown): number | null {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 1_000_000_000) {
    throw new HttpError(400, "rate_minor must be a non-negative integer (minor units) or null");
  }
  return v;
}

function parseCurrency(v: unknown): string {
  const c = typeof v === "string" ? v.trim().toUpperCase() : "";
  if (!CURRENCY_RE.test(c)) throw new HttpError(400, "currency must be a 3-letter code, e.g. USD");
  return c;
}

async function getOne(env: Env, userId: string, id: string): Promise<Client> {
  const row = await env.DB.prepare(`${SELECT} WHERE c.id = ? AND c.user_id = ?`)
    .bind(id, userId)
    .first<ClientRow>();
  if (!row) throw new HttpError(404, "Client not found");
  return toClient(row);
}

/** GET /api/clients */
export async function listClients(userId: string, env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `${SELECT} WHERE c.user_id = ? ORDER BY c.archived_at IS NOT NULL, c.created_at ASC`,
  )
    .bind(userId)
    .all<ClientRow>();
  return json({ clients: results.map(toClient) });
}

/** POST /api/clients */
export async function createClient(req: Request, userId: string, env: Env): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(req);
  const name = requireString(body.name, "name", { max: 100 });
  const dup = await env.DB.prepare(
    "SELECT 1 FROM clients WHERE user_id = ? AND lower(name) = lower(?)",
  )
    .bind(userId, name)
    .first();
  if (dup) throw new HttpError(409, "A client with this name already exists");
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO clients (id, user_id, name, color, is_personal, rate_minor, currency)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      userId,
      name,
      body.color === undefined ? null : parseColor(body.color),
      body.is_personal === true ? 1 : 0,
      body.rate_minor === undefined ? null : parseRate(body.rate_minor),
      body.currency === undefined ? "USD" : parseCurrency(body.currency),
    )
    .run();
  return json({ client: await getOne(env, userId, id) }, { status: 201 });
}

/** PATCH /api/clients/:id — any subset of fields; archived: boolean. */
export async function updateClient(
  req: Request,
  clientId: string,
  userId: string,
  env: Env,
): Promise<Response> {
  await assertClientOwner(env, userId, clientId);
  const body = await readJson<Record<string, unknown>>(req);
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.name !== undefined) {
    const name = requireString(body.name, "name", { max: 100 });
    const dup = await env.DB.prepare(
      "SELECT 1 FROM clients WHERE user_id = ? AND lower(name) = lower(?) AND id <> ?",
    )
      .bind(userId, name, clientId)
      .first();
    if (dup) throw new HttpError(409, "A client with this name already exists");
    sets.push("name = ?");
    binds.push(name);
  }
  if (body.color !== undefined) {
    sets.push("color = ?");
    binds.push(parseColor(body.color));
  }
  if (body.is_personal !== undefined) {
    sets.push("is_personal = ?");
    binds.push(body.is_personal === true ? 1 : 0);
  }
  if (body.rate_minor !== undefined) {
    sets.push("rate_minor = ?");
    binds.push(parseRate(body.rate_minor));
  }
  if (body.currency !== undefined) {
    sets.push("currency = ?");
    binds.push(parseCurrency(body.currency));
  }
  if (body.archived !== undefined) {
    sets.push("archived_at = ?");
    binds.push(body.archived === true ? new Date().toISOString() : null);
  }
  if (sets.length === 0) throw new HttpError(400, "Nothing to update");
  binds.push(clientId);
  await env.DB.prepare(`UPDATE clients SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  return json({ client: await getOne(env, userId, clientId) });
}

/** DELETE /api/clients/:id — boards stay, just detached. Tracked time is untouched. */
export async function deleteClient(clientId: string, userId: string, env: Env): Promise<Response> {
  await assertClientOwner(env, userId, clientId);
  // D1 does not reliably enforce ON DELETE SET NULL; detach explicitly.
  await env.DB.batch([
    env.DB.prepare("UPDATE boards SET client_id = NULL WHERE client_id = ? AND user_id = ?").bind(
      clientId,
      userId,
    ),
    env.DB.prepare("DELETE FROM clients WHERE id = ? AND user_id = ?").bind(clientId, userId),
  ]);
  return json({ ok: true });
}

/**
 * Resolves a client reference given by id or (case-insensitive) name.
 * Returns null for "none"/empty-ish values meaning "no client".
 */
export async function resolveClientRef(
  env: Env,
  userId: string,
  ref: string,
): Promise<string | null> {
  const r = ref.trim();
  if (!r || r.toLowerCase() === "none") return null;
  const byId = await env.DB.prepare("SELECT id FROM clients WHERE id = ? AND user_id = ?")
    .bind(r, userId)
    .first<{ id: string }>();
  if (byId) return byId.id;
  const { results } = await env.DB.prepare(
    "SELECT id FROM clients WHERE user_id = ? AND lower(name) = lower(?)",
  )
    .bind(userId, r)
    .all<{ id: string }>();
  if (results.length === 1) return results[0].id;
  throw new HttpError(404, `Client "${r}" not found (use list_clients)`);
}
