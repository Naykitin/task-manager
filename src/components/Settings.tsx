import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type AppSettings } from "../api.ts";
import { useAuth } from "../auth.tsx";
import { getThemeMode, setThemeMode, type ThemeMode } from "../theme.ts";
import { ConfirmModal } from "./ConfirmModal.tsx";
import { CsvImport } from "./CsvImport.tsx";
import { Clients } from "./Clients.tsx";
import { Integrations } from "./Integrations.tsx";

type Section = "account" | "ai" | "time" | "clients" | "appearance" | "data" | "integrations";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "account", label: "Account" },
  { id: "ai", label: "AI & Voice" },
  { id: "time", label: "Time tracking" },
  { id: "clients", label: "Clients" },
  { id: "appearance", label: "Appearance" },
  { id: "data", label: "Data" },
  { id: "integrations", label: "Integrations" },
];

function useSettings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.getSettings().then(setSettings).catch((e) => setError(e.message));
  }, []);
  return { settings, setSettings, error };
}

// ---------------------------------------------------------------- Account

function AccountSection() {
  const { user } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (next !== again) return setMsg({ ok: false, text: "The new passwords do not match" });
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setCurrent("");
      setNext("");
      setAgain("");
      setMsg({ ok: true, text: "Password changed. Other devices were signed out." });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Failed" });
    } finally {
      setBusy(false);
    }
  }

  async function signOutEverywhere() {
    setConfirmOut(false);
    try {
      await api.signOutEverywhere();
      setMsg({ ok: true, text: "Signed out on all other devices." });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Failed" });
    }
  }

  return (
    <div className="settings-card">
      <h3>Account</h3>
      <p className="muted">
        Signed in as <strong>{user?.email}</strong>
      </p>

      <form onSubmit={changePassword} className="settings-form">
        <h4>Change password</h4>
        <label className="field">
          <span>Current password</span>
          <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </label>
        <label className="field">
          <span>New password (min. 8 characters)</span>
          <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </label>
        <label className="field">
          <span>Repeat new password</span>
          <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
        </label>
        <button className="btn primary" disabled={busy || !current || next.length < 8}>
          {busy ? "Saving…" : "Change password"}
        </button>
      </form>

      <div className="settings-form">
        <h4>Devices</h4>
        <p className="muted">Ends your session on every other phone and computer. This device stays signed in.</p>
        <button className="btn danger" onClick={() => setConfirmOut(true)}>
          Sign out everywhere else
        </button>
      </div>

      {msg && <div className={msg.ok ? "settings-ok" : "auth-error"}>{msg.text}</div>}
      {confirmOut && (
        <ConfirmModal
          title="Sign out everywhere"
          message="Every other device will have to log in again. Continue?"
          onCancel={() => setConfirmOut(false)}
          onConfirm={signOutEverywhere}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------- AI & Voice

function AiSection() {
  const { settings, setSettings, error } = useSettings();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const run = useCallback(
    async (fn: () => Promise<AppSettings>, okText?: string) => {
      setBusy(true);
      setMsg(null);
      try {
        setSettings(await fn());
        if (okText) setMsg({ ok: true, text: okText });
      } catch (err) {
        setMsg({ ok: false, text: err instanceof Error ? err.message : "Failed" });
      } finally {
        setBusy(false);
      }
    },
    [setSettings],
  );

  if (error) return <div className="auth-error">{error}</div>;
  if (!settings) return <div className="spinner" />;
  const a = settings.anthropic;

  return (
    <div className="settings-card">
      <h3>AI &amp; Voice</h3>

      <label className="switch-row">
        <input
          type="checkbox"
          checked={settings.voice_enabled}
          disabled={busy}
          onChange={(e) => run(() => api.updateSettings({ voice_enabled: e.target.checked }))}
        />
        <span>
          <strong>Dictation and AI task generation</strong>
          <small>
            Shows &ldquo;Add tasks via voice/text&rdquo; on your boards. Claude turns a note into task proposals you
            review before anything is added.
          </small>
        </span>
      </label>
      {settings.voice_enabled && !a.configured && (
        <div className="auth-error">Turned on, but no API key is available yet - add one below.</div>
      )}

      <div className="settings-form">
        <h4>Anthropic API key</h4>
        <p className="muted">
          {a.configured
            ? a.source === "user"
              ? `Using your saved key (ends in ${a.last4 ?? "????"}).`
              : "Using the server-wide key. You can save your own to override it."
            : "No key yet."}
        </p>

        {settings.encryption_available ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => api.saveAnthropicKey(key.trim()), "Key saved.").then(() => setKey(""));
            }}
            className="key-row"
          >
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-ant-..."
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <button className="btn primary" disabled={busy || !key.trim()}>
              {busy ? "Checking…" : a.source === "user" ? "Replace key" : "Save key"}
            </button>
            {a.source === "user" && (
              <button type="button" className="btn danger" disabled={busy} onClick={() => setConfirmRemove(true)}>
                Remove
              </button>
            )}
          </form>
        ) : (
          <div className="settings-note">
            Saving keys here is off until the server has an encryption secret. Run once, then redeploy:
            <code>npx wrangler secret put SETTINGS_ENCRYPTION_KEY</code>
            and paste any long random string.
          </div>
        )}
        <p className="muted small">
          Keys are encrypted before they are stored, are never shown again after saving, and are only sent to
          Anthropic.
        </p>
      </div>

      {msg && <div className={msg.ok ? "settings-ok" : "auth-error"}>{msg.text}</div>}
      {confirmRemove && (
        <ConfirmModal
          title="Remove API key"
          message="Delete your saved Anthropic key? AI task generation will stop working unless a server-wide key exists."
          onCancel={() => setConfirmRemove(false)}
          onConfirm={() => {
            setConfirmRemove(false);
            void run(() => api.deleteAnthropicKey(), "Key removed.");
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------ Time tracking

function TimeSection() {
  const { settings, setSettings, error } = useSettings();
  const [hours, setHours] = useState<string>("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (settings) setHours(String(settings.auto_stop_hours));
  }, [settings]);

  if (error) return <div className="auth-error">{error}</div>;
  if (!settings) return <div className="spinner" />;

  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      setSettings(await api.updateSettings({ auto_stop_hours: Number(hours) }));
      setMsg({ ok: true, text: "Saved." });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Failed" });
    }
  }

  return (
    <div className="settings-card">
      <h3>Time tracking</h3>
      <form onSubmit={save} className="settings-form">
        <h4>Auto-stop forgotten timers</h4>
        <p className="muted">
          If a timer keeps running longer than this, it is ended at that limit instead of counting hours you were
          not working. Use 0 to turn this off.
        </p>
        <div className="key-row">
          <input
            type="number"
            min={0}
            max={72}
            step={1}
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            style={{ maxWidth: 120 }}
          />
          <span className="muted">hours</span>
          <button className="btn primary" disabled={hours === "" || Number(hours) === settings.auto_stop_hours}>
            Save
          </button>
        </div>
      </form>
      {msg && <div className={msg.ok ? "settings-ok" : "auth-error"}>{msg.text}</div>}
    </div>
  );
}

// -------------------------------------------------------------- Appearance

function AppearanceSection() {
  const [mode, setMode] = useState<ThemeMode>(getThemeMode());
  const options: { id: ThemeMode; label: string }[] = [
    { id: "dark", label: "Dark" },
    { id: "light", label: "Light" },
    { id: "system", label: "Match system" },
  ];
  return (
    <div className="settings-card">
      <h3>Appearance</h3>
      <p className="muted">Remembered on this device.</p>
      <div className="theme-options" role="radiogroup" aria-label="Theme">
        {options.map((o) => (
          <button
            key={o.id}
            role="radio"
            aria-checked={mode === o.id}
            className={mode === o.id ? "btn primary" : "btn ghost"}
            onClick={() => {
              setMode(o.id);
              setThemeMode(o.id);
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- Data

function DataSection() {
  return (
    <div className="settings-card">
      <h3>Data</h3>
      <p className="muted">
        Back up and restore your tracked time. Importing the same file twice never creates duplicates.
      </p>
      <div className="settings-actions">
        <a className="btn accent" href={api.timeEntriesExportUrl} download>
          ⬇ Full backup (CSV)
        </a>
        <CsvImport className="btn accent" />
      </div>
      <p className="muted small">
        For a complete database backup (boards, tasks, steps) use <code>wrangler d1 export</code> or D1 Time
        Travel.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------- Shell

export function Settings() {
  const [section, setSection] = useState<Section>("account");
  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="Settings sections">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={section === s.id ? "settings-tab active" : "settings-tab"}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <div className="settings-body">
        {section === "account" && <AccountSection />}
        {section === "ai" && <AiSection />}
        {section === "time" && <TimeSection />}
        {section === "clients" && <Clients />}
        {section === "appearance" && <AppearanceSection />}
        {section === "data" && <DataSection />}
        {section === "integrations" && <Integrations />}
      </div>
    </div>
  );
}
