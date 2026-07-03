import { useState, type FormEvent } from "react";
import type { Task } from "../../shared/types.ts";
import { Modal } from "./Modal.tsx";

interface Props {
  mode: "create" | "edit";
  initial?: Task;
  onCancel: () => void;
  onSubmit: (values: { title: string; description: string }) => Promise<void>;
}

export function TaskModal({ mode, initial, onCancel, onSubmit }: Props) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      setError("Title is required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ title: title.trim(), description: description.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
      setBusy(false);
    }
  }

  return (
    <Modal
      title={mode === "create" ? "New task" : "Edit task"}
      onClose={onCancel}
    >
      <form onSubmit={submit}>
        <label className="field">
          <span>Title</span>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={500}
          />
        </label>
        <label className="field">
          <span>Description</span>
          <textarea
            value={description}
            rows={4}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        {error && <div className="auth-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? "Saving…" : mode === "create" ? "Create" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
