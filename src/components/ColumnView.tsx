import { useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { ColumnWithTasks, Task } from "../../shared/types.ts";
import { TaskCard } from "./TaskCard.tsx";

export const COLUMN_PREFIX = "col:";
export const columnSortId = (id: string) => COLUMN_PREFIX + id;

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
  onNavigateToTask: (taskId: string) => void;
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
  onNavigateToTask,
}: Props) {
  // Droppable so an empty column still accepts task drops (raw column id).
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  // The whole column is sortable under a prefixed id so it never collides with
  // the task drop zone above; dragging starts only from the grip handle.
  const {
    attributes,
    listeners,
    setNodeRef: setColumnRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: columnSortId(column.id), data: { type: "column" } });

  const columnSeconds = column.tasks.reduce(
    (sum, t) => sum + t.total_seconds,
    0,
  );

  return (
    <section
      ref={setColumnRef}
      className="column"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
    >
      <div className="column-head">
        <button
          ref={setActivatorNodeRef}
          className="column-grip"
          title="Drag to reorder column"
          aria-label={`Reorder column ${column.name}`}
          {...attributes}
          {...listeners}
        >
          {"\u283F"}
        </button>
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
              onNavigateToTask={onNavigateToTask}
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
