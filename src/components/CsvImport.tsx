import { useState } from "react";
import { api, type ImportResult } from "../api.ts";
import { Modal } from "./Modal.tsx";

interface Props {
  className?: string;
  label?: string;
  /** Called after entries were actually imported. */
  onImported?: () => void;
}

type Stage =
  | { kind: "preview"; csv: string; result: ImportResult }
  | { kind: "error"; message: string }
  | { kind: "done"; message: string }
  | null;

/** "Import CSV" button + a confirmation dialog (dry-run preview, then import). */
export function CsvImport({ className = "btn accent sm", label = "⬆ Import CSV", onImported }: Props) {
  const [stage, setStage] = useState<Stage>(null);
  const [busy, setBusy] = useState(false);

  async function onPick(file: File | undefined) {
    if (!file) return;
    try {
      const csv = await file.text();
      setStage({ kind: "preview", csv, result: await api.importTimeEntries(csv, true) });
    } catch (err) {
      setStage({ kind: "error", message: err instanceof Error ? err.message : "Could not read CSV" });
    }
  }

  async function confirm() {
    if (stage?.kind !== "preview") return;
    setBusy(true);
    try {
      const res = await api.importTimeEntries(stage.csv, false);
      setStage({
        kind: "done",
        message: `Imported ${res.imported} entries (${res.skipped_duplicates} duplicates skipped, ${res.created_boards} boards and ${res.created_tasks} tasks created).`,
      });
      onImported?.();
    } catch (err) {
      setStage({ kind: "error", message: err instanceof Error ? err.message : "Import failed" });
    } finally {
      setBusy(false);
    }
  }

  const close = () => setStage(null);

  return (
    <>
      <label className={className}>
        {label}
        <input
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={(e) => {
            void onPick(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </label>

      {stage && (
        <Modal title="Import time entries" onClose={close}>
          {stage.kind === "preview" && (
            <>
              <p className="muted">
                {stage.result.format === "full"
                  ? "Full backup detected - entries are restored exactly."
                  : "Timesheet report detected - approximate: one entry per day and task, placed at 09:00."}
              </p>
              <p>
                {stage.result.rows} rows: <b>{stage.result.imported}</b> new entries,{" "}
                {stage.result.skipped_duplicates} already exist, {stage.result.invalid} invalid. Will
                create {stage.result.created_boards} boards and {stage.result.created_tasks} tasks.
              </p>
              {stage.result.problems.length > 0 && (
                <ul className="muted">
                  {stage.result.problems.map((p) => (
                    <li key={p.line}>
                      line {p.line}: {p.reason}
                    </li>
                  ))}
                </ul>
              )}
              <div className="modal-actions">
                <button className="btn ghost" onClick={close} disabled={busy}>
                  Cancel
                </button>
                <button
                  className="btn primary"
                  onClick={confirm}
                  disabled={busy || stage.result.imported + stage.result.created_tasks === 0}
                >
                  {busy ? "Importing…" : "Import"}
                </button>
              </div>
            </>
          )}
          {stage.kind === "error" && (
            <>
              <div className="auth-error">{stage.message}</div>
              <div className="modal-actions">
                <button className="btn primary" onClick={close}>
                  Close
                </button>
              </div>
            </>
          )}
          {stage.kind === "done" && (
            <>
              <p>{stage.message}</p>
              <div className="modal-actions">
                <button className="btn primary" onClick={close}>
                  Done
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </>
  );
}
