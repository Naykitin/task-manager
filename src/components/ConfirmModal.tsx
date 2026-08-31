import { Modal } from "./Modal.tsx";

interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Replaces window.confirm() with an in-app modal — a native confirm()
 * blocks the whole tab's main thread until dismissed, which is disruptive
 * and (for browser-automation tooling) can hang the page entirely. */
export function ConfirmModal({
  title,
  message,
  confirmLabel = "Delete",
  danger = true,
  onCancel,
  onConfirm,
}: Props) {
  return (
    <Modal title={title} onClose={onCancel}>
      <p className="confirm-message">{message}</p>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className={danger ? "btn danger" : "btn primary"}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
