import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { ColumnWithTasks, Task } from "../../shared/types.ts";
import { TaskCard } from "./TaskCard.tsx";

interface Props {
  column: ColumnWithTasks;
  nowMs: number;
  busy: boolean;
  onAddTask: (columnId: string) => void;
  onRenameColumn: (column: ColumnWithTasks) => void;
  onDeleteColumn: (column: ColumnWithTasks) => void;
  onStart: (task: Task) => void;
  onStop: (task: Task) => void;
  onEdit: (task: Task) => void;
  onDelete: (task: Task) => void;
  onHistory: (task: Task) => void;
}

export function ColumnView({
  column,
  nowMs,
  busy,
  onAddTask,
  onRenameColumn,
  onDeleteColumn,
  onStart,
  onStop,
  onEdit,
  onDelete,
  onHistory,
}: Props) {
  // Droppable so an empty column still accepts drops.
  const { setNodeRef, isOver } = useDroppable({ id: column.id });

  const columnSeconds = column.tasks.reduce(
    (sum, t) => sum + t.total_seconds,
    0,
  );

  return (
    <section className="column">
      <div className="column-head">
        <div className="column-title" onClick={() => onRenameColumn(column)}>
          {column.name}
          <span className="column-count">{column.tasks.length}</span>
        </div>
        <button
          className="icon-btn danger"
          title="Delete column"
          onClick={() => onDeleteColumn(column)}
        >
          🗑
        </button>
      </div>

      <SortableContext
        items={column.tasks.map((t) => t.id)}
        strategy={verticalListSortingStrategy}
      >
        <div
          ref={setNodeRef}
          className={isOver ? "column-body over" : "column-body"}
        >
          {column.tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              nowMs={nowMs}
              busy={busy}
              onStart={onStart}
              onStop={onStop}
              onEdit={onEdit}
              onDelete={onDelete}
              onHistory={onHistory}
            />
          ))}
          {column.tasks.length === 0 && (
            <div className="column-empty">Drop tasks here</div>
          )}
        </div>
      </SortableContext>

      <button className="add-task" onClick={() => onAddTask(column.id)}>
        + Add task
      </button>
      {columnSeconds > 0 && (
        <div className="column-foot">{Math.round(columnSeconds / 36) / 100}h logged</div>
      )}
    </section>
  );
}
