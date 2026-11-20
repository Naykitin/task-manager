import type { Env } from "../env.ts";
import { buildInsertTaskStmt } from "./tasks.ts";
import { HttpError, json, newId, readJson } from "../util.ts";

// ---------------------------------------------------------------------------
// Time-entry backup: full CSV export and a safe, idempotent CSV import.
//
// Two formats are understood on import (detected from the header row):
//   full      entry_id,board,column,task,started_at,ended_at,duration_seconds
//             (written by GET /api/time-entries/export; restores exactly)
//   timesheet date,board,task,duration_hms,duration_hours,duration_seconds
//             (the per-day "Export CSV" of the Timesheet; one approximate
//              entry per row, placed at 09:00 local time of that day)
// Boards/tasks are matched by name (case-insensitive) and created if missing.
// Entries that already exist (same task + start + end) are skipped, so running
// the same import twice is harmless.
// ---------------------------------------------------------------------------

const MAX_CSV_BYTES = 2_000_000;
const MAX_ROWS = 20_000;
const CHUNK = 50;

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** GET /api/time-entries/export - every completed entry of the user. */
export async function exportTimeEntriesCsv(
  userId: string,
  env: Env,
): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT te.id, b.name AS board, c.name AS col, t.title AS task,
            te.started_at, te.ended_at, te.duration_seconds
       FROM time_entries te
       JOIN tasks t ON t.id = te.task_id
       JOIN columns c ON c.id = t.column_id
       JOIN boards b ON b.id = c.board_id
      WHERE te.user_id = ? AND te.ended_at IS NOT NULL
      ORDER BY te.started_at ASC`,
  )
    .bind(userId)
    .all<{
      id: string;
      board: string;
      col: string;
      task: string;
      started_at: string;
      ended_at: string;
      duration_seconds: number;
    }>();

  const lines = ["entry_id,board,column,task,started_at,ended_at,duration_seconds"];
  for (const r of results) {
    lines.push(
      [
        r.id,
        csvEscape(r.board),
        csvEscape(r.col),
        csvEscape(r.task),
        r.started_at,
        r.ended_at,
        String(r.duration_seconds ?? 0),
      ].join(","),
    );
  }
  const day = new Date().toISOString().slice(0, 10);
  return new Response(lines.join("\n") + "\n", {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="time-entries-backup_${day}.csv"`,
    },
  });
}

/** Minimal RFC 4180 parser: quotes, escaped quotes, CRLF/LF, embedded newlines. */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

interface ParsedEntry {
  line: number;
  board: string;
  column: string | null;
  task: string;
  startedAt: string;
  endedAt: string;
  entryId: string | null;
}

interface Problem {
  line: number;
  reason: string;
}

function iso(value: string | undefined): string | null {
  if (!value || !value.trim()) return null;
  const t = new Date(value.trim()).getTime();
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const key = (taskId: string, start: string, end: string) => `${taskId}|${start}|${end}`;

/**
 * POST /api/time-entries/import
 * Body: { csv: string, dry_run?: boolean, tz_offset_minutes?: number }
 */
export async function importTimeEntriesCsv(
  req: Request,
  userId: string,
  env: Env,
): Promise<Response> {
  const body = await readJson<{
    csv?: unknown;
    dry_run?: unknown;
    tz_offset_minutes?: unknown;
  }>(req);
  if (typeof body.csv !== "string" || !body.csv.trim()) {
    throw new HttpError(400, "csv is required");
  }
  if (body.csv.length > MAX_CSV_BYTES) throw new HttpError(413, "CSV is too large");
  const dryRun = body.dry_run === true;
  const tz =
    typeof body.tz_offset_minutes === "number" && Math.abs(body.tz_offset_minutes) <= 14 * 60
      ? Math.round(body.tz_offset_minutes)
      : 0;

  const table = parseCsv(body.csv);
  if (table.length < 2) throw new HttpError(400, "CSV has no data rows");
  if (table.length - 1 > MAX_ROWS) throw new HttpError(413, `Too many rows (max ${MAX_ROWS})`);

  const header = table[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const isFull = col("started_at") >= 0 && col("ended_at") >= 0 && col("task") >= 0;
  const isTimesheet = !isFull && col("date") >= 0 && col("task") >= 0 && col("duration_seconds") >= 0;
  if (!isFull && !isTimesheet || col("board") < 0) {
    throw new HttpError(
      400,
      "Unrecognized CSV. Expected the full backup (entry_id,board,column,task,started_at,ended_at,duration_seconds) or the timesheet export (date,board,task,...,duration_seconds).",
    );
  }

  // ---- parse rows ----
  const entries: ParsedEntry[] = [];
  const problems: Problem[] = [];
  for (let i = 1; i < table.length; i++) {
    const r = table[i];
    const line = i + 1;
    const get = (name: string) => (col(name) >= 0 ? (r[col(name)] ?? "").trim() : "");
    const board = get("board");
    const task = get("task");
    if (isTimesheet && /^total$/i.test(get("date"))) continue; // summary row
    if (!board || !task) {
      problems.push({ line, reason: "board and task are required" });
      continue;
    }
    if (board.length > 100 || task.length > 500) {
      problems.push({ line, reason: "board or task name too long" });
      continue;
    }
    let startedAt: string | null;
    let endedAt: string | null;
    if (isFull) {
      startedAt = iso(get("started_at"));
      endedAt = iso(get("ended_at"));
    } else {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(get("date"));
      const secs = Number(get("duration_seconds"));
      if (!m || !Number.isFinite(secs) || secs <= 0) {
        problems.push({ line, reason: "needs a YYYY-MM-DD date and positive duration_seconds" });
        continue;
      }
      // 09:00 on that day in the user's timezone, expressed in UTC.
      const startMs = Date.UTC(+m[1], +m[2] - 1, +m[3], 9, 0, 0) - tz * 60_000;
      startedAt = new Date(startMs).toISOString();
      endedAt = new Date(startMs + Math.round(secs) * 1000).toISOString();
    }
    if (!startedAt || !endedAt || new Date(endedAt) <= new Date(startedAt)) {
      problems.push({ line, reason: "invalid or non-increasing started_at/ended_at" });
      continue;
    }
    entries.push({
      line,
      board,
      column: isFull ? get("column") || null : null,
      task,
      startedAt,
      endedAt,
      entryId: isFull ? get("entry_id") || null : null,
    });
  }

  // ---- load current state (a handful of queries, independent of row count) ----
  const boardRows = await env.DB.prepare("SELECT id, name FROM boards WHERE user_id = ?")
    .bind(userId)
    .all<{ id: string; name: string }>();
  const colRows = await env.DB.prepare(
    `SELECT c.id, c.board_id, c.name FROM columns c JOIN boards b ON b.id = c.board_id
      WHERE b.user_id = ? ORDER BY c.position ASC`,
  )
    .bind(userId)
    .all<{ id: string; board_id: string; name: string }>();
  const taskRows = await env.DB.prepare(
    `SELECT t.id, t.title, t.column_id, c.board_id
       FROM tasks t JOIN columns c ON c.id = t.column_id JOIN boards b ON b.id = c.board_id
      WHERE b.user_id = ?`,
  )
    .bind(userId)
    .all<{ id: string; title: string; column_id: string; board_id: string }>();
  const entryRows = await env.DB.prepare(
    "SELECT id, task_id, started_at, ended_at FROM time_entries WHERE user_id = ?",
  )
    .bind(userId)
    .all<{ id: string; task_id: string; started_at: string; ended_at: string | null }>();

  const norm = (s: string) => s.trim().toLowerCase();
  const boardByName = new Map(boardRows.results.map((b) => [norm(b.name), b.id]));
  const columnsOfBoard = new Map<string, { id: string; name: string }[]>();
  for (const c of colRows.results) {
    const arr = columnsOfBoard.get(c.board_id) ?? [];
    arr.push({ id: c.id, name: c.name });
    columnsOfBoard.set(c.board_id, arr);
  }
  const taskByName = new Map<string, string>(); // `${boardId}|${title}` -> id
  const nextPos = new Map<string, number>(); // columnId -> next position
  for (const t of taskRows.results) {
    const k = `${t.board_id}|${norm(t.title)}`;
    if (!taskByName.has(k)) taskByName.set(k, t.id);
  }
  const taskCountByColumn = new Map<string, number>();
  for (const t of taskRows.results) {
    taskCountByColumn.set(t.column_id, (taskCountByColumn.get(t.column_id) ?? 0) + 1);
  }
  for (const [colId, n] of taskCountByColumn) nextPos.set(colId, n);

  const seen = new Set<string>();
  const seenIds = new Set(entryRows.results.map((e) => e.id));
  for (const e of entryRows.results) {
    if (e.ended_at) {
      seen.add(
        key(e.task_id, new Date(e.started_at).toISOString(), new Date(e.ended_at).toISOString()),
      );
    }
  }

  // ---- plan ----
  const stmts: D1PreparedStatement[] = [];
  let createdBoards = 0;
  let createdTasks = 0;
  let imported = 0;
  let duplicates = 0;

  for (const e of entries) {
    let boardId = boardByName.get(norm(e.board));
    if (!boardId) {
      boardId = newId();
      boardByName.set(norm(e.board), boardId);
      createdBoards++;
      stmts.push(
        env.DB.prepare("INSERT INTO boards (id, user_id, name) VALUES (?, ?, ?)").bind(
          boardId,
          userId,
          e.board,
        ),
      );
    }
    let cols = columnsOfBoard.get(boardId);
    if (!cols || cols.length === 0) {
      const created = ["To Do", "In Progress", "Done"].map((name) => ({ id: newId(), name }));
      created.forEach((c, i) =>
        stmts.push(
          env.DB.prepare(
            "INSERT INTO columns (id, board_id, name, position) VALUES (?, ?, ?, ?)",
          ).bind(c.id, boardId, c.name, i),
        ),
      );
      columnsOfBoard.set(boardId, created);
      cols = created;
    }

    const taskKey = `${boardId}|${norm(e.task)}`;
    let taskId = taskByName.get(taskKey);
    if (!taskId) {
      taskId = newId();
      taskByName.set(taskKey, taskId);
      createdTasks++;
      const target =
        (e.column && cols.find((c) => norm(c.name) === norm(e.column!))) || cols[0];
      const pos = nextPos.get(target.id) ?? 0;
      nextPos.set(target.id, pos + 1);
      stmts.push(
        buildInsertTaskStmt(env, {
          id: taskId,
          columnId: target.id,
          title: e.task,
          description: null,
          position: pos,
          source: "manual",
          originVoiceNoteId: null,
        }),
      );
    }

    const k = key(taskId, e.startedAt, e.endedAt);
    if (seen.has(k) || (e.entryId && seenIds.has(e.entryId))) {
      duplicates++;
      continue;
    }
    seen.add(k);
    // Keep the original id when it is free, so a restore round-trips exactly.
    const entryId = e.entryId && !seenIds.has(e.entryId) ? e.entryId : newId();
    seenIds.add(entryId);
    const duration = Math.max(
      0,
      Math.round((new Date(e.endedAt).getTime() - new Date(e.startedAt).getTime()) / 1000),
    );
    stmts.push(
      env.DB.prepare(
        "INSERT INTO time_entries (id, task_id, user_id, started_at, ended_at, duration_seconds) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(entryId, taskId, userId, e.startedAt, e.endedAt, duration),
    );
    imported++;
  }

  if (!dryRun) {
    // Statements are ordered parents-first (board, columns, task, entry), so
    // chunking is safe; a re-run after a failure skips what already landed.
    for (let i = 0; i < stmts.length; i += CHUNK) {
      await env.DB.batch(stmts.slice(i, i + CHUNK));
    }
  }

  return json({
    dry_run: dryRun,
    format: isFull ? "full" : "timesheet",
    rows: table.length - 1,
    imported,
    skipped_duplicates: duplicates,
    created_boards: createdBoards,
    created_tasks: createdTasks,
    invalid: problems.length,
    problems: problems.slice(0, 20),
  });
}
