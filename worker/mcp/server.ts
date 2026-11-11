import type { Env } from "../env.ts";
import { authenticateApiKey, type ApiPrincipal } from "../apikeys.ts";
import { HttpError, newId } from "../util.ts";
import { mcpChallenge } from "../oauth.ts";
import { allow, clientIp } from "../ratelimit.ts";
import { TOOLS, type Tool } from "./tools.ts";

// ---------------------------------------------------------------------------
// Minimal stateless MCP server over Streamable HTTP (JSON responses only).
// Spec: https://modelcontextprotocol.io/specification — POST /mcp carries
// JSON-RPC 2.0 messages. No sessions, no server-initiated streams, so GET and
// DELETE answer 405. Provider-agnostic: Claude, Gemini CLI, Cursor, local agents…
// ---------------------------------------------------------------------------

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "task-manager", version: "1.0.0" };
const INSTRUCTIONS =
  "Kanban task manager with time tracking. Call list_boards first to get board ids, then get_board for columns/tasks. " +
  "Columns can be referenced by name (e.g. 'Done') when board_id is known. Destructive tools exist only if the API key has the delete scope.";

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
}

class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

// ---- Origin / CORS ---------------------------------------------------------

function allowedOrigin(req: Request, env: Env): string | null {
  const origin = req.headers.get("Origin");
  if (!origin) return null;
  const allow = (env.MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (origin === new URL(req.url).origin || allow.includes(origin)) return origin;
  return "";
}

function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers":
      "authorization, content-type, x-api-key, mcp-protocol-version, mcp-session-id",
    "access-control-allow-methods": "POST, OPTIONS",
    vary: "Origin",
  };
}

function plain(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

// ---- Resources & prompts ---------------------------------------------------

const RESOURCES = [
  {
    uri: "taskmanager://boards",
    name: "Boards",
    description: "All boards with task counts",
    mimeType: "application/json",
  },
  {
    uri: "taskmanager://active-timer",
    name: "Active timer",
    description: "The task currently being timed, if any",
    mimeType: "application/json",
  },
];

const RESOURCE_TOOL: Record<string, string> = {
  "taskmanager://boards": "list_boards",
  "taskmanager://active-timer": "get_active_timer",
};

const PROMPTS = [
  {
    name: "daily_standup",
    description: "Morning briefing: what's in progress, queued, and tracked recently.",
    arguments: [],
  },
  {
    name: "break_down_goal",
    description: "Break a goal into concrete tasks and add them to a board.",
    arguments: [
      { name: "goal", description: "What you want to achieve", required: true },
      { name: "board", description: "Board name or id (optional)", required: false },
    ],
  },
];

function promptText(name: string, args: Record<string, string>): string {
  if (name === "daily_standup") {
    return (
      "Prepare my daily standup. Use list_boards and get_board to review my boards, get_active_timer for current work, " +
      "and get_timesheet for yesterday and today. Summarise: (1) done recently, (2) in progress, (3) next up, (4) blockers (tasks with 'blocks' links). Keep it short."
    );
  }
  if (name === "break_down_goal") {
    if (!args.goal) throw new RpcError(-32602, "Missing required argument: goal");
    return (
      `Break this goal into 3-10 concrete, actionable tasks: "${args.goal}".\n` +
      (args.board
        ? `Use the board "${args.board}" (look it up with list_boards).`
        : "Pick the most fitting board with list_boards, or create one with create_board.") +
      " Check search_tasks first to avoid duplicates, then add the tasks with bulk_create_tasks and link dependencies with link_tasks."
    );
  }
  throw new RpcError(-32602, `Unknown prompt: ${name}`);
}

// ---- Dispatch --------------------------------------------------------------

function visibleTools(p: ApiPrincipal): Tool[] {
  return TOOLS.filter((t) => p.scopes.has(t.scope));
}

/** Records a tool call (name + outcome only; arguments are never stored). */
function audit(
  env: Env,
  p: ApiPrincipal,
  tool: string,
  ok: boolean,
  error?: string,
  ctx?: ExecutionContext,
) {
  const pIns = env.DB.prepare(
    "INSERT INTO mcp_audit_log (id, user_id, source, credential, tool, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(newId(), p.userId, p.source, p.credential, tool, ok ? 1 : 0, error?.slice(0, 300) ?? null)
    .run()
    .catch((e) => console.error("audit log failure:", e));

  if (ctx) ctx.waitUntil(pIns);
}

async function runTool(
  tool: Tool,
  args: Record<string, unknown>,
  env: Env,
  p: ApiPrincipal,
  ctx?: ExecutionContext,
) {
  try {
    const result = await tool.handler(args, { env, userId: p.userId });
    audit(env, p, tool.name, true, undefined, ctx);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    if (e instanceof HttpError) {
      audit(env, p, tool.name, false, e.message, ctx);
      return { isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
    console.error("MCP tool failure:", tool.name, e);
    audit(env, p, tool.name, false, "internal error", ctx);
    return { isError: true, content: [{ type: "text", text: "Error: internal server error" }] };
  }
}

async function dispatch(
  msg: RpcMessage,
  env: Env,
  p: ApiPrincipal,
  ctx?: ExecutionContext,
): Promise<unknown> {
  const params = msg.params ?? {};
  switch (msg.method) {
    case "initialize": {
      const requested = String(params.protocolVersion ?? "");
      return {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: visibleTools(p).map(({ name, description, inputSchema, annotations }) => ({
          name,
          description,
          inputSchema,
          ...(annotations ? { annotations } : {}),
        })),
      };
    case "tools/call": {
      const tool = visibleTools(p).find((t) => t.name === params.name);
      if (!tool) throw new RpcError(-32602, `Unknown tool: ${params.name}`);
      return runTool(tool, params.arguments ?? {}, env, p, ctx);
    }
    case "resources/list":
      return { resources: p.scopes.has("read") ? RESOURCES : [] };
    case "resources/read": {
      const toolName = RESOURCE_TOOL[String(params.uri)];
      const tool = TOOLS.find((t) => t.name === toolName);
      if (!tool || !p.scopes.has("read")) {
        throw new RpcError(-32002, `Resource not found: ${params.uri}`);
      }
      const data = await tool.handler({}, { env, userId: p.userId });
      return {
        contents: [
          { uri: params.uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) },
        ],
      };
    }
    case "prompts/list":
      return { prompts: PROMPTS };
    case "prompts/get":
      return {
        messages: [
          {
            role: "user",
            content: { type: "text", text: promptText(String(params.name), params.arguments ?? {}) },
          },
        ],
      };
    default:
      throw new RpcError(-32601, `Method not found: ${msg.method}`);
  }
}

async function handleMessage(
  msg: RpcMessage,
  env: Env,
  p: ApiPrincipal,
  ctx?: ExecutionContext,
) {
  const isNotification = msg.id === undefined;
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return isNotification
      ? null
      : { jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32600, message: "Invalid request" } };
  }
  try {
    const result = await dispatch(msg, env, p, ctx);
    return isNotification ? null : { jsonrpc: "2.0", id: msg.id, result };
  } catch (e) {
    if (isNotification) return null;
    if (e instanceof RpcError) {
      return { jsonrpc: "2.0", id: msg.id, error: { code: e.code, message: e.message } };
    }
    if (e instanceof HttpError) {
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: e.message } };
    }
    console.error("MCP error:", e);
    return { jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error" } };
  }
}

export async function handleMcp(
  req: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const origin = allowedOrigin(req, env);
  if (origin === "") return plain(403, { error: "Origin not allowed" });
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") {
    return plain(405, { error: "Method not allowed" }, { ...cors, allow: "POST, OPTIONS" });
  }

  // Pre-auth IP rate limiter: shields D1 database from volumetric unauthenticated scans
  const ip = clientIp(req);
  if (!(await allow(env.MCP_LIMITER, `mcp:ip:${ip}`))) {
    await req.arrayBuffer().catch(() => undefined);
    return plain(429, { error: "Too many requests, slow down" }, { ...cors, "retry-after": "60" });
  }

  // Authenticate key/token
  const principal = await authenticateApiKey(req, env, ctx);
  if (!principal) {
    await req.arrayBuffer().catch(() => undefined); // drain the unread body
    if (!(await allow(env.MCP_LIMITER, `fail:${ip}`))) {
      return plain(429, { error: "Too many requests, slow down" }, { ...cors, "retry-after": "60" });
    }
    return plain(401, { error: "Invalid or missing API key" }, {
      ...cors,
      "www-authenticate": mcpChallenge(req),
    });
  }

  // User-scoped rate limit
  if (!(await allow(env.MCP_LIMITER, `user:${principal.userId}`))) {
    await req.arrayBuffer().catch(() => undefined);
    return plain(429, { error: "Too many requests, slow down" }, { ...cors, "retry-after": "60" });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return plain(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, cors);
  }

  if (Array.isArray(body)) {
    // Clamped batch size to prevent CPU/memory exhaustion
    if (body.length === 0 || body.length > 15) {
      return plain(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid batch (max 15 items)" } }, cors);
    }
    // Bounded concurrency pool (max 4 concurrent handlers) to avoid DB lock contention
    const concurrency = 4;
    const out: unknown[] = new Array(body.length);
    let idx = 0;
    const workers = Array.from({ length: Math.min(concurrency, body.length) }, async () => {
      while (idx < body.length) {
        const i = idx++;
        out[i] = await handleMessage(body[i] as RpcMessage, env, principal, ctx);
      }
    });
    await Promise.all(workers);
    const filtered = out.filter(Boolean);
    return filtered.length ? plain(200, filtered, cors) : new Response(null, { status: 202, headers: cors });
  }

  const res = await handleMessage(body as RpcMessage, env, principal, ctx);
  return res ? plain(200, res, cors) : new Response(null, { status: 202, headers: cors });
}
