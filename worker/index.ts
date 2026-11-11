import type { Env } from "./env.ts";
import { requireUser } from "./auth.ts";
import { error, HttpError, json } from "./util.ts";
import * as authRoutes from "./routes/auth.ts";
import * as boards from "./routes/boards.ts";
import * as tasks from "./routes/tasks.ts";
import * as timer from "./routes/timer.ts";
import * as timesheet from "./routes/timesheet.ts";
import * as voice from "./routes/voice.ts";
import * as apikeys from "./apikeys.ts";
import * as integrations from "./routes/integrations.ts";
import { allow, clientIp, tooManyRequests } from "./ratelimit.ts";
import { handleMcp } from "./mcp/server.ts";
import { handleOAuth } from "./oauth.ts";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // OAuth discovery + authorization server for remote MCP clients.
    if (url.pathname.startsWith("/oauth/") || url.pathname.startsWith("/.well-known/")) {
      return handleOAuth(req, env, url, ctx);
    }

    // MCP endpoint (Streamable HTTP). Has its own API-key auth + CORS rules.
    if (url.pathname === "/mcp") {
      try {
        return await handleMcp(req, env, ctx);
      } catch (e) {
        console.error("MCP error:", e);
        return error(500, "Internal server error");
      }
    }

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
    if (
      (b === "login" || b === "register") &&
      method === "POST" &&
      !(await allow(env.AUTH_LIMITER, `auth:${clientIp(req)}`))
    ) {
      return tooManyRequests();
    }
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
    if (method === "PATCH") return boards.updateBoard(req, b, userId, env);
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

  // ---- API keys (for the MCP endpoint; session-cookie only) ----
  if (a === "api-keys" && !b) {
    if (method === "GET") return apikeys.listApiKeys(userId, env);
    if (method === "POST") return apikeys.createApiKey(req, userId, env);
  }
  if (a === "api-keys" && b && !c && method === "DELETE") {
    return apikeys.revokeApiKey(b, userId, env);
  }

  // ---- Integrations UI: connected OAuth apps + MCP activity ----
  if (a === "oauth" && b === "grants" && !c && method === "GET") {
    return integrations.listGrants(userId, env);
  }
  if (a === "oauth" && b === "grants" && c && !d && method === "DELETE") {
    return integrations.revokeGrant(c, userId, env);
  }
  if (a === "mcp" && b === "activity" && !c && method === "GET") {
    return integrations.listActivity(url, userId, env);
  }

  // ---- Tasks ----
  if (a === "tasks" && b === "search" && !c && method === "GET") {
    return tasks.searchTasks(url, userId, env);
  }
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

  // ---- Voice notes ----
  if (a === "voice-notes" && b === "availability" && !c && method === "GET") {
    return voice.getVoiceAvailability(env);
  }
  if (a === "voice-notes" && !b) {
    if (method === "GET") return voice.listVoiceNotes(url, userId, env);
    if (method === "POST") return voice.createVoiceNote(req, userId, env);
  }
  if (a === "voice-notes" && b && c === "structure" && method === "POST") {
    return voice.structureVoiceNote(req, b, userId, env);
  }
  if (a === "voice-notes" && b && c === "apply" && method === "POST") {
    return voice.applyVoiceNote(req, b, userId, env);
  }
  if (a === "voice-notes" && b && c === "discard" && method === "POST") {
    return voice.discardVoiceNote(b, userId, env);
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
