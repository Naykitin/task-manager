import type { Env } from "../env.ts";
import type { Scope } from "../apikeys.ts";
import { assertColumnOwner, assertTaskOwner } from "../db.ts";
import { HttpError, newId, requireString } from "../util.ts";
import * as boards from "../routes/boards.ts";
import * as tasks from "../routes/tasks.ts";
import * as timer from "../routes/timer.ts";
import * as timesheet from "../routes/timesheet.ts";

// ---------------------------------------------------------------------------
// MCP tools. Each tool declares the scope it needs; tools the caller's key
// does not cover are neither listed nor callable. Handlers reuse the existing
// REST route functions (and therefore their ownership checks + validation) by
// invoking them with synthetic Requests and unwrapping the JSON response.
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;

export interface ToolContext {
  env: Env;
  userId: string;
}

export interface Tool {
  name: string;
  description: string;
  scope: Scope;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  handler: (args: Args, ctx: ToolContext) => Promise<unknown>;
}

/** Runs a route handler and returns its parsed JSON body. */
async function unwrap(res: Response): Promise<any> {
  const data = (await res.json()) as any;
  if (!res.ok) throw new HttpError(res.status, data?.error ?? "Request failed");
  return data;
}

function syntheticReq(method: string, body?: unknown): Request {
  return new Request("https://internal.invalid/", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function optString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Resolves a column by id, or by case-insensitive name within `boardId`.
 * With no `ref`, falls back to the board's first column.
 */
async function resolveColumn(
  ctx: ToolContext,
  ref: string | undefined,
  boardId: string | undefined,
): Promise<string> {
  const { env, userId } = ctx;
  if (ref) {
    const byId = await env.DB.prepare(
      `SELECT c.id FROM columns c JOIN boards b ON b.id = c.board_id
        WHERE c.id = ? AND b.user_id = ?`,
    )
      .bind(ref, userId)
      .first<{ id: string }>();
    if (byId) return byId.id;
    if (boardId) {
      const byName = await env.DB.prepare(
        `SELECT c.id FROM columns c JOIN boards b ON b.id = c.board_id
          WHERE c.board_id = ? AND b.user_id = ? AND lower(c.name) = lower(?)
          LIMIT 1`,
      )
        .bind(boardId, userId, ref)
        .first<{ id: string }>();
      if (byName) return byName.id;
    }
    throw new HttpError(
      404,
      boardId
        ? `Column "${ref}" not found on that board (use get_board to see columns)`
        : `Column "${ref}" not found (pass board_id to resolve by name)`,
    );
  }
  if (!boardId) throw new HttpError(400, "Provide column or board_id");
  const first = await env.DB.prepare(
    `SELECT c.id FROM columns c JOIN boards b ON b.id = c.board_id
      WHERE c.board_id = ? AND b.user_id = ?
      ORDER BY c.position ASC LIMIT 1`,
  )
    .bind(boardId, userId)
    .first<{ id: string }>();
  if (!first) throw new HttpError(404, "Board not found or has no columns");
  return first.id;
}

const str = (description: string) => ({ type: "string", description });

export const TOOLS: Tool[] = [
  // ------------------------------- read --------------------------------
  {
    name: "list_boards",
    description:
      "List all boards (desks) with their id, name and task counts. Start here to discover board ids.",
    scope: "read",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
    async handler(_a, { env, userId }) {
      const { results } = await env.DB.prepare(
        `SELECT b.id, b.name, b.created_at,
                (SELECT COUNT(*) FROM tasks t JOIN columns c ON c.id = t.column_id
                  WHERE c.board_id = b.id) AS task_count
           FROM boards b WHERE b.user_id = ? ORDER BY b.created_at ASC`,
      )
        .bind(userId)
        .all();
      return { boards: results };
    },
  },
  {
    name: "get_board",
    description:
      "Get one board with its columns and every task (title, description, time spent, links, running timer).",
    scope: "read",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: { board_id: str("Board id from list_boards") },
      required: ["board_id"],
    },
    async handler(a, { env, userId }) {
      return unwrap(
        await boards.getBoard(requireString(a.board_id, "board_id"), userId, env),
      );
    },
  },
  {
    name: "search_tasks",
    description:
      "Search tasks by text in title or description across all boards (or one board). Returns board/column context for each match.",
    scope: "read",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: str("Text to look for"),
        board_id: str("Optional: restrict to one board"),
        limit: { type: "integer", description: "Max results (default 25, max 100)" },
      },
      required: ["query"],
    },
    async handler(a, { env, userId }) {
      const url = new URL("https://internal.invalid/api/tasks/search");
      url.searchParams.set("q", requireString(a.query, "query"));
      const board = optString(a.board_id);
      if (board) url.searchParams.set("board_id", board);
      if (typeof a.limit === "number") url.searchParams.set("limit", String(a.limit));
      return unwrap(await tasks.searchTasks(url, userId, env));
    },
  },
  {
    name: "get_task",
    description:
      "Get full details of a task: description, board/column, time spent, links to other tasks, and time entries.",
    scope: "read",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: { task_id: str("Task id") },
      required: ["task_id"],
    },
    async handler(a, { env, userId }) {
      const id = requireString(a.task_id, "task_id");
      await assertTaskOwner(env, userId, id);
      const task = await tasks.loadTask(env, id);
      const where = await env.DB.prepare(
        `SELECT c.name AS column_name, b.id AS board_id, b.name AS board_name
           FROM tasks t JOIN columns c ON c.id = t.column_id
           JOIN boards b ON b.id = c.board_id WHERE t.id = ?`,
      )
        .bind(id)
        .first();
      const entries = await unwrap(await timer.listTimeEntries(id, userId, env));
      return { task, ...where, time_entries: entries.entries };
    },
  },
  {
    name: "get_active_timer",
    description: "Return the currently running timer (and its task), or null if nothing is being tracked.",
    scope: "read",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
    async handler(_a, { env, userId }) {
      const row = await env.DB.prepare(
        `SELECT te.id AS entry_id, te.started_at, t.id AS task_id, t.title AS task_title,
                b.id AS board_id, b.name AS board_name
           FROM time_entries te JOIN tasks t ON t.id = te.task_id
           JOIN columns c ON c.id = t.column_id JOIN boards b ON b.id = c.board_id
          WHERE te.user_id = ? AND te.ended_at IS NULL
          ORDER BY te.started_at DESC LIMIT 1`,
      )
        .bind(userId)
        .first<{ started_at: string }>();
      if (!row) return { active: null };
      const elapsed = Math.round((Date.now() - new Date(row.started_at).getTime()) / 1000);
      return { active: { ...row, elapsed_seconds: elapsed } };
    },
  },
  {
    name: "get_timesheet",
    description:
      "Time tracked per day, task and board over a date range. Defaults to today (UTC unless tz_offset_minutes given).",
    scope: "read",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        start: str("YYYY-MM-DD, inclusive (default today)"),
        end: str("YYYY-MM-DD, inclusive (default = start or today)"),
        tz_offset_minutes: {
          type: "integer",
          description: "Minutes east of UTC for day boundaries, e.g. 60 for CET",
        },
      },
    },
    async handler(a, { env, userId }) {
      const tz = typeof a.tz_offset_minutes === "number" ? a.tz_offset_minutes : 0;
      const today = new Date(Date.now() + tz * 60_000).toISOString().slice(0, 10);
      const start = optString(a.start) ?? today;
      const end = optString(a.end) ?? (optString(a.start) ? start : today);
      const url = new URL("https://internal.invalid/api/timesheet");
      url.searchParams.set("start", start);
      url.searchParams.set("end", end);
      url.searchParams.set("tzOffset", String(tz));
      return unwrap(await timesheet.getTimesheet(url, userId, env));
    },
  },

  // ------------------------------- write -------------------------------
  {
    name: "create_board",
    description: "Create a new board (desk) with default columns To Do / In Progress / Done.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: { name: str("Board name") },
      required: ["name"],
    },
    async handler(a, { env, userId }) {
      const created = await unwrap(
        await boards.createBoard(syntheticReq("POST", { name: a.name }), userId, env),
      );
      return unwrap(await boards.getBoard(created.board.id, userId, env));
    },
  },
  {
    name: "create_column",
    description: "Add a column to a board (appended at the end).",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: { board_id: str("Board id"), name: str("Column name") },
      required: ["board_id", "name"],
    },
    async handler(a, { env, userId }) {
      return unwrap(
        await boards.createColumn(
          syntheticReq("POST", { board_id: a.board_id, name: a.name }),
          userId,
          env,
        ),
      );
    },
  },
  {
    name: "create_task",
    description:
      "Create a task. Give board_id (and optionally a column name, default first column), or give column as a column id.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        title: str("Task title"),
        description: str("Optional details"),
        board_id: str("Board id; needed when column is a name or omitted"),
        column: str("Column name (e.g. 'To Do') or column id"),
      },
      required: ["title"],
    },
    async handler(a, ctx) {
      const columnId = await resolveColumn(ctx, optString(a.column), optString(a.board_id));
      return unwrap(
        await tasks.createTask(
          syntheticReq("POST", {
            column_id: columnId,
            title: a.title,
            description: a.description,
          }),
          ctx.userId,
          ctx.env,
        ),
      );
    },
  },
  {
    name: "bulk_create_tasks",
    description:
      "Create several tasks at once in one column (max 50). Ideal for breaking a goal into steps.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        board_id: str("Board id"),
        column: str("Column name or id (default: first column)"),
        tasks: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            properties: { title: str("Task title"), description: str("Optional details") },
            required: ["title"],
          },
        },
      },
      required: ["board_id", "tasks"],
    },
    async handler(a, ctx) {
      if (!Array.isArray(a.tasks) || a.tasks.length === 0) {
        throw new HttpError(400, "tasks must be a non-empty array");
      }
      if (a.tasks.length > 50) throw new HttpError(400, "Too many tasks (max 50)");
      const columnId = await resolveColumn(ctx, optString(a.column), optString(a.board_id));
      await assertColumnOwner(ctx.env, ctx.userId, columnId);

      const posRow = await ctx.env.DB.prepare(
        "SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM tasks WHERE column_id = ?",
      )
        .bind(columnId)
        .first<{ pos: number }>();

      let basePos = posRow?.pos ?? 0;
      const now = new Date().toISOString();
      const stmts: D1PreparedStatement[] = [];
      const created: any[] = [];

      for (const t of a.tasks as Args[]) {
        const title = requireString(t.title, "title", { max: 500 });
        const description =
          typeof t.description === "string" && t.description.trim()
            ? t.description.trim()
            : null;
        const id = newId();
        const pos = basePos++;

        stmts.push(
          tasks.buildInsertTaskStmt(ctx.env, {
            id,
            columnId,
            title,
            description,
            position: pos,
            source: "manual",
            originVoiceNoteId: null,
          }),
        );

        created.push({
          id,
          column_id: columnId,
          title,
          description,
          position: pos,
          source: "manual",
          origin_voice_note_id: null,
          created_at: now,
          updated_at: now,
          total_seconds: 0,
          running_entry: null,
          links: [],
        });
      }

      await ctx.env.DB.batch(stmts);
      return { created: created.length, tasks: created };
    },
  },
  {
    name: "update_task",
    description: "Change a task's title and/or description. Pass an empty description to clear it.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        task_id: str("Task id"),
        title: str("New title"),
        description: str("New description"),
      },
      required: ["task_id"],
    },
    async handler(a, { env, userId }) {
      const body: Args = {};
      if (a.title !== undefined) body.title = a.title;
      if (a.description !== undefined) body.description = a.description;
      return unwrap(
        await tasks.updateTask(
          syntheticReq("PATCH", body),
          requireString(a.task_id, "task_id"),
          userId,
          env,
        ),
      );
    },
  },
  {
    name: "move_task",
    description:
      "Move a task to another column of its board, by column name (e.g. 'Done') or id. Optional 0-based position (default: top).",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        task_id: str("Task id"),
        column: str("Target column name or id"),
        position: { type: "integer", description: "0-based index in the column" },
      },
      required: ["task_id", "column"],
    },
    async handler(a, ctx) {
      const taskId = requireString(a.task_id, "task_id");
      await assertTaskOwner(ctx.env, ctx.userId, taskId);
      const board = await ctx.env.DB.prepare(
        `SELECT c.board_id FROM tasks t JOIN columns c ON c.id = t.column_id WHERE t.id = ?`,
      )
        .bind(taskId)
        .first<{ board_id: string }>();
      const columnId = await resolveColumn(
        ctx,
        requireString(a.column, "column"),
        board?.board_id,
      );
      return unwrap(
        await tasks.moveTask(
          syntheticReq("PATCH", { column_id: columnId, position: a.position }),
          taskId,
          ctx.userId,
          ctx.env,
        ),
      );
    },
  },
  {
    name: "link_tasks",
    description:
      "Create a relation between two tasks: 'blocks' (from blocks to), 'related', or 'duplicate'.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        from_task_id: str("Source task id"),
        to_task_id: str("Target task id"),
        relation_type: { type: "string", enum: ["blocks", "related", "duplicate"] },
      },
      required: ["from_task_id", "to_task_id", "relation_type"],
    },
    async handler(a, { env, userId }) {
      const from = requireString(a.from_task_id, "from_task_id");
      const to = requireString(a.to_task_id, "to_task_id");
      const rel = a.relation_type;
      if (rel !== "blocks" && rel !== "related" && rel !== "duplicate") {
        throw new HttpError(400, "relation_type must be blocks, related or duplicate");
      }
      if (from === to) throw new HttpError(400, "A task cannot link to itself");
      await assertTaskOwner(env, userId, from);
      await assertTaskOwner(env, userId, to);
      await env.DB.prepare(
        "INSERT OR IGNORE INTO task_links (id, from_task_id, to_task_id, relation_type) VALUES (?, ?, ?, ?)",
      )
        .bind(newId(), from, to, rel)
        .run();
      return { ok: true, from_task_id: from, to_task_id: to, relation_type: rel };
    },
  },
  {
    name: "start_timer",
    description: "Start time tracking on a task. Any other running timer is stopped automatically.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: { task_id: str("Task id") },
      required: ["task_id"],
    },
    async handler(a, { env, userId }) {
      return unwrap(await timer.startTimer(requireString(a.task_id, "task_id"), userId, env));
    },
  },
  {
    name: "stop_timer",
    description: "Stop the running timer on a task and record its duration.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: { task_id: str("Task id of the running timer") },
      required: ["task_id"],
    },
    async handler(a, { env, userId }) {
      return unwrap(await timer.stopTimer(requireString(a.task_id, "task_id"), userId, env));
    },
  },

  // ------------------------------- delete ------------------------------
  {
    name: "delete_task",
    description: "Permanently delete a task and its time entries. Irreversible.",
    scope: "delete",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: { task_id: str("Task id") },
      required: ["task_id"],
    },
    async handler(a, { env, userId }) {
      return unwrap(await tasks.deleteTask(requireString(a.task_id, "task_id"), userId, env));
    },
  },
  {
    name: "delete_column",
    description: "Permanently delete a column with all its tasks. Irreversible.",
    scope: "delete",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: { column_id: str("Column id") },
      required: ["column_id"],
    },
    async handler(a, { env, userId }) {
      return unwrap(
        await boards.deleteColumn(requireString(a.column_id, "column_id"), userId, env),
      );
    },
  },
  {
    name: "delete_board",
    description: "Permanently delete a board with all columns, tasks and time entries. Irreversible.",
    scope: "delete",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: { board_id: str("Board id") },
      required: ["board_id"],
    },
    async handler(a, { env, userId }) {
      return unwrap(await boards.deleteBoard(requireString(a.board_id, "board_id"), userId, env));
    },
  },
];
