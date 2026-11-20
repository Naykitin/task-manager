import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Board, Client, PomodoroSettings as Cfg } from "../../shared/types.ts";
import { api } from "../api.ts";
import { useLive } from "../live.ts";
import { PomodoroSync, requestPomodoroNotifications } from "./PomodoroBar.tsx";

interface Group {
  key: string;
  label: string;
  boards: Board[];
}

function groupBoards(boards: Board[], clients: Client[]): Group[] {
  const groups: Group[] = [];
  for (const c of clients) {
    const own = boards.filter((b) => b.client_id === c.id);
    if (own.length > 0) {
      groups.push({ key: c.id, label: c.is_personal ? `${c.name} · personal` : c.name, boards: own });
    }
  }
  const known = new Set(clients.map((c) => c.id));
  const rest = boards.filter((b) => !b.client_id || !known.has(b.client_id));
  if (rest.length > 0) groups.push({ key: "none", label: "No client", boards: rest });
  return groups;
}

const FIELDS: { key: "focus_min" | "short_min" | "long_min" | "long_every"; label: string; min: number; max: number }[] = [
  { key: "focus_min", label: "Focus (minutes)", min: 1, max: 180 },
  { key: "short_min", label: "Short break (minutes)", min: 1, max: 60 },
  { key: "long_min", label: "Long break (minutes)", min: 1, max: 120 },
  { key: "long_every", label: "Long break every N focuses", min: 2, max: 12 },
];

export function PomodoroSettings() {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [boards, setBoards] = useState<Board[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, b, c] = await Promise.all([api.getSettings(), api.listBoards(), api.listClients()]);
      setCfg(s.pomodoro);
      setBoards(b.boards);
      setClients(c.clients);
      setDraft({
        focus_min: String(s.pomodoro.focus_min),
        short_min: String(s.pomodoro.short_min),
        long_min: String(s.pomodoro.long_min),
        long_every: String(s.pomodoro.long_every),
      });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Failed to load" });
    }
  }, []);
  useEffect(() => void load(), [load]);
  useLive(() => void load());

  async function saveDurations(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    const patch: Record<string, number> = {};
    for (const f of FIELDS) {
      const n = Number(draft[f.key]);
      if (!Number.isInteger(n) || n < f.min || n > f.max) {
        return setMsg({ ok: false, text: `${f.label}: enter a whole number from ${f.min} to ${f.max}` });
      }
      patch[f.key] = n;
    }
    setBusy(true);
    try {
      const s = await api.updateSettings({ pomodoro: patch });
      setCfg(s.pomodoro);
      setMsg({ ok: true, text: "Saved. New lengths apply to the next phase you start." });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Failed" });
    } finally {
      setBusy(false);
    }
  }

  async function setAutoStart(auto_start: boolean) {
    try {
      const s = await api.updateSettings({ pomodoro: { auto_start } });
      setCfg(s.pomodoro);
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Failed" });
    }
  }

  async function setBoardsEnabled(targets: Board[], enabled: boolean) {
    const want = enabled ? 1 : 0;
    const changing = targets.filter((b) => b.pomodoro_enabled !== want);
    if (changing.length === 0) return;
    setBusy(true);
    setMsg(null);
    // Optimistic: flip locally, then reconcile with the server.
    setBoards((bs) => bs.map((b) => (changing.some((t) => t.id === b.id) ? { ...b, pomodoro_enabled: want } : b)));
    try {
      await Promise.all(changing.map((b) => api.updateBoard(b.id, { pomodoro_enabled: enabled })));
      PomodoroSync.changed(); // switching a board off may have ended the session
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Failed" });
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!cfg) return msg ? <div className="auth-error">{msg.text}</div> : <div className="spinner" />;

  const groups = groupBoards(boards, clients);
  const notifState = "Notification" in window ? Notification.permission : "unsupported";

  return (
    <div className="settings-card">
      <h3>Pomodoro</h3>
      <p className="muted">
        Work in focused intervals with breaks in between. A focus interval is tracked as normal time on the task
        (so it counts toward clients and earnings); breaks are not tracked.
      </p>

      <div className="settings-form" style={{ alignItems: "stretch" }}>
        <h4>Boards with Pomodoro</h4>
        <p className="muted">The Pomodoro button only appears on the boards you tick here.</p>
        {boards.length === 0 ? (
          <div className="muted">No boards yet.</div>
        ) : (
          <div className="pomo-board-list">
            {groups.map((g) => {
              const on = g.boards.filter((b) => b.pomodoro_enabled === 1).length;
              return (
                <div key={g.key} className="pomo-group">
                  <label className="group-head">
                    <input
                      type="checkbox"
                      checked={on === g.boards.length}
                      ref={(el) => {
                        if (el) el.indeterminate = on > 0 && on < g.boards.length;
                      }}
                      disabled={busy}
                      onChange={(e) => void setBoardsEnabled(g.boards, e.target.checked)}
                    />
                    {g.label}
                  </label>
                  <ul>
                    {g.boards.map((b) => (
                      <li key={b.id}>
                        <label>
                          <input
                            type="checkbox"
                            checked={b.pomodoro_enabled === 1}
                            disabled={busy}
                            onChange={(e) => void setBoardsEnabled([b], e.target.checked)}
                          />
                          {b.name}
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <form onSubmit={saveDurations} className="settings-form" style={{ alignItems: "stretch" }}>
        <h4>Lengths</h4>
        <div className="pomo-grid">
          {FIELDS.map((f) => (
            <label key={f.key}>
              {f.label}
              <input
                type="number"
                min={f.min}
                max={f.max}
                step={1}
                value={draft[f.key] ?? ""}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              />
            </label>
          ))}
        </div>
        <div>
          <button className="btn primary" disabled={busy}>
            Save lengths
          </button>
        </div>
      </form>

      <div className="settings-form" style={{ alignItems: "stretch" }}>
        <h4>Behavior</h4>
        <label className="client-check">
          <input type="checkbox" checked={cfg.auto_start} onChange={(e) => void setAutoStart(e.target.checked)} />
          Start the next phase automatically (otherwise it waits for you to press Start)
        </label>
        <div className="key-row">
          <span className="muted">
            Desktop notifications:{" "}
            {notifState === "granted" ? "on" : notifState === "denied" ? "blocked in the browser" : notifState === "unsupported" ? "not supported" : "off"}
          </span>
          {notifState === "default" && (
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => {
                requestPomodoroNotifications();
                setTimeout(() => setMsg({ ok: true, text: "Check your browser's permission prompt." }), 0);
              }}
            >
              Enable notifications
            </button>
          )}
        </div>
      </div>

      {msg && <div className={msg.ok ? "settings-ok" : "auth-error"}>{msg.text}</div>}
    </div>
  );
}
