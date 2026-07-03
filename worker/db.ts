import type { Env } from "./env.ts";
import { HttpError } from "./util.ts";

// Ownership guards. Every mutation resolves the owning user_id through the
// board relationship and rejects anything the session user does not own.

export async function assertBoardOwner(
  env: Env,
  userId: string,
  boardId: string,
): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT 1 FROM boards WHERE id = ? AND user_id = ?",
  )
    .bind(boardId, userId)
    .first();
  if (!row) throw new HttpError(404, "Board not found");
}

export async function assertColumnOwner(
  env: Env,
  userId: string,
  columnId: string,
): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM columns c
       JOIN boards b ON b.id = c.board_id
      WHERE c.id = ? AND b.user_id = ?`,
  )
    .bind(columnId, userId)
    .first();
  if (!row) throw new HttpError(404, "Column not found");
}

export async function assertTaskOwner(
  env: Env,
  userId: string,
  taskId: string,
): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM tasks t
       JOIN columns c ON c.id = t.column_id
       JOIN boards b ON b.id = c.board_id
      WHERE t.id = ? AND b.user_id = ?`,
  )
    .bind(taskId, userId)
    .first();
  if (!row) throw new HttpError(404, "Task not found");
}
