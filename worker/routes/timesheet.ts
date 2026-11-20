import type { Env } from "../env.ts";
import type {
  MoneyAmount,
  TimesheetClientTotal,
  TimesheetDay,
  TimesheetResponse,
  TimesheetTaskRow,
} from "../../shared/types.ts";
import { HttpError, json } from "../util.ts";
import { autoStopExpired } from "../lib/autostop.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface CompletedRow {
  started_at: string;
  duration_seconds: number;
  task_id: string;
  task_title: string;
  board_id: string;
  board_name: string;
  client_id: string | null;
  client_name: string | null;
  client_color: string | null;
  rate_minor: number | null; // snapshot, else the client's current rate
  currency: string | null;
}

/** Accumulates rate x seconds per currency; rounded to minor units once, at the end. */
class Money {
  private rateSeconds = new Map<string, number>();
  add(secs: number, rate: number | null, currency: string | null) {
    if (rate === null || !currency) return;
    this.rateSeconds.set(currency, (this.rateSeconds.get(currency) ?? 0) + secs * rate);
  }
  amounts(): MoneyAmount[] {
    return [...this.rateSeconds.entries()]
      .map(([currency, rs]) => ({ currency, amount_minor: Math.round(rs / 3600) }))
      .sort((a, b) => a.currency.localeCompare(b.currency));
  }
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
  await autoStopExpired(env, userId);
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

  // Optional client filter: a client id, or "none" for boards without a client.
  const clientFilter = url.searchParams.get("client_id");
  let clientSql = "";
  const binds: unknown[] = [userId, startBoundary, endBoundary];
  if (clientFilter === "none") {
    clientSql = "AND b.client_id IS NULL";
  } else if (clientFilter) {
    clientSql = "AND b.client_id = ?";
    binds.push(clientFilter);
  }

  const { results } = await env.DB.prepare(
    `SELECT te.started_at        AS started_at,
            te.duration_seconds  AS duration_seconds,
            t.id                 AS task_id,
            t.title              AS task_title,
            b.id                 AS board_id,
            b.name               AS board_name,
            cl.id                AS client_id,
            cl.name              AS client_name,
            cl.color             AS client_color,
            COALESCE(te.rate_minor, cl.rate_minor) AS rate_minor,
            CASE WHEN te.rate_minor IS NOT NULL THEN te.currency
                 WHEN cl.rate_minor IS NOT NULL THEN cl.currency END AS currency
       FROM time_entries te
       JOIN tasks t   ON t.id = te.task_id
       JOIN columns c ON c.id = t.column_id
       JOIN boards b  ON b.id = c.board_id
       LEFT JOIN clients cl ON cl.id = b.client_id
      WHERE te.user_id = ?
        AND te.ended_at IS NOT NULL
        AND te.started_at >= ?
        AND te.started_at <  ?
        ${clientSql}
      ORDER BY te.started_at ASC`,
  )
    .bind(...binds)
    .all<CompletedRow>();

  // day -> task_id -> row
  const dayMap = new Map<string, Map<string, TimesheetTaskRow>>();
  const boardTotals = new Map<string, { name: string; secs: number }>();
  const taskTotals = new Map<
    string,
    { title: string; board_id: string; board_name: string; secs: number }
  >();
  const clientTotals = new Map<
    string,
    { id: string | null; name: string; color: string | null; secs: number; money: Money }
  >();
  const totalMoney = new Money();
  let total = 0;

  for (const r of results) {
    const secs = r.duration_seconds ?? 0;
    total += secs;
    totalMoney.add(secs, r.rate_minor, r.currency);
    const ck = r.client_id ?? "";
    let ct = clientTotals.get(ck);
    if (!ct) {
      ct = {
        id: r.client_id,
        name: r.client_name ?? "No client",
        color: r.client_color,
        secs: 0,
        money: new Money(),
      };
      clientTotals.set(ck, ct);
    }
    ct.secs += secs;
    ct.money.add(secs, r.rate_minor, r.currency);
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
        client_name: r.client_name,
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
    amounts: totalMoney.amounts(),
    by_client: [...clientTotals.values()]
      .map(
        (c): TimesheetClientTotal => ({
          client_id: c.id,
          client_name: c.name,
          color: c.color,
          duration_seconds: c.secs,
          amounts: c.money.amounts(),
        }),
      )
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
    "date,client,board,task,duration_hms,duration_hours,duration_seconds",
  ];
  for (const day of data.days) {
    for (const t of day.tasks) {
      lines.push(
        [
          day.date,
          csvEscape(t.client_name ?? ""),
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
    `TOTAL,,,,${hms(data.total_seconds)},${(data.total_seconds / 3600).toFixed(2)},${data.total_seconds}`,
  );
  for (const m of data.amounts) {
    lines.push(`AMOUNT ${m.currency},,,,${(m.amount_minor / 100).toFixed(2)}`);
  }

  const csv = lines.join("\n");
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="timesheet_${data.start}_to_${data.end}.csv"`,
    },
  });
}
