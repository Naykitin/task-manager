import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Task, TaskLinkView } from "../../shared/types.ts";
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
  onNavigateToTask: (taskId: string) => void;
}

/** Prefix text for one link row, per relation_type + direction. */
function linkPrefix(link: TaskLinkView): string {
  if (link.relation_type === "blocks") {
    return link.direction === "outgoing" ? "🔗 blocks:" : "⚠ blocked by:";
  }
  if (link.relation_type === "related") return "🔁 related:";
  return "duplicate of:";
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
  onNavigateToTask,
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

      {task.links.length > 0 && (
        <ul className="card-links">
          {task.links.map((link, i) => (
            <li key={i} className="card-link-row">
              <span className="card-link-prefix">{linkPrefix(link)}</span>{" "}
              <button
                type="button"
                className="card-link-title"
                onClick={() => onNavigateToTask(link.task_id)}
              >
                {link.title}
              </button>
            </li>
          ))}
        </ul>
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
