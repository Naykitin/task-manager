#!/usr/bin/env node
// stdio <-> Streamable HTTP bridge for the Task Manager MCP server.
//
// For MCP clients that can only launch a local command (stdio) and cannot talk
// to a remote HTTP server themselves. Zero dependencies; needs Node 18+.
//
//   TASK_MANAGER_MCP_URL=https://<worker>/mcp TASK_MANAGER_API_KEY=tm_... \
//     node scripts/mcp-stdio-bridge.mjs
//
// Reads newline-delimited JSON-RPC from stdin, POSTs each message to the
// server, and writes the JSON-RPC responses to stdout. Logs go to stderr only
// (stdout is reserved for the protocol).

import { createInterface } from "node:readline";

const url = process.env.TASK_MANAGER_MCP_URL || process.argv[2];
const key = process.env.TASK_MANAGER_API_KEY;

if (!url || !key) {
  console.error(
    "task-manager MCP bridge: set TASK_MANAGER_MCP_URL (or pass the URL as an argument) and TASK_MANAGER_API_KEY.",
  );
  process.exit(1);
}

const MAX_CONCURRENT = 5;
let active = 0;
const queue = [];
const pending = new Set();

function pump() {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const task = queue.shift();
    active++;
    const p = task().finally(() => {
      active--;
      pending.delete(p);
      pump();
    });
    pending.add(p);
  }
}

function send(obj) {
  const str = JSON.stringify(obj) + "\n";
  if (!process.stdout.write(str)) {
    process.stdout.once("drain", () => {});
  }
}

function rpcError(id, message) {
  if (id === undefined || id === null) return;
  send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
}

async function forward(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  const ids = (Array.isArray(msg) ? msg : [msg]).map((m) => m?.id).filter((id) => id !== undefined);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${key}`,
        connection: "keep-alive",
      },
      body: line,
      keepalive: true,
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 202) return; // notification accepted, no body
    const text = await res.text();
    if (!res.ok && !text.trim().startsWith("{") && !text.trim().startsWith("[")) {
      console.error(`task-manager MCP bridge: HTTP ${res.status}`);
      ids.forEach((id) => rpcError(id, `HTTP ${res.status} from MCP server`));
      return;
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      ids.forEach((id) => rpcError(id, `Unexpected response (HTTP ${res.status})`));
      return;
    }
    // Plain HTTP errors (401/403/429) arrive as {error: "..."} - surface them.
    if (!Array.isArray(body) && body.jsonrpc !== "2.0") {
      const reason = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
      console.error(`task-manager MCP bridge: ${reason}`);
      ids.forEach((id) => rpcError(id, reason));
      return;
    }
    if (Array.isArray(body)) body.forEach(send);
    else send(body);
  } catch (e) {
    console.error("task-manager MCP bridge:", e?.message ?? e);
    ids.forEach((id) => rpcError(id, `Cannot reach MCP server: ${e?.message ?? e}`));
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  queue.push(() => forward(line));
  pump();
});
rl.on("close", async () => {
  await Promise.all(pending);
});
