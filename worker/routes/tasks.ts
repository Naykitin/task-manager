import type { Env } from "../env.ts";
import type { Task } from "../../shared/types.ts";
import { assertColumnOwner, assertTaskOwner } from "../db.ts";
import {
  HttpError,
  json,
  newId,
  nowIso,
  readJson,
  requireString,
} from "../util.ts";

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
  await env.DB.prepare(
    "INSERT INTO tasks (id, column_id, title, description, position) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, columnId, title, description || null, posRow?.pos ?? 0)
    .run();

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

/** Load a single task with its completed-time total and running entry. */
async function loadTask(env: Env, taskId: string): Promise<Task> {
  const row = await env.DB.prepare(
    `SELECT t.id, t.column_id, t.title, t.description, t.position,
            t.created_at, t.updated_at,
            COALESCE(SUM(te.duration_seconds), 0) AS total_seconds
       FROM tasks t
       LEFT JOIN time_entries te
              ON te.task_id = t.id AND te.ended_at IS NOT NULL
      WHERE t.id = ?
      GROUP BY t.id`,
  )
    .bind(taskId)
    .first<Omit<Task, "running_entry">>();
  if (!row) throw new HttpError(404, "Task not found");

  const running = await env.DB.prepare(
    `SELECT id, task_id, user_id, started_at, ended_at, duration_seconds
       FROM time_entries WHERE task_id = ? AND ended_at IS NULL LIMIT 1`,
  )
    .bind(taskId)
    .first<Task["running_entry"]>();

  return { ...row, running_entry: running ?? null };
}
