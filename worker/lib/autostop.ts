import type { Env } from "../env.ts";

// "Stop a forgotten timer after N hours" (Settings > Time tracking).
// Enforced lazily, without a cron: whenever a timer is read, started or
// stopped, an entry that ran past the limit is ended at start + limit.

export async function getAutoStopHours(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT auto_stop_hours FROM user_settings WHERE user_id = ?")
    .bind(userId)
    .first<{ auto_stop_hours: number }>();
  return row?.auto_stop_hours ?? 0;
}

/** The end time to record: `endedAt`, but never later than start + limit. */
export function cappedEnd(startedAt: string, endedAt: string, hours: number): string {
  if (hours <= 0) return endedAt;
  const limit = new Date(startedAt).getTime() + hours * 3_600_000;
  return new Date(Math.min(new Date(endedAt).getTime(), limit)).toISOString();
}

/** Ends the user's running timer if it has exceeded their limit. */
export async function autoStopExpired(env: Env, userId: string): Promise<void> {
  const hours = await getAutoStopHours(env, userId);
  if (hours <= 0) return;
  const running = await env.DB.prepare(
    "SELECT id, started_at FROM time_entries WHERE user_id = ? AND ended_at IS NULL LIMIT 1",
  )
    .bind(userId)
    .first<{ id: string; started_at: string }>();
  if (!running) return;
  const limitMs = new Date(running.started_at).getTime() + hours * 3_600_000;
  if (Date.now() <= limitMs) return;
  await env.DB.prepare(
    "UPDATE time_entries SET ended_at = ?, duration_seconds = ? WHERE id = ? AND ended_at IS NULL",
  )
    .bind(new Date(limitMs).toISOString(), hours * 3600, running.id)
    .run();
}
