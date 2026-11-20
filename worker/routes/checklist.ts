import type { Env } from "../env.ts";
import type { ChecklistItem } from "../../shared/types.ts";
import { assertChecklistItemOwner, assertTaskOwner } from "../db.ts";
import { HttpError, json, newId, readJson, requireString } from "../util.ts";

export const MAX_ITEMS_PER_TASK = 100;
const MAX_TEXT = 500;

const COLS = "id, task_id, text, done, position";

function toItem(r: Omit<ChecklistItem, "done"> & { done: number }): ChecklistItem {
  return { ...r, done: r.done === 1 };
}

export async function listItems(env: Env, taskId: string): Promise<ChecklistItem[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${COLS} FROM task_checklist_items WHERE task_id = ? ORDER BY position ASC, created_at ASC`,
  )
    .bind(taskId)
    .all<Omit<ChecklistItem, "done"> & { done: number }>();
  return results.map(toItem);
}

/** Adds items at the end of a task's checklist (also used by the MCP tools). */
export async function addItems(
  env: Env,
  userId: string,
  taskId: string,
  texts: unknown[],
): Promise<ChecklistItem[]> {
  await assertTaskOwner(env, userId, taskId);
  if (texts.length === 0) throw new HttpError(400, "Provide at least one item");
  const clean = texts.map((t) => requireString(t, "text", { max: MAX_TEXT }));

  const cur = await env.DB.prepare(
    "SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) AS maxpos FROM task_checklist_items WHERE task_id = ?",
  )
    .bind(taskId)
    .first<{ n: number; maxpos: number }>();
  if ((cur?.n ?? 0) + clean.length > MAX_ITEMS_PER_TASK) {
    throw new HttpError(400, `A task can have at most ${MAX_ITEMS_PER_TASK} steps`);
  }

  let pos = (cur?.maxpos ?? -1) + 1;
  const created: ChecklistItem[] = [];
  const stmts = clean.map((text) => {
    const item: ChecklistItem = { id: newId(), task_id: taskId, text, done: false, position: pos++ };
    created.push(item);
    return env.DB.prepare(
      "INSERT INTO task_checklist_items (id, task_id, text, done, position) VALUES (?, ?, ?, 0, ?)",
    ).bind(item.id, taskId, text, item.position);
  });
  await env.DB.batch(stmts);
  return created;
}

/** POST /api/tasks/:id/checklist - { text } or { items: string[] }. */
export async function createItems(
  req: Request,
  taskId: string,
  userId: string,
  env: Env,
): Promise<Response> {
  const body = await readJson<{ text?: unknown; items?: unknown }>(req);
  const texts = Array.isArray(body.items) ? body.items : [body.text];
  const items = await addItems(env, userId, taskId, texts);
  return json({ items }, { status: 201 });
}

/** PATCH /api/checklist/:id - { text?, done? }. */
export async function updateItem(
  req: Request,
  itemId: string,
  userId: string,
  env: Env,
): Promise<Response> {
  await assertChecklistItemOwner(env, userId, itemId);
  const body = await readJson<{ text?: unknown; done?: unknown }>(req);
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.text !== undefined) {
    sets.push("text = ?");
    binds.push(requireString(body.text, "text", { max: MAX_TEXT }));
  }
  if (body.done !== undefined) {
    if (typeof body.done !== "boolean") throw new HttpError(400, "done must be true or false");
    sets.push("done = ?");
    binds.push(body.done ? 1 : 0);
  }
  if (sets.length === 0) throw new HttpError(400, "Nothing to update");
  binds.push(itemId);
  await env.DB.prepare(`UPDATE task_checklist_items SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  const row = await env.DB.prepare(`SELECT ${COLS} FROM task_checklist_items WHERE id = ?`)
    .bind(itemId)
    .first<Omit<ChecklistItem, "done"> & { done: number }>();
  return json({ item: toItem(row!) });
}

/** DELETE /api/checklist/:id */
export async function deleteItem(
  itemId: string,
  userId: string,
  env: Env,
): Promise<Response> {
  await assertChecklistItemOwner(env, userId, itemId);
  await env.DB.prepare("DELETE FROM task_checklist_items WHERE id = ?").bind(itemId).run();
  return json({ ok: true });
}

/**
 * PUT /api/tasks/:id/checklist/order - { item_ids } in the desired order.
 * Unlisted items keep their relative order after the listed ones.
 */
export async function reorderItems(
  req: Request,
  taskId: string,
  userId: string,
  env: Env,
): Promise<Response> {
  await assertTaskOwner(env, userId, taskId);
  const body = await readJson<{ item_ids?: unknown }>(req);
  if (
    !Array.isArray(body.item_ids) ||
    body.item_ids.length === 0 ||
    body.item_ids.some((x) => typeof x !== "string")
  ) {
    throw new HttpError(400, "item_ids must be a non-empty array of ids");
  }
  const existing = await listItems(env, taskId);
  const known = new Set(existing.map((i) => i.id));
  const requested = [...new Set(body.item_ids as string[])];
  if (requested.some((id) => !known.has(id))) {
    throw new HttpError(400, "item_ids contains an item that is not on this task");
  }
  const listed = new Set(requested);
  const order = [...requested, ...existing.map((i) => i.id).filter((id) => !listed.has(id))];
  await env.DB.batch(
    order.map((id, i) =>
      env.DB.prepare(
        "UPDATE task_checklist_items SET position = ? WHERE id = ? AND task_id = ?",
      ).bind(i, id, taskId),
    ),
  );
  return json({ items: await listItems(env, taskId) });
}
