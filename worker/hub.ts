import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";

/**
 * One UserHub per user (addressed by user id). Every open tab/device keeps a
 * WebSocket to it; after any successful change the Worker calls `notify()` and
 * the hub tells the OTHER connected clients to refetch. No data travels over
 * the socket, so authorization stays with the normal API.
 *
 * Uses the WebSocket Hibernation API: idle sockets cost nothing and the object
 * is evicted from memory between messages.
 */
export class UserHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Client keep-alive "ping" is answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const clientId = (new URL(request.url).searchParams.get("cid") ?? "").slice(0, 64);
    const { 0: client, 1: server } = new WebSocketPair();
    // The client id is stored as a tag so notify() can skip the sender.
    this.ctx.acceptWebSocket(server, clientId ? [clientId] : []);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Tell every connected client except `sourceClientId` that data changed. */
  async notify(sourceClientId?: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      if (sourceClientId && this.ctx.getTags(ws).includes(sourceClientId)) continue;
      try {
        ws.send("changed");
      } catch {
        // Socket already closing; the runtime cleans it up.
      }
    }
  }

  webSocketMessage(): void {
    // Clients never send anything meaningful (pings are auto-answered).
  }

  webSocketClose(ws: WebSocket, code: number): void {
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch {
      // already closed
    }
  }
}

/** Fire-and-forget change notification; never fails the request that caused it. */
export function notifyUser(
  env: Env,
  ctx: ExecutionContext | undefined,
  userId: string,
  sourceClientId?: string | null,
): void {
  if (!env.USER_HUB) return;
  const p = env.USER_HUB.getByName(userId)
    .notify(sourceClientId ?? undefined)
    .catch((e) => console.error("live notify failed:", e));
  ctx?.waitUntil(p);
}
