import { useState, type KeyboardEvent } from "react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

export interface StepItem {
  id: string;
  text: string;
  done: boolean;
}

interface Props {
  items: StepItem[];
  onAdd: (text: string) => void;
  onToggle: (id: string, done: boolean) => void;
  onRename: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  onReorder: (ids: string[]) => void;
}

const MAX_ITEMS = 100;

function Row({
  item,
  onToggle,
  onRename,
  onDelete,
}: {
  item: StepItem;
  onToggle: Props["onToggle"];
  onRename: Props["onRename"];
  onDelete: Props["onDelete"];
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);

  function commit() {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== item.text) onRename(item.id, next);
    else setDraft(item.text);
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      setDraft(item.text);
      setEditing(false);
    }
  }

  return (
    <li
      ref={setNodeRef}
      className="step-row"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        className="step-grip"
        aria-label="Reorder step"
        {...attributes}
        {...listeners}
      >
        ⠿
      </button>
      <input
        type="checkbox"
        checked={item.done}
        aria-label={`Mark "${item.text}" as done`}
        onChange={(e) => onToggle(item.id, e.target.checked)}
      />
      {editing ? (
        <input
          className="step-edit"
          autoFocus
          value={draft}
          maxLength={500}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={onKey}
        />
      ) : (
        <span
          className={item.done ? "step-text done" : "step-text"}
          title="Click to edit"
          onClick={() => {
            setDraft(item.text);
            setEditing(true);
          }}
        >
          {item.text}
        </span>
      )}
      <button
        type="button"
        className="icon-btn danger"
        title="Delete step"
        onClick={() => onDelete(item.id)}
      >
        ✕
      </button>
    </li>
  );
}

export function ChecklistEditor({ items, onAdd, onToggle, onRename, onDelete, onReorder }: Props) {
  const [text, setText] = useState("");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const done = items.filter((i) => i.done).length;

  function add() {
    const t = text.trim();
    if (!t || items.length >= MAX_ITEMS) return;
    onAdd(t);
    setText("");
  }

  function onDragEnd(e: DragEndEvent) {
    if (!e.over || e.active.id === e.over.id) return;
    const from = items.findIndex((i) => i.id === e.active.id);
    const to = items.findIndex((i) => i.id === e.over!.id);
    if (from < 0 || to < 0) return;
    onReorder(arrayMove(items, from, to).map((i) => i.id));
  }

  return (
    <div className="field steps">
      <span>
        Steps{items.length > 0 && ` (${done}/${items.length})`}
      </span>
      {items.length > 0 && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
            <ul className="step-list">
              {items.map((item) => (
                <Row
                  key={item.id}
                  item={item}
                  onToggle={onToggle}
                  onRename={onRename}
                  onDelete={onDelete}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
      <div className="step-add">
        <input
          value={text}
          maxLength={500}
          placeholder="Add a step and press Enter"
          disabled={items.length >= MAX_ITEMS}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="btn ghost sm" disabled={!text.trim()} onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
}
