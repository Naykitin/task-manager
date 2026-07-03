import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Task } from "../../shared/types.ts";
import { formatClock, formatDuration } from "../format.ts";

interface Props {
  task: Task;
  nowMs: number;
  busy: boolean;
  onStart: (task: Task) => void;
  onStop: (task: Task) => void;
  onEdit: (task: Task) => void;
  onDelete: (task: Task) => void;
  onHistory: (task: Task) => void;
}

export function TaskCard({
  task,
  nowMs,
  busy,
  onStart,
  onStop,
  onEdit,
  onDelete,
  onHistory,
}: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: task.id });

  const running = task.running_entry != null;
  const liveExtra = running
    ? Math.max(0, Math.floor((nowMs - new Date(task.running_entry!.started_at).getTime()) / 1000))
    : 0;
  const displayTotal = task.total_seconds + liveExtra;

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={running ? "card running" : "card"}
    >
      <div className="card-head">
        <button
          className="drag-handle"
          aria-label="Drag task"
          {...attributes}
          {...listeners}
        >
          ⠿
        </button>
        <div className="card-title" onClick={() => onEdit(task)}>
          {task.title}
        </div>
      </div>

      {task.description && (
        <div className="card-desc">{task.description}</div>
      )}

      <div className="card-time">
        <span className={running ? "time-value live" : "time-value"}>
          {running ? formatClock(displayTotal) : formatDuration(displayTotal)}
        </span>
        {running && <span className="rec-dot" aria-label="recording" />}
      </div>

      <div className="card-actions">
        {running ? (
          <button
            className="btn danger sm"
            disabled={busy}
            onClick={() => onStop(task)}
          >
            ■ Stop
          </button>
        ) : (
          <button
            className="btn accent sm"
            disabled={busy}
            onClick={() => onStart(task)}
          >
            ▶ Start
          </button>
        )}
        <div className="card-actions-right">
          <button className="icon-btn" title="Time log" onClick={() => onHistory(task)}>
            🕑
          </button>
          <button className="icon-btn" title="Edit" onClick={() => onEdit(task)}>
            ✎
          </button>
          <button
            className="icon-btn danger"
            title="Delete"
            onClick={() => onDelete(task)}
          >
            🗑
          </button>
        </div>
      </div>
    </div>
  );
}
