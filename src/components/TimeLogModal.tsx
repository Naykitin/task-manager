import { useEffect, useState } from "react";
import type { Task, TimeEntry } from "../../shared/types.ts";
import { api } from "../api.ts";
import {
  formatDateTime,
  formatDuration,
  elapsedSince,
  toDatetimeLocal,
  fromDatetimeLocal,
} from "../format.ts";
import { Modal } from "./Modal.tsx";

function defaultAddRange(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 60_000);
  return { start: toDatetimeLocal(start.toISOString()), end: toDatetimeLocal(end.toISOString()) };
}

export function TimeLogModal({
  task,
  onClose,
  onChange,
}: {
  task: Task;
  onClose: () => void;
  onChange?: () => void;
}) {
  const [entries, setEntries] = useState<TimeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [addRange, setAddRange] = useState(defaultAddRange);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editStart, setEditStart] = useState("");
  const [editEnd, setEditEnd] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = () =>
    api
      .timeEntries(task.id)
      .then(({ entries }) => setEntries(entries))
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Failed to load"),
      );

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  const completedTotal =
    entries?.reduce((s, e) => s + (e.duration_seconds ?? 0), 0) ?? 0;

  async function afterMutate() {
    await load();
    onChange?.();
  }

  async function submitAdd(e: React.FormEvent) {
    e.preventDefault();
    setAddBusy(true);
    setAddError(null);
    try {
      await api.addTimeEntry(
        task.id,
        fromDatetimeLocal(addRange.start),
        fromDatetimeLocal(addRange.end),
      );
      setAdding(false);
      await afterMutate();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Failed to add entry");
    } finally {
      setAddBusy(false);
    }
  }

  function startEdit(entry: TimeEntry) {
    setEditingId(entry.id);
    setEditStart(toDatetimeLocal(entry.started_at));
    setEditEnd(entry.ended_at ? toDatetimeLocal(entry.ended_at) : "");
    setEditError(null);
  }

  async function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingId) return;
    setEditBusy(true);
    setEditError(null);
    try {
      const patch: { started_at?: string; ended_at?: string } = {
        started_at: fromDatetimeLocal(editStart),
      };
      if (editEnd.trim()) patch.ended_at = fromDatetimeLocal(editEnd);
      await api.updateTimeEntry(editingId, patch);
      setEditingId(null);
      await afterMutate();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setEditBusy(false);
    }
  }

  async function onDelete(entry: TimeEntry) {
    if (
      !confirm(
        `Delete this time entry (${formatDateTime(entry.started_at)})? This cannot be undone.`,
      )
    )
      return;
    setDeletingId(entry.id);
    setError(null);
    try {
      await api.deleteTimeEntry(entry.id);
      await afterMutate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Modal title={`Time log — ${task.title}`} onClose={onClose}>
      {error && <div className="auth-error">{error}</div>}
      {!entries ? (
        <div className="muted">Loading…</div>
      ) : (
        <>
          <div className="log-total">
            Total tracked: <strong>{formatDuration(completedTotal)}</strong>
          </div>
          {entries.length === 0 ? (
            <div className="empty-block">No time tracked yet.</div>
          ) : (
            <table className="log-table">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Ended</th>
                  <th className="num">Duration</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) =>
                  editingId === entry.id ? (
                    <tr key={entry.id}>
                      <td colSpan={4}>
                        <form className="log-edit-row" onSubmit={submitEdit}>
                          <input
                            type="datetime-local"
                            value={editStart}
                            onChange={(e) => setEditStart(e.target.value)}
                            required
                          />
                          <input
                            type="datetime-local"
                            value={editEnd}
                            placeholder="still running"
                            onChange={(e) => setEditEnd(e.target.value)}
                          />
                          <button
                            type="submit"
                            className="btn primary sm"
                            disabled={editBusy}
                          >
                            {editBusy ? "Saving…" : "Save"}
                          </button>
                          <button
                            type="button"
                            className="btn ghost sm"
                            onClick={() => setEditingId(null)}
                          >
                            Cancel
                          </button>
                          {editError && (
                            <div className="auth-error">{editError}</div>
                          )}
                        </form>
                      </td>
                    </tr>
                  ) : (
                    <tr key={entry.id}>
                      <td>{formatDateTime(entry.started_at)}</td>
                      <td>
                        {entry.ended_at ? (
                          formatDateTime(entry.ended_at)
                        ) : (
                          <span className="running-tag">running</span>
                        )}
                      </td>
                      <td className="num">
                        {entry.ended_at
                          ? formatDuration(entry.duration_seconds ?? 0)
                          : formatDuration(elapsedSince(entry.started_at))}
                      </td>
                      <td className="log-row-actions">
                        <button
                          className="icon-btn"
                          title="Edit"
                          onClick={() => startEdit(entry)}
                        >
                          ✎
                        </button>
                        <button
                          className="icon-btn"
                          title="Delete"
                          disabled={deletingId === entry.id}
                          onClick={() => onDelete(entry)}
                        >
                          🗑
                        </button>
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          )}
        </>
      )}

      {adding ? (
        <form className="log-add-row" onSubmit={submitAdd}>
          <label className="field">
            <span>Started</span>
            <input
              type="datetime-local"
              value={addRange.start}
              onChange={(e) =>
                setAddRange((r) => ({ ...r, start: e.target.value }))
              }
              required
            />
          </label>
          <label className="field">
            <span>Ended</span>
            <input
              type="datetime-local"
              value={addRange.end}
              onChange={(e) =>
                setAddRange((r) => ({ ...r, end: e.target.value }))
              }
              required
            />
          </label>
          {addError && <div className="auth-error">{addError}</div>}
          <div className="modal-actions">
            <button
              type="button"
              className="btn ghost"
              onClick={() => setAdding(false)}
            >
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={addBusy}>
              {addBusy ? "Adding…" : "Add entry"}
            </button>
          </div>
        </form>
      ) : (
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => setAdding(true)}>
            + Add time manually
          </button>
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
      )}
    </Modal>
  );
}
