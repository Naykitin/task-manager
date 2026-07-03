import type { Env } from "../env.ts";
import type { TimeEntry } from "../../shared/types.ts";
import { assertTaskOwner } from "../db.ts";
import { HttpError, json, newId, nowIso } from "../util.ts";

function durationSeconds(startedAt: string, endedAt: string): number {
  const secs = Math.round(
    (new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000,
  );
  return Math.max(0, secs);
}

/** Stop whatever timer the user currently has running. Returns it if any. */
async function stopRunningForUser(
  env: Env,
  userId: string,
  endedAt: string,
): Promise<TimeEntry | null> {
  const running = await env.DB.prepare(
    `SELECT id, task_id, user_id, started_at, ended_at, duration_seconds
       FROM time_entries WHERE user_id = ? AND ended_at IS NULL
      ORDER BY started_at DESC LIMIT 1`,
  )
    .bind(userId)
    .first<TimeEntry>();
  if (!running) return null;

  const duration = durationSeconds(running.started_at, endedAt);
  await env.DB.prepare(
    "UPDATE time_entries SET ended_at = ?, duration_seconds = ? WHERE id = ?",
  )
    .bind(endedAt, duration, running.id)
    .run();
  return { ...running, ended_at: endedAt, duration_seconds: duration };
}

/** POST /api/tasks/:id/timer/start */
export async function startTimer(
  taskId: string,
  userId: string,
  env: Env,
): Promise<Response> {
  await assertTaskOwner(env, userId, taskId);
  const now = nowIso();

  // Enforce a single active timer: stop any currently running one first.
  const stopped = await stopRunningForUser(env, userId, now);

  const id = newId();
  await env.DB.prepare(
    "INSERT INTO time_entries (id, task_id, user_id, started_at, ended_at, duration_seconds) VALUES (?, ?, ?, ?, NULL, NULL)",
  )
    .bind(id, taskId, userId, now)
    .run();

  const entry: TimeEntry = {
    id,
    task_id: taskId,
    user_id: userId,
    started_at: now,
    ended_at: null,
    duration_seconds: null,
  };
  return json({ entry, stopped }, { status: 201 });
}

/** POST /api/tasks/:id/timer/stop */
export async function stopTimer(
  taskId: string,
  userId: string,
  env: Env,
): Promise<Response> {
  await assertTaskOwner(env, userId, taskId);
  const now = nowIso();

  const running = await env.DB.prepare(
    `SELECT id, task_id, user_id, started_at, ended_at, duration_seconds
       FROM time_entries WHERE task_id = ? AND user_id = ? AND ended_at IS NULL
      ORDER BY started_at DESC LIMIT 1`,
  )
    .bind(taskId, userId)
    .first<TimeEntry>();
  if (!running) throw new HttpError(409, "No running timer for this task");

  const duration = durationSeconds(running.started_at, now);
  await env.DB.prepare(
    "UPDATE time_entries SET ended_at = ?, duration_seconds = ? WHERE id = ?",
  )
    .bind(now, duration, running.id)
    .run();

  const entry: TimeEntry = {
    ...running,
    ended_at: now,
    duration_seconds: duration,
  };
  return json({ entry });
}

/** GET /api/tasks/:id/time-entries */
export async function listTimeEntries(
  taskId: string,
  userId: string,
  env: Env,
): Promise<Response> {
  await assertTaskOwner(env, userId, taskId);
  const { results } = await env.DB.prepare(
    `SELECT id, task_id, user_id, started_at, ended_at, duration_seconds
       FROM time_entries WHERE task_id = ?
      ORDER BY started_at DESC`,
  )
    .bind(taskId)
    .all<TimeEntry>();
  return json({ entries: results });
}
