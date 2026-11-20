import { useEffect, useRef } from "react";

// Live sync: one WebSocket per tab to /api/live. The server only says
// "something changed" (never with data); subscribers then refetch normally.

/** Identifies this tab so the server does not echo our own changes back. */
export const clientId = crypto.randomUUID();

type Listener = () => void;
const listeners = new Set<Listener>();

function emit() {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // a broken subscriber must not stop the others
    }
  }
}

export function subscribeLive(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Re-runs `fn` whenever another device changed something (or we reconnected). */
export function useLive(fn: Listener) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => subscribeLive(() => ref.current()), []);
}

/** Opens and maintains the connection. Returns a stop function. */
export function startLive(): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let retry = 0;
  let everConnected = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;

  const scheduleEmit = () => {
    clearTimeout(debounce);
    debounce = setTimeout(emit, 250);
  };

  function connect() {
    if (stopped || (ws && ws.readyState <= WebSocket.OPEN)) return;
    clearTimeout(reconnectTimer);
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${location.host}/api/live?cid=${clientId}`);
    ws = socket;

    socket.onopen = () => {
      retry = 0;
      // Anything that changed while we were disconnected is unknown: refetch.
      if (everConnected) scheduleEmit();
      everConnected = true;
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send("ping");
      }, 30_000);
    };
    socket.onmessage = (e) => {
      if (e.data === "changed") scheduleEmit();
    };
    socket.onclose = () => {
      clearInterval(pingTimer);
      if (ws === socket) ws = null;
      if (stopped) return;
      const delay = Math.min(30_000, 1000 * 2 ** retry++);
      reconnectTimer = setTimeout(connect, delay);
    };
    socket.onerror = () => socket.close();
  }

  // Phones suspend background tabs: catch up as soon as we are visible again.
  const onVisible = () => {
    if (document.visibilityState !== "visible") return;
    connect();
    scheduleEmit();
  };
  const onOnline = () => {
    connect();
    scheduleEmit();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", onOnline);
  connect();

  return () => {
    stopped = true;
    clearTimeout(reconnectTimer);
    clearTimeout(debounce);
    clearInterval(pingTimer);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", onOnline);
    ws?.close();
  };
}
