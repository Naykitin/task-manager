import React, { useCallback, useEffect, useState } from "react";
import {
  api,
  type ApiKeyInfo,
  type McpActivity,
  type McpScope,
  type OAuthGrant,
} from "../api.ts";
import { ConfirmModal } from "./ConfirmModal.tsx";

const SCOPE_HELP: Record<McpScope, string> = {
  read: "read boards, tasks, timers",
  write: "create / edit / move tasks, run timers",
  delete: "permanently delete tasks, columns, boards",
};

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "never";
}

interface CreateFormProps {
  onCreated: (key: string) => void;
  onError: (err: string) => void;
}

function CreateApiKeyForm({ onCreated, onError }: CreateFormProps) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Record<McpScope, boolean>>({
    read: true,
    write: true,
    delete: false,
  });

  async function createKey(e: React.FormEvent) {
    e.preventDefault();
    const chosen = (Object.keys(scopes) as McpScope[]).filter((s) => scopes[s]);
    if (!name.trim() || chosen.length === 0) return;
    try {
      const res = await api.createApiKey(name.trim(), chosen);
      onCreated(res.key);
      setName("");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to create key");
    }
  }

  return (
    <form className="int-form" onSubmit={createKey}>
      <input
        className="int-input"
        placeholder="Key name, e.g. claude-code or my-agent"
        value={name}
        maxLength={100}
        onChange={(e) => setName(e.target.value)}
      />
      <div className="int-scopes">
        {(Object.keys(SCOPE_HELP) as McpScope[]).map((s) => (
          <label key={s} title={SCOPE_HELP[s]}>
            <input
              type="checkbox"
              checked={scopes[s]}
              onChange={(e) => setScopes({ ...scopes, [s]: e.target.checked })}
            />{" "}
            {s}
          </label>
        ))}
      </div>
      <button className="btn primary" type="submit">
        Create key
      </button>
    </form>
  );
}

export function Integrations() {
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [grants, setGrants] = useState<OAuthGrant[]>([]);
  const [activity, setActivity] = useState<McpActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<
    { kind: "key" | "grant"; id: string; label: string } | null
  >(null);

  const load = useCallback(async () => {
    try {
      const [k, g, a] = await Promise.all([
        api.listApiKeys(),
        api.listGrants(),
        api.mcpActivity(50),
      ]);
      setKeys(k.keys);
      setGrants(g.grants);
      setActivity(a.activity);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleKeyCreated(key: string) {
    setNewKey(key);
    setCopied(false);
    await load();
  }

  async function copyKeyToClipboard() {
    if (!newKey) return;
    try {
      await navigator.clipboard.writeText(newKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  }

  async function doRevoke() {
    if (!confirm) return;
    try {
      if (confirm.kind === "key") await api.revokeApiKey(confirm.id);
      else await api.revokeGrant(confirm.id);
      setConfirm(null);
      await load();
    } catch (err) {
      setConfirm(null);
      setError(err instanceof Error ? err.message : "Failed to revoke");
    }
  }

  const origin = window.location.origin;

  if (loading) {
    return (
      <div className="center-screen">
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div className="integrations">
      {error && <div className="banner-error">{error}</div>}

      <section className="int-card">
        <h2>MCP endpoint</h2>
        <p className="muted">
          Connect your AI assistants, coding agents, or LLMs (such as Claude, Gemini, Cursor, or local agent runners) to{" "}
          <code>{origin}/mcp</code> using the Model Context Protocol (MCP). Web connectors authenticate seamlessly via OAuth 2.1, while CLI tools and local agents connect using an API key below.
        </p>
      </section>

      <section className="int-card">
        <h2>API keys</h2>
        <CreateApiKeyForm
          onCreated={handleKeyCreated}
          onError={(msg) => setError(msg)}
        />

        {newKey && (
          <div className="int-newkey">
            <strong>Copy your key now. It will not be shown again.</strong>
            <code>{newKey}</code>
            <div>
              <button className="btn ghost sm" onClick={copyKeyToClipboard}>
                {copied ? "Copied!" : "Copy"}
              </button>{" "}
              <button className="btn ghost sm" onClick={() => setNewKey(null)}>
                Done
              </button>
            </div>
          </div>
        )}

        {keys.length === 0 ? (
          <p className="muted">No API keys yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="ts-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Key</th>
                  <th>Scopes</th>
                  <th>Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id} className={k.revoked_at ? "int-revoked" : ""}>
                    <td>{k.name}</td>
                    <td>
                      <code>{k.key_prefix}…</code>
                    </td>
                    <td>{k.scopes.split(",").join(", ")}</td>
                    <td>{k.revoked_at ? "revoked" : when(k.last_used_at)}</td>
                    <td>
                      {!k.revoked_at && (
                        <button
                          className="btn ghost sm"
                          onClick={() =>
                            setConfirm({ kind: "key", id: k.id, label: k.name })
                          }
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="int-card">
        <h2>Connected apps</h2>
        {grants.length === 0 ? (
          <p className="muted">No apps connected through OAuth.</p>
        ) : (
          <div className="table-scroll">
            <table className="ts-table">
              <thead>
                <tr>
                  <th>App</th>
                  <th>Scopes</th>
                  <th>Connected</th>
                  <th>Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {grants.map((g) => (
                  <tr key={g.client_id}>
                    <td>{g.client_name}</td>
                    <td>{(g.scopes ?? "").split(" ").join(", ")}</td>
                    <td>{when(g.connected_at)}</td>
                    <td>{when(g.last_used_at)}</td>
                    <td>
                      <button
                        className="btn ghost sm"
                        onClick={() =>
                          setConfirm({
                            kind: "grant",
                            id: g.client_id,
                            label: g.client_name,
                          })
                        }
                      >
                        Disconnect
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="int-card">
        <div className="int-head">
          <h2>Recent activity</h2>
          <button className="btn ghost sm" onClick={load}>
            Refresh
          </button>
        </div>
        {activity.length === 0 ? (
          <p className="muted">No MCP calls yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="ts-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Client</th>
                  <th>Tool</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {activity.map((a) => (
                  <tr key={a.id}>
                    <td>{when(a.created_at)}</td>
                    <td>
                      {a.credential}{" "}
                      <span className="muted">
                        ({a.source === "oauth" ? "OAuth" : "key"})
                      </span>
                    </td>
                    <td>
                      <code>{a.tool}</code>
                    </td>
                    <td>{a.ok ? "ok" : (a.error ?? "error")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {confirm && (
        <ConfirmModal
          title={confirm.kind === "key" ? "Revoke API key" : "Disconnect app"}
          message={`${confirm.kind === "key" ? "Revoke" : "Disconnect"} "${confirm.label}"? It will stop working immediately.`}
          confirmLabel={confirm.kind === "key" ? "Revoke" : "Disconnect"}
          onCancel={() => setConfirm(null)}
          onConfirm={doRevoke}
        />
      )}
    </div>
  );
}
