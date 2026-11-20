import type { Env } from "../env.ts";
import { decryptSecret, encryptSecret, encryptionAvailable } from "../lib/secretbox.ts";
import { HttpError, json, readJson } from "../util.ts";

// Per-user settings: voice toggle, timer auto-stop, Anthropic API key.

interface SettingsRow {
  voice_enabled: number;
  auto_stop_hours: number;
  anthropic_key_enc: string | null;
  anthropic_key_last4: string | null;
}

async function loadRow(env: Env, userId: string): Promise<SettingsRow> {
  const row = await env.DB.prepare(
    `SELECT voice_enabled, auto_stop_hours, anthropic_key_enc, anthropic_key_last4
       FROM user_settings WHERE user_id = ?`,
  )
    .bind(userId)
    .first<SettingsRow>();
  return (
    row ?? { voice_enabled: 0, auto_stop_hours: 0, anthropic_key_enc: null, anthropic_key_last4: null }
  );
}

export async function isVoiceEnabled(env: Env, userId: string): Promise<boolean> {
  return (await loadRow(env, userId)).voice_enabled === 1;
}

/**
 * The key to use for this user: their own saved key first, otherwise the
 * server-wide ANTHROPIC_API_KEY secret (if any).
 */
export async function resolveAnthropicKey(
  env: Env,
  userId: string,
): Promise<{ key: string; source: "user" | "server" } | null> {
  const row = await loadRow(env, userId);
  if (row.anthropic_key_enc) {
    const key = await decryptSecret(env, userId, row.anthropic_key_enc);
    if (key) return { key, source: "user" };
  }
  const server = env.ANTHROPIC_API_KEY?.trim();
  return server ? { key: server, source: "server" } : null;
}

/** Upserts one or more columns of the user's settings row. */
async function upsert(env: Env, userId: string, patch: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(patch);
  await env.DB.prepare(
    `INSERT INTO user_settings (user_id, ${cols.join(", ")}, updated_at)
     VALUES (?, ${cols.map(() => "?").join(", ")}, ?)
     ON CONFLICT(user_id) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(", ")},
       updated_at = excluded.updated_at`,
  )
    .bind(userId, ...cols.map((c) => patch[c]), new Date().toISOString())
    .run();
}

async function view(env: Env, userId: string) {
  const row = await loadRow(env, userId);
  const resolved = await resolveAnthropicKey(env, userId);
  return {
    voice_enabled: row.voice_enabled === 1,
    auto_stop_hours: row.auto_stop_hours,
    anthropic: {
      configured: resolved !== null,
      source: resolved?.source ?? null,
      last4: resolved?.source === "user" ? row.anthropic_key_last4 : null,
    },
    encryption_available: encryptionAvailable(env),
  };
}

/** GET /api/settings */
export async function getSettings(userId: string, env: Env): Promise<Response> {
  return json(await view(env, userId));
}

/** PATCH /api/settings - { voice_enabled?, auto_stop_hours? } */
export async function updateSettings(req: Request, userId: string, env: Env): Promise<Response> {
  const body = await readJson<{ voice_enabled?: unknown; auto_stop_hours?: unknown }>(req);
  const patch: Record<string, unknown> = {};
  if (body.voice_enabled !== undefined) {
    if (typeof body.voice_enabled !== "boolean") {
      throw new HttpError(400, "voice_enabled must be true or false");
    }
    patch.voice_enabled = body.voice_enabled ? 1 : 0;
  }
  if (body.auto_stop_hours !== undefined) {
    const h = body.auto_stop_hours;
    if (typeof h !== "number" || !Number.isInteger(h) || h < 0 || h > 72) {
      throw new HttpError(400, "auto_stop_hours must be a whole number from 0 to 72");
    }
    patch.auto_stop_hours = h;
  }
  if (Object.keys(patch).length === 0) throw new HttpError(400, "Nothing to update");
  await upsert(env, userId, patch);
  return json(await view(env, userId));
}

/** Asks Anthropic whether the key is accepted. Only a definite rejection fails. */
async function keyIsRejected(key: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    });
    return res.status === 401 || res.status === 403;
  } catch {
    return false; // network hiccup: do not block saving
  }
}

/** PUT /api/settings/anthropic-key - { key } (stored encrypted, never returned). */
export async function saveAnthropicKey(req: Request, userId: string, env: Env): Promise<Response> {
  const body = await readJson<{ key?: unknown }>(req);
  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!/^sk-ant-[A-Za-z0-9_-]{20,300}$/.test(key)) {
    throw new HttpError(400, "That does not look like an Anthropic API key (expected sk-ant-...)");
  }
  const encrypted = await encryptSecret(env, userId, key); // 503 if no server secret
  if (await keyIsRejected(key)) {
    throw new HttpError(400, "Anthropic rejected this key. Check that it is correct and active.");
  }
  await upsert(env, userId, { anthropic_key_enc: encrypted, anthropic_key_last4: key.slice(-4) });
  return json(await view(env, userId));
}

/** DELETE /api/settings/anthropic-key */
export async function deleteAnthropicKey(userId: string, env: Env): Promise<Response> {
  await upsert(env, userId, { anthropic_key_enc: null, anthropic_key_last4: null });
  return json(await view(env, userId));
}
