import type { Env } from "../env.ts";

/**
 * Ends the user's Pomodoro session, if any. Used whenever the user takes the
 * plain timer into their own hands (start/stop it directly), so the two modes
 * never fight over the single running timer. Does not touch time entries.
 */
export async function clearPomodoroSession(env: Env, userId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM pomodoro_sessions WHERE user_id = ?").bind(userId).run();
}
