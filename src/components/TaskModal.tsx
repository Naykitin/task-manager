import { useRef, useState, type FormEvent } from "react";
import type { Task } from "../../shared/types.ts";
import { api } from "../api.ts";
import { ChecklistEditor, type StepItem } from "./ChecklistEditor.tsx";
import { Modal } from "./Modal.tsx";

interface Props {
  mode: "create" | "edit";
  initial?: Task;
  onCancel: () => void;
  /** `steps` is only used when creating; in edit mode steps save immediately. */
  onSubmit: (values: { title: string; description: string; steps: string[] }) => Promise<void>;
  /** Called after a step was added/changed/removed on an existing task. */
  onChecklistChanged?: () => void;
}

export function TaskModal({ mode, initial, onCancel, onSubmit, onChecklistChanged }: Props) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<StepItem[]>(
    () => initial?.checklist.map(({ id, text, done }) => ({ id, text, done })) ?? [],
  );
  const tmp = useRef(0);
  const taskId = mode === "edit" ? initial?.id : undefined;

  // Existing task: every change is saved right away (optimistic, rolled back on error).
  async function persist(next: StepItem[], call: () => Promise<unknown>) {
    const prev = steps;
    setSteps(next);
    try {
      await call();
      onChecklistChanged?.();
    } catch (err) {
      setSteps(prev);
      setError(err instanceof Error ? err.message : "Failed to save step");
    }
  }

  const stepOps = {
    onAdd: async (text: string) => {
      if (!taskId) {
        setSteps((s) => [...s, { id: `tmp-${++tmp.current}`, text, done: false }]);
        return;
      }
      try {
        const { items } = await api.addChecklistItems(taskId, [text]);
        setSteps((s) => [...s, ...items.map(({ id, text, done }) => ({ id, text, done }))]);
        onChecklistChanged?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to add step");
      }
    },
    onToggle: (id: string, done: boolean) => {
      const next = steps.map((s) => (s.id === id ? { ...s, done } : s));
      if (!taskId) return setSteps(next);
      void persist(next, () => api.updateChecklistItem(id, { done }));
    },
    onRename: (id: string, text: string) => {
      const next = steps.map((s) => (s.id === id ? { ...s, text } : s));
      if (!taskId) return setSteps(next);
      void persist(next, () => api.updateChecklistItem(id, { text }));
    },
    onDelete: (id: string) => {
      const next = steps.filter((s) => s.id !== id);
      if (!taskId) return setSteps(next);
      void persist(next, () => api.deleteChecklistItem(id));
    },
    onReorder: (ids: string[]) => {
      const next = ids.map((id) => steps.find((s) => s.id === id)!);
      if (!taskId) return setSteps(next);
      void persist(next, () => api.reorderChecklist(taskId, ids));
    },
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      setError("Title is required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        title: title.trim(),
        description: description.trim(),
        steps: taskId ? [] : steps.map((s) => s.text),
      });
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
        <ChecklistEditor items={steps} {...stepOps} />
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
