import { useState } from "react";
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
  pomodoroEnabled: boolean;
  onPomodoro: (task: Task) => void;
  onEdit: (task: Task) => void;
  onDelete: (task: Task) => void;
  onHistory: (task: Task) => void;
  onNavigateToTask: (taskId: string) => void;
  onToggleChecklist: (taskId: string, itemId: string, done: boolean) => void;
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
  pomodoroEnabled,
  onPomodoro,
  onEdit,
  onDelete,
  onHistory,
  onNavigateToTask,
  onToggleChecklist,
}: Props) {
  const [stepsOpen, setStepsOpen] = useState(false);
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

      {task.checklist.length > 0 && (
        <div className="card-checklist">
          <button
            type="button"
            className="checklist-badge"
            aria-expanded={stepsOpen}
            onClick={() => setStepsOpen((v) => !v)}
          >
            <span>
              {stepsOpen ? "▾" : "▸"} ☑ {task.checklist.filter((i) => i.done).length}/
              {task.checklist.length}
            </span>
            <span className="checklist-bar">
              <span
                style={{
                  width: `${Math.round(
                    (task.checklist.filter((i) => i.done).length / task.checklist.length) * 100,
                  )}%`,
                }}
              />
            </span>
          </button>
          {stepsOpen && (
            <ul className="checklist-list">
              {task.checklist.map((item) => (
                <li key={item.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={item.done}
                      onChange={(e) => onToggleChecklist(task.id, item.id, e.target.checked)}
                    />
                    <span className={item.done ? "done" : undefined}>{item.text}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
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
        {(task.pomodoro_count ?? 0) > 0 && (
          <span className="pomo-count" title="Completed Pomodoro focus intervals">
            🍅 {task.pomodoro_count}
          </span>
        )}
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
        {pomodoroEnabled && !running && (
          <button
            className="btn ghost sm"
            disabled={busy}
            title="Start a Pomodoro focus interval"
            onClick={() => onPomodoro(task)}
          >
            🍅
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
