import type { Env } from "../env.ts";
import type { PomodoroPhase, PomodoroSession, PomodoroSettings } from "../../shared/types.ts";
import { assertTaskOwner } from "../db.ts";
import { HttpError, json, newId, nowIso, readJson } from "../util.ts";
import { getPomodoroSettings } from "./settings.ts";
import { openEntry } from "./timer.ts";

// ---------------------------------------------------------------------------
// Pomodoro = a schedule layered on the normal timer. A focus interval is an
// ordinary time entry on the task; breaks record nothing. All times are stored
// as absolute timestamps and clients compute the countdown themselves, so
// nothing ticks on the server. Phase changes are applied lazily: whenever the
// session is read or acted upon, phases that have already ended are settled
// at their exact end time (the same approach as the forgotten-timer auto-stop).
// ---------------------------------------------------------------------------

type Status = "running" | "paused" | "waiting";

interface Row {
  user_id: string;
  task_id: string;
  phase: PomodoroPhase;
  status: Status;
  phase_started_at: string | null;
  phase_ends_at: string | null;
  remaining_ms: number | null;
  cycle: number;
}

interface LoadedRow extends Row {
  task_title: string | null;
  board_id: string | null;
}

/** Auto-start only continues a chain this soon after a phase really ended. */
const AUTO_START_GRACE_MS = 120_000;
const MAX_CHAIN = 10;

function phaseMs(cfg: PomodoroSettings, phase: PomodoroPhase): number {
  const min =
    phase === "focus" ? cfg.focus_min : phase === "short_break" ? cfg.short_min : cfg.long_min;
  return min * 60_000;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Ends the user's open focus entry for `taskId` at `at` (never before it started). */
async function closeFocusEntry(env: Env, userId: string, taskId: string, at: string): Promise<void> {
  const r = await env.DB.prepare(
    `SELECT id, started_at FROM time_entries
      WHERE user_id = ? AND task_id = ? AND ended_at IS NULL
      ORDER BY started_at DESC LIMIT 1`,
  )
    .bind(userId, taskId)
    .first<{ id: string; started_at: string }>();
  if (!r) return;
  const startMs = Date.parse(r.started_at);
  const endMs = Math.max(Date.parse(at), startMs);
  await env.DB.prepare(
    "UPDATE time_entries SET ended_at = ?, duration_seconds = ? WHERE id = ? AND ended_at IS NULL",
  )
    .bind(iso(endMs), Math.round((endMs - startMs) / 1000), r.id)
    .run();
}

async function loadRow(env: Env, userId: string): Promise<LoadedRow | null> {
  const row = await env.DB.prepare(
    `SELECT s.user_id, s.task_id, s.phase, s.status, s.phase_started_at, s.phase_ends_at,
            s.remaining_ms, s.cycle, t.title AS task_title, b.id AS board_id
       FROM pomodoro_sessions s
       LEFT JOIN tasks t   ON t.id = s.task_id
       LEFT JOIN columns c ON c.id = t.column_id
       LEFT JOIN boards b  ON b.id = c.board_id
      WHERE s.user_id = ?`,
  )
    .bind(userId)
    .first<LoadedRow>();
  if (!row) return null;
  if (row.task_title === null) {
    // The task was deleted under the session.
    await deleteRow(env, userId);
    return null;
  }
  return row;
}

async function deleteRow(env: Env, userId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM pomodoro_sessions WHERE user_id = ?").bind(userId).run();
}

async function saveRow(env: Env, r: Row): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO pomodoro_sessions
       (user_id, task_id, phase, status, phase_started_at, phase_ends_at, remaining_ms, cycle, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       task_id = excluded.task_id, phase = excluded.phase, status = excluded.status,
       phase_started_at = excluded.phase_started_at, phase_ends_at = excluded.phase_ends_at,
       remaining_ms = excluded.remaining_ms, cycle = excluded.cycle, updated_at = excluded.updated_at`,
  )
    .bind(
      r.user_id,
      r.task_id,
      r.phase,
      r.status,
      r.phase_started_at,
      r.phase_ends_at,
      r.remaining_ms,
      r.cycle,
      nowIso(),
    )
    .run();
}

/** Settles every phase that has already ended, at its exact end time. */
async function advance(env: Env, row: LoadedRow, cfg: PomodoroSettings): Promise<LoadedRow> {
  let changed = false;
  for (let i = 0; i < MAX_CHAIN; i++) {
    if (row.status !== "running" || !row.phase_ends_at) break;
    const endMs = Date.parse(row.phase_ends_at);
    if (Date.now() < endMs) break;
    changed = true;

    let next: PomodoroPhase;
    if (row.phase === "focus") {
      await closeFocusEntry(env, row.user_id, row.task_id, row.phase_ends_at);
      await env.DB.prepare(
        "INSERT INTO pomodoro_done (id, user_id, task_id, completed_at) VALUES (?, ?, ?, ?)",
      )
        .bind(newId(), row.user_id, row.task_id, row.phase_ends_at)
        .run();
      row.cycle += 1;
      next = row.cycle % cfg.long_every === 0 ? "long_break" : "short_break";
    } else {
      next = "focus";
    }

    const fresh = Date.now() - endMs <= AUTO_START_GRACE_MS;
    if (cfg.auto_start && fresh) {
      if (next === "focus") await openEntry(env, row.user_id, row.task_id, iso(endMs));
      row.phase = next;
      row.status = "running";
      row.phase_started_at = iso(endMs);
      row.phase_ends_at = iso(endMs + phaseMs(cfg, next));
      row.remaining_ms = null;
      continue; // the new phase may itself already be over
    }
    row.phase = next;
    row.status = "waiting";
    row.phase_started_at = null;
    row.phase_ends_at = null;
    row.remaining_ms = phaseMs(cfg, next);
    break;
  }
  if (changed) await saveRow(env, row);
  return row;
}

function toView(row: LoadedRow, cfg: PomodoroSettings): PomodoroSession {
  return {
    task_id: row.task_id,
    task_title: row.task_title ?? "",
    board_id: row.board_id ?? "",
    phase: row.phase,
    status: row.status,
    phase_started_at: row.phase_started_at,
    phase_ends_at: row.status === "running" ? row.phase_ends_at : null,
    remaining_seconds: row.status === "running" ? null : Math.round((row.remaining_ms ?? 0) / 1000),
    duration_seconds: Math.round(phaseMs(cfg, row.phase) / 1000),
    cycle: row.cycle,
  };
}

async function state(env: Env, userId: string): Promise<Response> {
  const cfg = await getPomodoroSettings(env, userId);
  let row = await loadRow(env, userId);
  if (row) row = await advance(env, row, cfg);
  return json({ session: row ? toView(row, cfg) : null, settings: cfg });
}

/** The task must exist, be the user's, and live on a board with Pomodoro switched on. */
async function assertPomodoroTask(env: Env, userId: string, taskId: string): Promise<void> {
  await assertTaskOwner(env, userId, taskId);
  const b = await env.DB.prepare(
    `SELECT b.pomodoro_enabled AS enabled
       FROM tasks t JOIN columns c ON c.id = t.column_id JOIN boards b ON b.id = c.board_id
      WHERE t.id = ?`,
  )
    .bind(taskId)
    .first<{ enabled: number }>();
  if (!b || b.enabled !== 1) {
    throw new HttpError(409, "Pomodoro is not enabled for this board (Settings > Pomodoro)");
  }
}

/** GET /api/pomodoro */
export async function getPomodoro(userId: string, env: Env): Promise<Response> {
  return state(env, userId);
}

/** POST /api/pomodoro/:action — start | next | pause | resume | skip | stop */
export async function pomodoroAction(
  req: Request,
  action: string,
  userId: string,
  env: Env,
): Promise<Response> {
  const cfg = await getPomodoroSettings(env, userId);
  let row = await loadRow(env, userId);
  if (row) row = await advance(env, row, cfg);
  const now = Date.now();

  if (action === "start") {
    const body = await readJson<{ task_id?: unknown }>(req);
    if (typeof body.task_id !== "string" || !body.task_id) {
      throw new HttpError(400, "task_id is required");
    }
    await assertPomodoroTask(env, userId, body.task_id);
    // openEntry stops whatever the user had running (including a previous focus).
    await openEntry(env, userId, body.task_id, iso(now));
    await saveRow(env, {
      user_id: userId,
      task_id: body.task_id,
      phase: "focus",
      status: "running",
      phase_started_at: iso(now),
      phase_ends_at: iso(now + phaseMs(cfg, "focus")),
      remaining_ms: null,
      cycle: 0,
    });
    return state(env, userId);
  }

  if (action === "stop") {
    if (row && row.phase === "focus" && row.status === "running") {
      await closeFocusEntry(env, userId, row.task_id, iso(now));
    }
    await deleteRow(env, userId);
    return state(env, userId);
  }

  if (!row) throw new HttpError(409, "No Pomodoro session is active");

  if (action === "next") {
    if (row.status !== "waiting") throw new HttpError(409, "Nothing is waiting to start");
    const body = await readJson<{ task_id?: unknown }>(req).catch(() => ({}) as { task_id?: unknown });
    if (row.phase === "focus") {
      if (typeof body.task_id === "string" && body.task_id) row.task_id = body.task_id;
      await assertPomodoroTask(env, userId, row.task_id);
      await openEntry(env, userId, row.task_id, iso(now));
    }
    row.status = "running";
    row.phase_started_at = iso(now);
    row.phase_ends_at = iso(now + (row.remaining_ms ?? phaseMs(cfg, row.phase)));
    row.remaining_ms = null;
    await saveRow(env, row);
    return state(env, userId);
  }

  if (action === "pause") {
    if (row.status !== "running" || !row.phase_ends_at) throw new HttpError(409, "Nothing is running");
    if (row.phase === "focus") await closeFocusEntry(env, userId, row.task_id, iso(now));
    row.remaining_ms = Math.max(1000, Date.parse(row.phase_ends_at) - now);
    row.status = "paused";
    row.phase_ends_at = null;
    await saveRow(env, row);
    return state(env, userId);
  }

  if (action === "resume") {
    if (row.status !== "paused") throw new HttpError(409, "The session is not paused");
    if (row.phase === "focus") {
      await assertPomodoroTask(env, userId, row.task_id);
      await openEntry(env, userId, row.task_id, iso(now));
    }
    row.status = "running";
    row.phase_ends_at = iso(now + (row.remaining_ms ?? phaseMs(cfg, row.phase)));
    row.remaining_ms = null;
    await saveRow(env, row);
    return state(env, userId);
  }

  if (action === "skip") {
    if (row.status === "waiting" && row.phase === "focus") {
      throw new HttpError(409, "Nothing to skip: the next focus is ready to start");
    }
    if (row.phase === "focus" && row.status === "running") {
      await closeFocusEntry(env, userId, row.task_id, iso(now));
    }
    // Skipping a focus never earns the long break; skipping a break goes back to focus.
    const next: PomodoroPhase = row.phase === "focus" ? "short_break" : "focus";
    row.phase = next;
    row.status = "waiting";
    row.phase_started_at = null;
    row.phase_ends_at = null;
    row.remaining_ms = phaseMs(cfg, next);
    await saveRow(env, row);
    return state(env, userId);
  }

  throw new HttpError(404, "Unknown Pomodoro action");
}

/**
 * Ends the session if it belongs to `boardId` (used when Pomodoro is switched
 * off for a board). A running focus interval is closed at this moment.
 */
export async function endSessionOnBoard(env: Env, userId: string, boardId: string): Promise<void> {
  const row = await loadRow(env, userId);
  if (!row || row.board_id !== boardId) return;
  if (row.phase === "focus" && row.status === "running") {
    await closeFocusEntry(env, userId, row.task_id, nowIso());
  }
  await deleteRow(env, userId);
}
