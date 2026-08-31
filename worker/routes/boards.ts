import type { Env } from "../env.ts";
import type {
  Board,
  BoardDetail,
  Column,
  ColumnWithTasks,
  RelationType,
  Task,
  TaskLinkView,
  TimeEntry,
} from "../../shared/types.ts";
import { assertBoardOwner, assertColumnOwner } from "../db.ts";
import { HttpError, json, newId, readJson, requireString } from "../util.ts";

export async function listBoards(userId: string, env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT id, user_id, name, created_at FROM boards WHERE user_id = ? ORDER BY created_at ASC",
  )
    .bind(userId)
    .all<Board>();
  return json({ boards: results });
}

export async function createBoard(
  req: Request,
  userId: string,
  env: Env,
): Promise<Response> {
  const body = await readJson<{ name?: string }>(req);
  const name = requireString(body.name, "name", { max: 100 });
  const id = newId();
  await env.DB.prepare("INSERT INTO boards (id, user_id, name) VALUES (?, ?, ?)")
    .bind(id, userId, name)
    .run();
  // Seed the usual three columns.
  const stmts = ["To Do", "In Progress", "Done"].map((n, i) =>
    env.DB.prepare(
      "INSERT INTO columns (id, board_id, name, position) VALUES (?, ?, ?, ?)",
    ).bind(newId(), id, n, i),
  );
  await env.DB.batch(stmts);
  const board = await env.DB.prepare(
    "SELECT id, user_id, name, created_at FROM boards WHERE id = ?",
  )
    .bind(id)
    .first<Board>();
  return json({ board }, { status: 201 });
}

/** DELETE /api/boards/:id — removes the board and everything under it. */
export async function deleteBoard(
  boardId: string,
  userId: string,
  env: Env,
): Promise<Response> {
  await assertBoardOwner(env, userId, boardId);
  // Explicit cascade: D1 does not reliably enforce ON DELETE CASCADE, so we
  // remove time entries, tasks, and columns for this board ourselves.
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM time_entries WHERE task_id IN (
         SELECT t.id FROM tasks t
           JOIN columns c ON c.id = t.column_id
          WHERE c.board_id = ?)`,
    ).bind(boardId),
    env.DB.prepare(
      "DELETE FROM tasks WHERE column_id IN (SELECT id FROM columns WHERE board_id = ?)",
    ).bind(boardId),
    env.DB.prepare("DELETE FROM columns WHERE board_id = ?").bind(boardId),
    env.DB.prepare("DELETE FROM boards WHERE id = ? AND user_id = ?").bind(
      boardId,
      userId,
    ),
  ]);
  return json({ ok: true });
}

/** GET /api/boards/:id — board with columns and nested tasks + time totals. */
export async function getBoard(
  boardId: string,
  userId: string,
  env: Env,
): Promise<Response> {
  const board = await env.DB.prepare(
    "SELECT id, user_id, name, created_at FROM boards WHERE id = ? AND user_id = ?",
  )
    .bind(boardId, userId)
    .first<Board>();
  if (!board) throw new HttpError(404, "Board not found");

  const columns = await env.DB.prepare(
    "SELECT id, board_id, name, position FROM columns WHERE board_id = ? ORDER BY position ASC, name ASC",
  )
    .bind(boardId)
    .all<Column>();

  // Tasks for the whole board, each with summed completed time.
  const tasks = await env.DB.prepare(
    `SELECT t.id, t.column_id, t.title, t.description, t.position,
            t.created_at, t.updated_at, t.source, t.origin_voice_note_id,
            COALESCE(SUM(te.duration_seconds), 0) AS total_seconds
       FROM tasks t
       JOIN columns c ON c.id = t.column_id
       LEFT JOIN time_entries te
              ON te.task_id = t.id AND te.ended_at IS NOT NULL
      WHERE c.board_id = ?
      GROUP BY t.id
      ORDER BY t.position ASC, t.created_at ASC`,
  )
    .bind(boardId)
    .all<Omit<Task, "running_entry">>();

  // The user's single running timer (if any) — attached to its task.
  const running = await env.DB.prepare(
    `SELECT id, task_id, user_id, started_at, ended_at, duration_seconds
       FROM time_entries
      WHERE user_id = ? AND ended_at IS NULL
      ORDER BY started_at DESC
      LIMIT 1`,
  )
    .bind(userId)
    .first<TimeEntry>();

  // Every link between two tasks on this board, one row per link — expanded
  // into two per-task view entries (one for each side) below.
  const linkRows = await env.DB.prepare(
    `SELECT tl.from_task_id, tl.to_task_id, tl.relation_type,
            tf.title AS from_title, tt.title AS to_title
       FROM task_links tl
       JOIN tasks tf ON tf.id = tl.from_task_id
       JOIN columns cf ON cf.id = tf.column_id
       JOIN tasks tt ON tt.id = tl.to_task_id
       JOIN columns ct ON ct.id = tt.column_id
      WHERE cf.board_id = ? AND ct.board_id = ?`,
  )
    .bind(boardId, boardId)
    .all<{
      from_task_id: string;
      to_task_id: string;
      relation_type: RelationType;
      from_title: string;
      to_title: string;
    }>();

  const linksByTask = new Map<string, TaskLinkView[]>();
  for (const l of linkRows.results) {
    const outgoing = linksByTask.get(l.from_task_id) ?? [];
    outgoing.push({
      task_id: l.to_task_id,
      title: l.to_title,
      relation_type: l.relation_type,
      direction: "outgoing",
    });
    linksByTask.set(l.from_task_id, outgoing);

    const incoming = linksByTask.get(l.to_task_id) ?? [];
    incoming.push({
      task_id: l.from_task_id,
      title: l.from_title,
      relation_type: l.relation_type,
      direction: "incoming",
    });
    linksByTask.set(l.to_task_id, incoming);
  }

  const byColumn = new Map<string, Task[]>();
  for (const t of tasks.results) {
    const task: Task = {
      ...t,
      running_entry: running && running.task_id === t.id ? running : null,
      links: linksByTask.get(t.id) ?? [],
    };
    const arr = byColumn.get(t.column_id) ?? [];
    arr.push(task);
    byColumn.set(t.column_id, arr);
  }

  const columnsWithTasks: ColumnWithTasks[] = columns.results.map((c) => ({
    ...c,
    tasks: byColumn.get(c.id) ?? [],
  }));

  const detail: BoardDetail = { ...board, columns: columnsWithTasks };
  return json({ board: detail });
}

export async function createColumn(
  req: Request,
  userId: string,
  env: Env,
): Promise<Response> {
  const body = await readJson<{ board_id?: string; name?: string }>(req);
  const boardId = requireString(body.board_id, "board_id");
  const name = requireString(body.name, "name", { max: 100 });
  await assertBoardOwner(env, userId, boardId);

  const posRow = await env.DB.prepare(
    "SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM columns WHERE board_id = ?",
  )
    .bind(boardId)
    .first<{ pos: number }>();

  const id = newId();
  await env.DB.prepare(
    "INSERT INTO columns (id, board_id, name, position) VALUES (?, ?, ?, ?)",
  )
    .bind(id, boardId, name, posRow?.pos ?? 0)
    .run();
  const column = await env.DB.prepare(
    "SELECT id, board_id, name, position FROM columns WHERE id = ?",
  )
    .bind(id)
    .first<Column>();
  return json({ column }, { status: 201 });
}

export async function updateColumn(
  req: Request,
  columnId: string,
  userId: string,
  env: Env,
): Promise<Response> {
  await assertColumnOwner(env, userId, columnId);
  const body = await readJson<{ name?: string; position?: number }>(req);

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.name !== undefined) {
    sets.push("name = ?");
    binds.push(requireString(body.name, "name", { max: 100 }));
  }
  if (body.position !== undefined) {
    if (typeof body.position !== "number") {
      throw new HttpError(400, "position must be a number");
    }
    sets.push("position = ?");
    binds.push(body.position);
  }
  if (sets.length === 0) throw new HttpError(400, "Nothing to update");

  binds.push(columnId);
  await env.DB.prepare(`UPDATE columns SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  const column = await env.DB.prepare(
    "SELECT id, board_id, name, position FROM columns WHERE id = ?",
  )
    .bind(columnId)
    .first<Column>();
  return json({ column });
}

export async function deleteColumn(
  columnId: string,
  userId: string,
  env: Env,
): Promise<Response> {
  await assertColumnOwner(env, userId, columnId);
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM time_entries WHERE task_id IN (SELECT id FROM tasks WHERE column_id = ?)",
    ).bind(columnId),
    env.DB.prepare("DELETE FROM tasks WHERE column_id = ?").bind(columnId),
    env.DB.prepare("DELETE FROM columns WHERE id = ?").bind(columnId),
  ]);
  return json({ ok: true });
}
