import { useEffect, useRef, useState, type FormEvent } from "react";
import { Modal } from "./Modal.tsx";

interface Props {
  title: string;
  label: string;
  submitLabel: string;
  initial?: string;
  placeholder?: string;
  maxLength?: number;
  onCancel: () => void;
  /** Resolve to close the dialog; throw to show the message inside it. */
  onSubmit: (value: string) => Promise<void>;
}

/** In-app replacement for window.prompt() - one text field, Enter to save. */
export function InputModal({
  title,
  label,
  submitLabel,
  initial = "",
  placeholder,
  maxLength = 100,
  onCancel,
  onSubmit,
}: Props) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const trimmed = value.trim();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      onCancel();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onCancel}>
      <form onSubmit={submit}>
        <label className="field">
          <span>{label}</span>
          <input
            ref={inputRef}
            value={value}
            placeholder={placeholder}
            maxLength={maxLength}
            onChange={(e) => setValue(e.target.value)}
          />
          <small className="field-hint">
            {value.length}/{maxLength}
          </small>
        </label>
        {error && <div className="auth-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || !trimmed}>
            {busy ? "Saving…" : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
