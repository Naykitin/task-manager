import type { Env } from "../env.ts";
import type {
  ProjectSnapshot,
  ProjectSnapshotBoard,
  Task,
  TaskLink,
  TaskLinkView,
} from "../../shared/types.ts";
import { assertColumnOwner, assertTaskOwner } from "../db.ts";
import {
  HttpError,
  json,
  newId,
  nowIso,
  readJson,
  requireString,
} from "../util.ts";

/**
 * Builds (without executing) the INSERT statement for a new task row.
 * Shared by createTask (manual, executed immediately) and applyVoiceNote
 * (ai_voice, executed as part of a single D1 batch).
 */
export function buildInsertTaskStmt(
  env: Env,
  params: {
    id: string;
    columnId: string;
    title: string;
    description: string | null;
    position: number;
    source: Task["source"];
    originVoiceNoteId: string | null;
  },
): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT INTO tasks (id, column_id, title, description, position, source, origin_voice_note_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    params.id,
    params.columnId,
    params.title,
    params.description,
    params.position,
    params.source,
    params.originVoiceNoteId,
  );
}

export async function createTask(
  req: Request,
  userId: string,
  env: Env,
): Promise<Response> {
  const body = await readJson<{
    column_id?: string;
    title?: string;
    description?: string;
  }>(req);
  const columnId = requireString(body.column_id, "column_id");
  const title = requireString(body.title, "title", { max: 500 });
  const description =
    typeof body.description === "string" ? body.description.trim() : null;

  await assertColumnOwner(env, userId, columnId);

  const posRow = await env.DB.prepare(
    "SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM tasks WHERE column_id = ?",
  )
    .bind(columnId)
    .first<{ pos: number }>();

  const id = newId();
  await buildInsertTaskStmt(env, {
    id,
    columnId,
    title,
    description: description || null,
    position: posRow?.pos ?? 0,
    source: "manual",
    originVoiceNoteId: null,
  }).run();

  const task = await loadTask(env, id);
  return json({ task }, { status: 201 });
}

export async function updateTask(
  req: Request,
  taskId: string,
  userId: string,
  env: Env,
): Promise<Response> {
  await assertTaskOwner(env, userId, taskId);
  const body = await readJson<{ title?: string; description?: string }>(req);

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.title !== undefined) {
    sets.push("title = ?");
    binds.push(requireString(body.title, "title", { max: 500 }));
  }
  if (body.description !== undefined) {
    sets.push("description = ?");
    binds.push(
      typeof body.description === "string" && body.description.trim()
        ? body.description.trim()
        : null,
    );
  }
  if (sets.length === 0) throw new HttpError(400, "Nothing to update");

  sets.push("updated_at = ?");
  binds.push(nowIso());
  binds.push(taskId);
  await env.DB.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();

  const task = await loadTask(env, taskId);
  return json({ task });
}

export async function deleteTask(
  taskId: string,
  userId: string,
  env: Env,
): Promise<Response> {
  await assertTaskOwner(env, userId, taskId);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM time_entries WHERE task_id = ?").bind(taskId),
    env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(taskId),
  ]);
  return json({ ok: true });
}

/** PATCH /api/tasks/:id/move — { column_id, position } with full reindex. */
export async function moveTask(
  req: Request,
  taskId: string,
  userId: string,
  env: Env,
): Promise<Response> {
  await assertTaskOwner(env, userId, taskId);
  const body = await readJson<{ column_id?: string; position?: number }>(req);
  const targetColumnId = requireString(body.column_id, "column_id");
  const targetIndex =
    typeof body.position === "number" && body.position >= 0
      ? Math.floor(body.position)
      : 0;
  await assertColumnOwner(env, userId, targetColumnId);

  const current = await env.DB.prepare(
    "SELECT column_id FROM tasks WHERE id = ?",
  )
    .bind(taskId)
    .first<{ column_id: string }>();
  if (!current) throw new HttpError(404, "Task not found");
  const sourceColumnId = current.column_id;

  // Order of ids in the target column, excluding the moved task.
  const targetRows = await env.DB.prepare(
    "SELECT id FROM tasks WHERE column_id = ? AND id != ? ORDER BY position ASC, created_at ASC",
  )
    .bind(targetColumnId, taskId)
    .all<{ id: string }>();
  const order = targetRows.results.map((r) => r.id);
  const clamped = Math.min(targetIndex, order.length);
  order.splice(clamped, 0, taskId);

  const stmts = [
    env.DB.prepare("UPDATE tasks SET column_id = ?, updated_at = ? WHERE id = ?").bind(
      targetColumnId,
      nowIso(),
      taskId,
    ),
  ];
  order.forEach((id, i) => {
    stmts.push(
      env.DB.prepare("UPDATE tasks SET position = ? WHERE id = ?").bind(i, id),
    );
  });

  // If moving between columns, compact the source column too.
  if (sourceColumnId !== targetColumnId) {
    const srcRows = await env.DB.prepare(
      "SELECT id FROM tasks WHERE column_id = ? AND id != ? ORDER BY position ASC, created_at ASC",
    )
      .bind(sourceColumnId, taskId)
      .all<{ id: string }>();
    srcRows.results.forEach((r, i) => {
      stmts.push(
        env.DB.prepare("UPDATE tasks SET position = ? WHERE id = ?").bind(i, r.id),
      );
    });
  }

  await env.DB.batch(stmts);
  const task = await loadTask(env, taskId);
  return json({ task });
}

/**
 * Full boards/columns/tasks tree for a user, plus the links between their
 * tasks. Used as project context for the AI voice-note structuring prompt.
 */
export async function getProjectSnapshot(
  env: Env,
  userId: string,
): Promise<ProjectSnapshot> {
  const boardRows = await env.DB.prepare(
    "SELECT id, name FROM boards WHERE user_id = ? ORDER BY created_at ASC",
  )
    .bind(userId)
    .all<{ id: string; name: string }>();

  const columnRows = await env.DB.prepare(
    `SELECT c.id, c.name, c.board_id
       FROM columns c
       JOIN boards b ON b.id = c.board_id
      WHERE b.user_id = ?
      ORDER BY c.position ASC, c.name ASC`,
  )
    .bind(userId)
    .all<{ id: string; name: string; board_id: string }>();

  const taskRows = await env.DB.prepare(
    `SELECT t.id, t.column_id, t.title, t.description, t.source
       FROM tasks t
       JOIN columns c ON c.id = t.column_id
       JOIN boards b ON b.id = c.board_id
      WHERE b.user_id = ?
      ORDER BY t.position ASC, t.created_at ASC`,
  )
    .bind(userId)
    .all<{
      id: string;
      column_id: string;
      title: string;
      description: string | null;
      source: Task["source"];
    }>();

  // Only links where both ends belong to the requesting user — task_links
  // should never straddle two users, but this keeps the snapshot honest even
  // if that invariant is ever violated.
  const linkRows = await env.DB.prepare(
    `SELECT tl.id, tl.from_task_id, tl.to_task_id, tl.relation_type, tl.created_at
       FROM task_links tl
       JOIN tasks tf ON tf.id = tl.from_task_id
       JOIN columns cf ON cf.id = tf.column_id
       JOIN boards bf ON bf.id = cf.board_id
       JOIN tasks tt ON tt.id = tl.to_task_id
       JOIN columns ct ON ct.id = tt.column_id
       JOIN boards bt ON bt.id = ct.board_id
      WHERE bf.user_id = ? AND bt.user_id = ?`,
  )
    .bind(userId, userId)
    .all<TaskLink>();

  type SnapshotColumn = ProjectSnapshotBoard["columns"][number];

  const tasksByColumn = new Map<string, SnapshotColumn["tasks"]>();
  for (const t of taskRows.results) {
    const arr = tasksByColumn.get(t.column_id) ?? [];
    arr.push({
      id: t.id,
      title: t.title,
      description: t.description,
      source: t.source,
    });
    tasksByColumn.set(t.column_id, arr);
  }

  const columnsByBoard = new Map<string, SnapshotColumn[]>();
  for (const c of columnRows.results) {
    const arr = columnsByBoard.get(c.board_id) ?? [];
    arr.push({ id: c.id, name: c.name, tasks: tasksByColumn.get(c.id) ?? [] });
    columnsByBoard.set(c.board_id, arr);
  }

  const boards: ProjectSnapshotBoard[] = boardRows.results.map((b) => ({
    id: b.id,
    name: b.name,
    columns: columnsByBoard.get(b.id) ?? [],
  }));

  return { boards, links: linkRows.results };
}

/** This task's relations to other tasks, from its own point of view. */
async function loadTaskLinks(env: Env, taskId: string): Promise<TaskLinkView[]> {
  const { results } = await env.DB.prepare(
    `SELECT tl.relation_type,
            CASE WHEN tl.from_task_id = ? THEN 'outgoing' ELSE 'incoming' END AS direction,
            CASE WHEN tl.from_task_id = ? THEN tl.to_task_id ELSE tl.from_task_id END AS task_id,
            CASE WHEN tl.from_task_id = ? THEN tt.title ELSE tf.title END AS title
       FROM task_links tl
       JOIN tasks tf ON tf.id = tl.from_task_id
       JOIN tasks tt ON tt.id = tl.to_task_id
      WHERE tl.from_task_id = ? OR tl.to_task_id = ?`,
  )
    .bind(taskId, taskId, taskId, taskId, taskId)
    .all<TaskLinkView>();
  return results;
}

/** Load a single task with its completed-time total, running entry, and links. */
export async function loadTask(env: Env, taskId: string): Promise<Task> {
  const row = await env.DB.prepare(
    `SELECT t.id, t.column_id, t.title, t.description, t.position,
            t.created_at, t.updated_at, t.source, t.origin_voice_note_id,
            COALESCE(SUM(te.duration_seconds), 0) AS total_seconds
       FROM tasks t
       LEFT JOIN time_entries te
              ON te.task_id = t.id AND te.ended_at IS NOT NULL
      WHERE t.id = ?
      GROUP BY t.id`,
  )
    .bind(taskId)
    .first<Omit<Task, "running_entry" | "links">>();
  if (!row) throw new HttpError(404, "Task not found");

  const running = await env.DB.prepare(
    `SELECT id, task_id, user_id, started_at, ended_at, duration_seconds
       FROM time_entries WHERE task_id = ? AND ended_at IS NULL LIMIT 1`,
  )
    .bind(taskId)
    .first<Task["running_entry"]>();

  const links = await loadTaskLinks(env, taskId);

  return { ...row, running_entry: running ?? null, links };
}
