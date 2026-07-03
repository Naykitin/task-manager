import { useEffect, useState } from "react";
import type { Task, TimeEntry } from "../../shared/types.ts";
import { api } from "../api.ts";
import { formatDateTime, formatDuration, elapsedSince } from "../format.ts";
import { Modal } from "./Modal.tsx";

export function TimeLogModal({
  task,
  onClose,
}: {
  task: Task;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<TimeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .timeEntries(task.id)
      .then(({ entries }) => setEntries(entries))
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Failed to load"),
      );
  }, [task.id]);

  const completedTotal =
    entries?.reduce((s, e) => s + (e.duration_seconds ?? 0), 0) ?? 0;

  return (
    <Modal title={`Time log — ${task.title}`} onClose={onClose}>
      {error && <div className="auth-error">{error}</div>}
      {!entries ? (
        <div className="muted">Loading…</div>
      ) : entries.length === 0 ? (
        <div className="empty-block">No time tracked yet.</div>
      ) : (
        <>
          <div className="log-total">
            Total tracked: <strong>{formatDuration(completedTotal)}</strong>
          </div>
          <table className="log-table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Ended</th>
                <th className="num">Duration</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>{formatDateTime(e.started_at)}</td>
                  <td>
                    {e.ended_at ? (
                      formatDateTime(e.ended_at)
                    ) : (
                      <span className="running-tag">running</span>
                    )}
                  </td>
                  <td className="num">
                    {e.ended_at
                      ? formatDuration(e.duration_seconds ?? 0)
                      : formatDuration(elapsedSince(e.started_at))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
