import { useCallback, useEffect, useRef, useState } from "react";
import type { PomodoroPhase } from "../../shared/types.ts";
import { api, type PomodoroState } from "../api.ts";
import { notifyLocal, useLive } from "../live.ts";
import { formatClock } from "../format.ts";

/** Lets other components tell the bar "the session may have changed" (same tab). */
const EVENT = "pomodoro-changed";
export const PomodoroSync = {
  changed: () => window.dispatchEvent(new Event(EVENT)),
};

export function requestPomodoroNotifications(): void {
  try {
    if ("Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission();
    }
  } catch {
    /* notifications are optional */
  }
}

const PHASE_LABEL: Record<PomodoroPhase, string> = {
  focus: "Focus",
  short_break: "Short break",
  long_break: "Long break",
};

function beep(): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.65);
    osc.onended = () => void ctx.close();
  } catch {
    /* sound is optional */
  }
}

function announce(title: string, body: string): void {
  beep();
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body });
    }
  } catch {
    /* ignore */
  }
}

export function PomodoroBar() {
  const [data, setData] = useState<PomodoroState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settledKey = useRef<string>("");

  const load = useCallback(async () => {
    try {
      setData(await api.pomodoro());
    } catch {
      /* transient; the next change or tick retries */
    }
  }, []);

  useEffect(() => void load(), [load]);
  useLive(() => void load());
  useEffect(() => {
    window.addEventListener(EVENT, load);
    return () => window.removeEventListener(EVENT, load);
  }, [load]);

  const session = data?.session ?? null;
  const running = session?.status === "running";

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [running]);

  const remainingMs = !session
    ? 0
    : running && session.phase_ends_at
      ? Math.max(0, Date.parse(session.phase_ends_at) - now)
      : (session.remaining_seconds ?? 0) * 1000;

  // The phase just ended: ask the server to settle it, then announce what is next.
  const endKey = running && session ? `${session.phase}|${session.phase_ends_at}` : "";
  useEffect(() => {
    if (!endKey || remainingMs > 0 || settledKey.current === endKey) return;
    settledKey.current = endKey;
    const finished = session!.phase;
    void (async () => {
      try {
        const next = await api.pomodoro();
        setData(next);
        notifyLocal(); // the board's time totals changed too
        const s = next.session;
        if (finished === "focus") {
          announce("Focus complete 🍅", s ? `Time for a ${PHASE_LABEL[s.phase].toLowerCase()}.` : "Nice work.");
        } else {
          announce("Break is over", "Ready for the next focus?");
        }
      } catch {
        /* ignore */
      }
    })();
  }, [endKey, remainingMs, session]);

  if (!session) return null;

  async function act(fn: () => Promise<PomodoroState>) {
    setBusy(true);
    setError(null);
    try {
      setData(await fn());
      notifyLocal();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  const total = session.duration_seconds * 1000;
  const pct = total > 0 ? Math.min(100, Math.max(0, ((total - remainingMs) / total) * 100)) : 0;
  const isBreak = session.phase !== "focus";
  const waiting = session.status === "waiting";
  const secs = Math.ceil(remainingMs / 1000);

  return (
    <div className={`pomo-bar ${isBreak ? "break" : "focus"}`} role="status" aria-live="polite">
      <div className="pomo-main">
        <span className="pomo-phase">
          {isBreak ? "☕" : "🍅"} {PHASE_LABEL[session.phase]}
          {session.status === "paused" && " · paused"}
        </span>
        <span className="pomo-time">{formatClock(secs)}</span>
        <span className="pomo-task" title={session.task_title}>
          {session.task_title}
        </span>
        <span className="pomo-cycle muted" title="Focus intervals completed in this session">
          🍅 {session.cycle}
        </span>
      </div>
      <div className="pomo-actions">
        {waiting && (
          <button className="btn primary sm" disabled={busy} onClick={() => act(() => api.pomodoroAction("next"))}>
            ▶ Start {PHASE_LABEL[session.phase].toLowerCase()}
          </button>
        )}
        {session.status === "running" && (
          <button className="btn ghost sm" disabled={busy} onClick={() => act(() => api.pomodoroAction("pause"))}>
            ⏸ Pause
          </button>
        )}
        {session.status === "paused" && (
          <button className="btn primary sm" disabled={busy} onClick={() => act(() => api.pomodoroAction("resume"))}>
            ▶ Resume
          </button>
        )}
        {!(waiting && session.phase === "focus") && (
          <button className="btn ghost sm" disabled={busy} onClick={() => act(() => api.pomodoroAction("skip"))}>
            ⏭ Skip
          </button>
        )}
        <button className="btn danger sm" disabled={busy} onClick={() => act(() => api.pomodoroAction("stop"))}>
          ■ Stop
        </button>
      </div>
      {error && <span className="pomo-error">{error}</span>}
      <div className="pomo-progress" aria-hidden="true">
        <span style={{ width: `${waiting ? 0 : pct}%` }} />
      </div>
    </div>
  );
}
