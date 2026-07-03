import type { Env } from "../env.ts";
import type {
  TimesheetDay,
  TimesheetResponse,
  TimesheetTaskRow,
} from "../../shared/types.ts";
import { HttpError, json } from "../util.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface CompletedRow {
  started_at: string;
  duration_seconds: number;
  task_id: string;
  task_title: string;
  board_id: string;
  board_name: string;
}

/** Local YYYY-MM-DD for an ISO timestamp, shifted by tzOffset minutes. */
function localDate(iso: string, tzOffsetMin: number): string {
  const shifted = new Date(new Date(iso).getTime() + tzOffsetMin * 60_000);
  return shifted.toISOString().slice(0, 10);
}

async function computeTimesheet(
  url: URL,
  userId: string,
  env: Env,
): Promise<TimesheetResponse> {
  const start = url.searchParams.get("start") ?? "";
  const end = url.searchParams.get("end") ?? "";
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    throw new HttpError(400, "start and end must be YYYY-MM-DD");
  }
  if (start > end) throw new HttpError(400, "start must be on or before end");

  // Timezone: minutes to add to UTC to reach the user's local time.
  // Client sends -new Date().getTimezoneOffset(); default UTC.
  const tzOffsetMin = Number(url.searchParams.get("tzOffset") ?? "0") || 0;

  // Convert the inclusive local date range into a [start, end) UTC window.
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  const startBoundary = new Date(
    Date.UTC(sy, sm - 1, sd) - tzOffsetMin * 60_000,
  ).toISOString();
  const endBoundary = new Date(
    Date.UTC(ey, em - 1, ed) + 24 * 3600_000 - tzOffsetMin * 60_000,
  ).toISOString();

  const { results } = await env.DB.prepare(
    `SELECT te.started_at        AS started_at,
            te.duration_seconds  AS duration_seconds,
            t.id                 AS task_id,
            t.title              AS task_title,
            b.id                 AS board_id,
            b.name               AS board_name
       FROM time_entries te
       JOIN tasks t   ON t.id = te.task_id
       JOIN columns c ON c.id = t.column_id
       JOIN boards b  ON b.id = c.board_id
      WHERE te.user_id = ?
        AND te.ended_at IS NOT NULL
        AND te.started_at >= ?
        AND te.started_at <  ?
      ORDER BY te.started_at ASC`,
  )
    .bind(userId, startBoundary, endBoundary)
    .all<CompletedRow>();

  // day -> task_id -> row
  const dayMap = new Map<string, Map<string, TimesheetTaskRow>>();
  const boardTotals = new Map<string, { name: string; secs: number }>();
  const taskTotals = new Map<
    string,
    { title: string; board_id: string; board_name: string; secs: number }
  >();
  let total = 0;

  for (const r of results) {
    const secs = r.duration_seconds ?? 0;
    total += secs;
    const day = localDate(r.started_at, tzOffsetMin);

    let tasks = dayMap.get(day);
    if (!tasks) {
      tasks = new Map();
      dayMap.set(day, tasks);
    }
    const existing = tasks.get(r.task_id);
    if (existing) {
      existing.duration_seconds += secs;
    } else {
      tasks.set(r.task_id, {
        task_id: r.task_id,
        task_title: r.task_title,
        board_id: r.board_id,
        board_name: r.board_name,
        duration_seconds: secs,
      });
    }

    const bt = boardTotals.get(r.board_id);
    if (bt) bt.secs += secs;
    else boardTotals.set(r.board_id, { name: r.board_name, secs });

    const tt = taskTotals.get(r.task_id);
    if (tt) tt.secs += secs;
    else
      taskTotals.set(r.task_id, {
        title: r.task_title,
        board_id: r.board_id,
        board_name: r.board_name,
        secs,
      });
  }

  const days: TimesheetDay[] = [...dayMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, tasks]) => {
      const taskRows = [...tasks.values()].sort(
        (a, b) => b.duration_seconds - a.duration_seconds,
      );
      return {
        date,
        total_seconds: taskRows.reduce((s, t) => s + t.duration_seconds, 0),
        tasks: taskRows,
      };
    });

  // Running timer (excluded from total, reported separately).
  const running = await env.DB.prepare(
    "SELECT started_at FROM time_entries WHERE user_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
  )
    .bind(userId)
    .first<{ started_at: string }>();
  const inProgress = running
    ? Math.max(
        0,
        Math.round((Date.now() - new Date(running.started_at).getTime()) / 1000),
      )
    : 0;

  return {
    start,
    end,
    total_seconds: total,
    in_progress_seconds: inProgress,
    days,
    by_board: [...boardTotals.entries()]
      .map(([board_id, v]) => ({
        board_id,
        board_name: v.name,
        duration_seconds: v.secs,
      }))
      .sort((a, b) => b.duration_seconds - a.duration_seconds),
    by_task: [...taskTotals.entries()]
      .map(([task_id, v]) => ({
        task_id,
        task_title: v.title,
        board_id: v.board_id,
        board_name: v.board_name,
        duration_seconds: v.secs,
      }))
      .sort((a, b) => b.duration_seconds - a.duration_seconds),
  };
}

export async function getTimesheet(
  url: URL,
  userId: string,
  env: Env,
): Promise<Response> {
  const data = await computeTimesheet(url, userId, env);
  return json(data);
}

function hms(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export async function exportTimesheetCsv(
  url: URL,
  userId: string,
  env: Env,
): Promise<Response> {
  const data = await computeTimesheet(url, userId, env);
  const lines: string[] = [
    "date,board,task,duration_hms,duration_hours,duration_seconds",
  ];
  for (const day of data.days) {
    for (const t of day.tasks) {
      lines.push(
        [
          day.date,
          csvEscape(t.board_name),
          csvEscape(t.task_title),
          hms(t.duration_seconds),
          (t.duration_seconds / 3600).toFixed(2),
          String(t.duration_seconds),
        ].join(","),
      );
    }
  }
  lines.push("");
  lines.push(
    `TOTAL,,,${hms(data.total_seconds)},${(data.total_seconds / 3600).toFixed(2)},${data.total_seconds}`,
  );

  const csv = lines.join("\n");
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="timesheet_${data.start}_to_${data.end}.csv"`,
    },
  });
}
