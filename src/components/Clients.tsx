import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Client } from "../../shared/types.ts";
import { api } from "../api.ts";
import { useLive } from "../live.ts";
import { formatMoney, minorToInput, parseMoneyToMinor } from "../format.ts";
import { ConfirmModal } from "./ConfirmModal.tsx";

const CURRENCIES = ["USD", "EUR", "GBP", "RUB", "UAH", "KZT", "BYN", "PLN", "CZK", "CHF", "CAD", "AUD", "TRY", "AED", "CNY", "JPY"];
const PALETTE = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#06b6d4", "#a855f7", "#ec4899", "#84cc16"];

interface Draft {
  name: string;
  rate: string;
  currency: string;
  personal: boolean;
  color: string;
}

const emptyDraft = (): Draft => ({ name: "", rate: "", currency: "USD", personal: false, color: PALETTE[0] });

const OTHER = "__other__";

function currencyLabel(code: string): string {
  try {
    const name = new Intl.DisplayNames(undefined, { type: "currency" }).of(code);
    return name && name !== code ? `${code} — ${name}` : code;
  } catch {
    return code;
  }
}

function CurrencyInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  // A code outside the list (set earlier, or typed via "Other") keeps its own text field.
  const [custom, setCustom] = useState(!CURRENCIES.includes(value));
  return (
    <>
      <select
        aria-label="Currency"
        value={custom ? OTHER : value}
        onChange={(e) => {
          if (e.target.value === OTHER) {
            setCustom(true);
          } else {
            setCustom(false);
            onChange(e.target.value);
          }
        }}
        style={{ width: "auto" }}
      >
        {CURRENCIES.map((c) => (
          <option key={c} value={c}>
            {currencyLabel(c)}
          </option>
        ))}
        <option value={OTHER}>Other…</option>
      </select>
      {custom && (
        <input
          value={value}
          maxLength={3}
          placeholder="XXX"
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          aria-label="Currency code"
          style={{ width: 64 }}
        />
      )}
    </>
  );
}

function ClientForm({
  draft,
  setDraft,
  onSubmit,
  submitLabel,
  busy,
  onCancel,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  onSubmit: () => void;
  submitLabel: string;
  busy: boolean;
  onCancel?: () => void;
}) {
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  return (
    <form
      className="client-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <input
        placeholder="Client name"
        value={draft.name}
        maxLength={100}
        onChange={(e) => set({ name: e.target.value })}
        aria-label="Client name"
      />
      <label className="client-rate">
        Rate / hour
        <input
          inputMode="decimal"
          placeholder="0"
          value={draft.rate}
          disabled={draft.personal}
          onChange={(e) => set({ rate: e.target.value })}
        />
        <CurrencyInput value={draft.currency} onChange={(currency) => set({ currency })} />
      </label>
      <label className="client-check">
        <input
          type="checkbox"
          checked={draft.personal}
          onChange={(e) => set({ personal: e.target.checked })}
        />
        My own project (not billed)
      </label>
      <div className="client-colors" role="radiogroup" aria-label="Color">
        {PALETTE.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={draft.color === c}
            className={draft.color === c ? "swatch active" : "swatch"}
            style={{ background: c }}
            onClick={() => set({ color: c })}
          />
        ))}
      </div>
      <div className="client-form-actions">
        <button className="btn primary sm" disabled={busy || !draft.name.trim()}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn ghost sm" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

export function Clients() {
  const [clients, setClients] = useState<Client[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editId, setEditId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(emptyDraft);
  const [toDelete, setToDelete] = useState<Client | null>(null);

  const load = useCallback(async () => {
    try {
      setClients((await api.listClients()).clients);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load clients");
    }
  }, []);
  useEffect(() => void load(), [load]);
  useLive(() => void load());

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function toBody(d: Draft) {
    const currency = d.currency.trim().toUpperCase();
    return {
      name: d.name.trim(),
      color: d.color,
      is_personal: d.personal,
      currency,
      rate_minor: d.personal ? null : parseMoneyToMinor(d.rate, currency),
    };
  }

  function startEdit(c: Client) {
    setEditId(c.id);
    setEditDraft({
      name: c.name,
      rate: minorToInput(c.rate_minor, c.currency),
      currency: c.currency,
      personal: c.is_personal,
      color: c.color ?? PALETTE[0],
    });
  }

  return (
    <div className="settings-card">
      <h3>Clients</h3>
      <p className="muted">
        Group boards by customer to track time and earnings separately. Assign a board to a client from the
        board toolbar. Your own project can be marked as not billed. Changing a rate only affects time you
        track afterwards.
      </p>

      {error && <div className="auth-error">{error}</div>}

      {clients === null ? (
        <div className="spinner" />
      ) : clients.length === 0 ? (
        <div className="muted">No clients yet.</div>
      ) : (
        <ul className="client-list">
          {clients.map((c) =>
            editId === c.id ? (
              <li key={c.id} className="client-item editing">
                <ClientForm
                  draft={editDraft}
                  setDraft={setEditDraft}
                  busy={busy}
                  submitLabel="Save"
                  onCancel={() => setEditId(null)}
                  onSubmit={() =>
                    void run(() => api.updateClient(c.id, toBody(editDraft))).then(
                      (ok) => ok && setEditId(null),
                    )
                  }
                />
              </li>
            ) : (
              <li key={c.id} className={c.archived_at ? "client-item archived" : "client-item"}>
                <span className="client-dot" style={{ background: c.color ?? "var(--border)" }} />
                <div className="client-main">
                  <strong>{c.name}</strong>
                  <span className="muted small">
                    {c.is_personal
                      ? "Own project"
                      : c.rate_minor !== null
                        ? `${formatMoney(c.rate_minor, c.currency)} / h`
                        : "No rate"}
                    {" · "}
                    {c.board_count ?? 0} {c.board_count === 1 ? "board" : "boards"}
                    {c.archived_at ? " · archived" : ""}
                  </span>
                </div>
                <div className="client-actions">
                  <button className="btn ghost sm" onClick={() => startEdit(c)}>
                    Edit
                  </button>
                  <button
                    className="btn ghost sm"
                    disabled={busy}
                    onClick={() => void run(() => api.updateClient(c.id, { archived: !c.archived_at }))}
                  >
                    {c.archived_at ? "Restore" : "Archive"}
                  </button>
                  <button className="btn danger sm" disabled={busy} onClick={() => setToDelete(c)}>
                    Delete
                  </button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}

      <div className="settings-form">
        <h4>Add client</h4>
        <ClientForm
          draft={draft}
          setDraft={setDraft}
          busy={busy}
          submitLabel="Add client"
          onSubmit={() =>
            void run(() => api.createClient(toBody(draft))).then((ok) => ok && setDraft(emptyDraft()))
          }
        />
      </div>

      {toDelete && (
        <ConfirmModal
          title="Delete client"
          message={`Delete client "${toDelete.name}"? Its boards and tracked time stay, they just no longer belong to a client. Archive it instead to hide it from the picker.`}
          onCancel={() => setToDelete(null)}
          onConfirm={() => {
            const c = toDelete;
            setToDelete(null);
            void run(() => api.deleteClient(c.id));
          }}
        />
      )}
    </div>
  );
}
