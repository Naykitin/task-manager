import type { Env } from "./env.ts";
import { requireUser } from "./auth.ts";
import { error, HttpError, json } from "./util.ts";
import * as authRoutes from "./routes/auth.ts";
import * as boards from "./routes/boards.ts";
import * as tasks from "./routes/tasks.ts";
import * as timer from "./routes/timer.ts";
import * as timesheet from "./routes/timesheet.ts";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Only /api/* reaches the Worker (run_worker_first). Anything else is a
    // static asset; delegate defensively just in case.
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(req);
    }

    try {
      return await route(req, env, url);
    } catch (e) {
      if (e instanceof HttpError) return error(e.status, e.message);
      console.error("Unhandled error:", e);
      return error(500, "Internal server error");
    }
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env, url: URL): Promise<Response> {
  const method = req.method;
  // Path segments after "/api"
  const seg = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const [a, b, c, d] = seg;

  // ---- Public auth routes ----
  if (a === "auth") {
    if (b === "register" && method === "POST") return authRoutes.register(req, env);
    if (b === "login" && method === "POST") return authRoutes.login(req, env);
    if (b === "logout" && method === "POST") return authRoutes.logout();
    if (b === "me" && method === "GET") {
      const userId = await requireUser(req, env);
      return authRoutes.me(userId, env);
    }
  }

  // Everything below requires authentication.
  const userId = await requireUser(req, env);

  // ---- Boards ----
  if (a === "boards" && !b) {
    if (method === "GET") return boards.listBoards(userId, env);
    if (method === "POST") return boards.createBoard(req, userId, env);
  }
  if (a === "boards" && b && !c) {
    if (method === "GET") return boards.getBoard(b, userId, env);
    if (method === "DELETE") return boards.deleteBoard(b, userId, env);
  }

  // ---- Columns ----
  if (a === "columns" && !b && method === "POST") {
    return boards.createColumn(req, userId, env);
  }
  if (a === "columns" && b && !c) {
    if (method === "PATCH") return boards.updateColumn(req, b, userId, env);
    if (method === "DELETE") return boards.deleteColumn(b, userId, env);
  }

  // ---- Tasks ----
  if (a === "tasks" && !b && method === "POST") {
    return tasks.createTask(req, userId, env);
  }
  if (a === "tasks" && b && !c) {
    if (method === "PATCH") return tasks.updateTask(req, b, userId, env);
    if (method === "DELETE") return tasks.deleteTask(b, userId, env);
  }
  if (a === "tasks" && b && c === "move" && method === "PATCH") {
    return tasks.moveTask(req, b, userId, env);
  }
  if (a === "tasks" && b && c === "timer" && d === "start" && method === "POST") {
    return timer.startTimer(b, userId, env);
  }
  if (a === "tasks" && b && c === "timer" && d === "stop" && method === "POST") {
    return timer.stopTimer(b, userId, env);
  }
  if (a === "tasks" && b && c === "time-entries" && method === "GET") {
    return timer.listTimeEntries(b, userId, env);
  }
  if (a === "tasks" && b && c === "time-entries" && method === "POST") {
    return timer.createManualEntry(req, b, userId, env);
  }

  // ---- Time entries (direct edit/delete by id) ----
  if (a === "time-entries" && b && !c) {
    if (method === "PATCH") return timer.updateTimeEntry(req, b, userId, env);
    if (method === "DELETE") return timer.deleteTimeEntry(b, userId, env);
  }

  // ---- Timesheet ----
  if (a === "timesheet" && !b && method === "GET") {
    return timesheet.getTimesheet(url, userId, env);
  }
  if (a === "timesheet" && b === "export" && method === "GET") {
    return timesheet.exportTimesheetCsv(url, userId, env);
  }

  return json({ error: "Not found" }, { status: 404 });
}
