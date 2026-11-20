import { useCallback, useEffect, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  closestCorners,
  type CollisionDetection,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import type { Board, ColumnWithTasks, Task } from "../../shared/types.ts";
import { api } from "../api.ts";
import { formatDuration } from "../format.ts";
import { COLUMN_PREFIX, ColumnView, columnSortId } from "./ColumnView.tsx";
import { ConfirmModal } from "./ConfirmModal.tsx";
import { InputModal } from "./InputModal.tsx";
import { TaskModal } from "./TaskModal.tsx";
import { TimeLogModal } from "./TimeLogModal.tsx";
import { VoiceInbox } from "./VoiceInbox.tsx";

const LAST_BOARD_KEY = "tm_last_board_id";

function findContainerId(
  columns: ColumnWithTasks[],
  id: string,
): string | undefined {
  if (columns.some((c) => c.id === id)) return id;
  return columns.find((c) => c.tasks.some((t) => t.id === id))?.id;
}

const isColumnId = (id: string) => id.startsWith(COLUMN_PREFIX);

// Columns and tasks share one DndContext; only compare like with like.
const collisionDetection: CollisionDetection = (args) => {
  const dragColumn = isColumnId(String(args.active.id));
  return closestCorners({
    ...args,
    droppableContainers: args.droppableContainers.filter(
      (c) => isColumnId(String(c.id)) === dragColumn,
    ),
  });
};

export function BoardView() {
  const [boards, setBoards] = useState<Board[]>([]);
  const [currentBoardId, setCurrentBoardId] = useState<string | null>(null);
  const [columns, setColumnsState] = useState<ColumnWithTasks[]>([]);
  const columnsRef = useRef<ColumnWithTasks[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeTask, setActiveTask] = useState<Task | null>(null);

  const [modal, setModal] = useState<
    | { mode: "create"; columnId: string }
    | { mode: "edit"; task: Task }
    | null
  >(null);
  const [historyTask, setHistoryTask] = useState<Task | null>(null);
  const [voiceOpen, setVoiceOpen] = useState(false);
  // Voice Inbox is feature-flagged server-side (VOICE_INBOX_ENABLED); hidden unless available.
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  useEffect(() => {
    api
      .getVoiceAvailability()
      .then(({ available }) => setVoiceAvailable(available))
      .catch(() => setVoiceAvailable(false));
  }, []);
  const [confirmModal, setConfirmModal] = useState<
    { title: string; message: string; onConfirm: () => void } | null
  >(null);
  const closeConfirm = () => setConfirmModal(null);
  const [inputModal, setInputModal] = useState<
    | {
        title: string;
        label: string;
        submitLabel: string;
        initial?: string;
        onSubmit: (value: string) => Promise<void>;
      }
    | null
  >(null);

  const setColumns = useCallback((next: ColumnWithTasks[]) => {
    columnsRef.current = next;
    setColumnsState(next);
  }, []);

  // Live ticker only runs while some task has a running timer.
  const hasRunning = columns.some((c) => c.tasks.some((t) => t.running_entry));
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!hasRunning) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasRunning]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const loadBoard = useCallback(
    async (boardId: string) => {
      const { board } = await api.getBoard(boardId);
      setColumns(board.columns);
    },
    [setColumns],
  );

  const reload = useCallback(async () => {
    if (currentBoardId) await loadBoard(currentBoardId);
  }, [currentBoardId, loadBoard]);

  // Initial boards load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { boards } = await api.listBoards();
        if (cancelled) return;
        setBoards(boards);
        const savedId = localStorage.getItem(LAST_BOARD_KEY);
        const target = boards.find((b) => b.id === savedId) ?? boards[0];
        if (target) {
          setCurrentBoardId(target.id);
          await loadBoard(target.id);
        }
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load boards");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadBoard]);

  async function switchBoard(boardId: string) {
    setCurrentBoardId(boardId);
    localStorage.setItem(LAST_BOARD_KEY, boardId);
    setLoading(true);
    try {
      await loadBoard(boardId);
    } finally {
      setLoading(false);
    }
  }

  async function withBusy<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  // ---- Timer ----
  const onStart = (task: Task) =>
    withBusy(async () => {
      await api.startTimer(task.id);
      await reload();
    });
  const onStop = (task: Task) =>
    withBusy(async () => {
      await api.stopTimer(task.id);
      await reload();
    });

  // ---- Task CRUD ----
  async function submitTask(values: { title: string; description: string }) {
    if (!modal) return;
    if (modal.mode === "create") {
      await api.createTask(modal.columnId, values.title, values.description);
    } else {
      await api.updateTask(modal.task.id, values);
    }
    setModal(null);
    await reload();
  }

  const onDeleteTask = (task: Task) => {
    setConfirmModal({
      title: "Delete task",
      message: `Delete task "${task.title}"?`,
      onConfirm: () => {
        closeConfirm();
        withBusy(async () => {
          await api.deleteTask(task.id);
          await reload();
        });
      },
    });
  };

  // Clicking a linked task's title "navigates" to it the same way the
  // existing card-title click does: open its edit modal. No separate
  // route/highlight mechanism exists in this app to reuse instead.
  const onNavigateToTask = (taskId: string) => {
    for (const c of columns) {
      const task = c.tasks.find((t) => t.id === taskId);
      if (task) {
        setModal({ mode: "edit", task });
        return;
      }
    }
  };

  // ---- Columns ----
  const onAddColumn = () => {
    const boardId = currentBoardId;
    if (!boardId) return;
    setInputModal({
      title: "New column",
      label: "Column name",
      submitLabel: "Create",
      onSubmit: async (name) => {
        await api.createColumn(boardId, name);
        await reload();
      },
    });
  };

  const onRenameColumn = (column: ColumnWithTasks) =>
    setInputModal({
      title: "Rename column",
      label: "Column name",
      submitLabel: "Save",
      initial: column.name,
      onSubmit: async (name) => {
        if (name === column.name) return;
        await api.updateColumn(column.id, { name });
        await reload();
      },
    });

  const onDeleteColumn = (column: ColumnWithTasks) => {
    setConfirmModal({
      title: "Delete column",
      message: `Delete column "${column.name}" and its ${column.tasks.length} task(s)?`,
      onConfirm: () => {
        closeConfirm();
        withBusy(async () => {
          await api.deleteColumn(column.id);
          await reload();
        });
      },
    });
  };

  const onAddBoard = () =>
    setInputModal({
      title: "New board",
      label: "Board name",
      submitLabel: "Create",
      onSubmit: async (name) => {
        const { board } = await api.createBoard(name);
        setBoards((b) => [...b, board]);
        await switchBoard(board.id);
      },
    });

  const onRenameBoard = () => {
    const board = boards.find((b) => b.id === currentBoardId);
    if (!board) return;
    setInputModal({
      title: "Rename board",
      label: "Board name",
      submitLabel: "Save",
      initial: board.name,
      onSubmit: async (name) => {
        if (name === board.name) return;
        const { board: updated } = await api.updateBoard(board.id, { name });
        setBoards((bs) => bs.map((b) => (b.id === updated.id ? updated : b)));
      },
    });
  };

  const onDeleteBoard = () => {
    const board = boards.find((b) => b.id === currentBoardId);
    if (!board) return;
    setConfirmModal({
      title: "Delete board",
      message: `Delete board "${board.name}" and all of its columns, tasks, and time entries? This cannot be undone.`,
      onConfirm: () => {
        closeConfirm();
        withBusy(async () => {
          await api.deleteBoard(board.id);
          const remaining = boards.filter((b) => b.id !== board.id);
          setBoards(remaining);
          if (remaining[0]) {
            await switchBoard(remaining[0].id);
          } else {
            setCurrentBoardId(null);
            localStorage.removeItem(LAST_BOARD_KEY);
            setColumns([]);
          }
        });
      },
    });
  };

  // ---- Drag and drop ----
  function onDragStart(event: DragStartEvent) {
    const id = String(event.active.id);
    if (isColumnId(id)) return;
    for (const c of columnsRef.current) {
      const t = c.tasks.find((x) => x.id === id);
      if (t) {
        setActiveTask(t);
        return;
      }
    }
  }

  function onDragOver(event: DragOverEvent) {
    const { active, over } = event;
    if (!over || isColumnId(String(active.id))) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    const cols = columnsRef.current;
    const activeContainer = findContainerId(cols, activeId);
    const overContainer = findContainerId(cols, overId);
    if (
      !activeContainer ||
      !overContainer ||
      activeContainer === overContainer
    )
      return;

    const activeCol = cols.find((c) => c.id === activeContainer)!;
    const overCol = cols.find((c) => c.id === overContainer)!;
    const moved = activeCol.tasks.find((t) => t.id === activeId);
    if (!moved) return;

    const overIndex =
      overId === overContainer
        ? overCol.tasks.length
        : overCol.tasks.findIndex((t) => t.id === overId);
    const insertAt = overIndex < 0 ? overCol.tasks.length : overIndex;

    const next = cols.map((c) => {
      if (c.id === activeContainer) {
        return { ...c, tasks: c.tasks.filter((t) => t.id !== activeId) };
      }
      if (c.id === overContainer) {
        const tasks = [...c.tasks];
        tasks.splice(insertAt, 0, { ...moved, column_id: overContainer });
        return { ...c, tasks };
      }
      return c;
    });
    setColumns(next);
  }

  function onColumnDragEnd(activeId: string, overId: string) {
    const cols = columnsRef.current;
    const oldIndex = cols.findIndex((c) => columnSortId(c.id) === activeId);
    const newIndex = cols.findIndex((c) => columnSortId(c.id) === overId);
    if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex || !currentBoardId) return;
    const next = arrayMove(cols, oldIndex, newIndex);
    setColumns(next);
    const boardId = currentBoardId;
    void (async () => {
      try {
        await api.reorderColumns(boardId, next.map((c) => c.id));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to reorder columns");
        await reload();
      }
    })();
  }

  function onDragEnd(event: DragEndEvent) {
    setActiveTask(null);
    const { active, over } = event;
    if (!over) return;
    if (isColumnId(String(active.id))) {
      onColumnDragEnd(String(active.id), String(over.id));
      return;
    }
    const activeId = String(active.id);
    const overId = String(over.id);
    const cols = columnsRef.current;
    const activeContainer = findContainerId(cols, activeId);
    const overContainer = findContainerId(cols, overId);
    if (!activeContainer || !overContainer) return;

    let next = cols;
    if (activeContainer === overContainer && activeId !== overId) {
      next = cols.map((c) => {
        if (c.id !== activeContainer) return c;
        const oldIndex = c.tasks.findIndex((t) => t.id === activeId);
        const newIndex =
          overId === overContainer
            ? c.tasks.length - 1
            : c.tasks.findIndex((t) => t.id === overId);
        if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return c;
        return { ...c, tasks: arrayMove(c.tasks, oldIndex, newIndex) };
      });
      setColumns(next);
    }

    // Persist final position.
    const finalCol = next.find((c) => c.tasks.some((t) => t.id === activeId));
    if (!finalCol) return;
    const index = finalCol.tasks.findIndex((t) => t.id === activeId);
    void (async () => {
      try {
        await api.moveTask(activeId, finalCol.id, index);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to move task");
        await reload();
      }
    })();
  }

  if (loading) {
    return (
      <div className="center-pad">
        <div className="spinner" />
      </div>
    );
  }

  const currentBoard = boards.find((b) => b.id === currentBoardId);
  const boardTotal = columns.reduce(
    (s, c) => s + c.tasks.reduce((ss, t) => ss + t.total_seconds, 0),
    0,
  );

  return (
    <div className="board-wrap">
      <div className="board-toolbar">
        <div className="board-select">
          <select
            value={currentBoardId ?? ""}
            onChange={(e) => switchBoard(e.target.value)}
          >
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <button className="btn ghost sm" onClick={onAddBoard}>
            + Board
          </button>
          {currentBoard && (
            <button
              className="btn ghost sm"
              onClick={onRenameBoard}
              title="Rename this board"
            >
              ✎ Rename
            </button>
          )}
          {currentBoard && (
            <button
              className="btn danger sm"
              onClick={onDeleteBoard}
              title="Delete this board"
            >
              🗑 Board
            </button>
          )}
        </div>
        <div className="board-total">
          Total tracked on this board:{" "}
          <strong>{formatDuration(boardTotal)}</strong>
        </div>
      </div>

      {error && <div className="banner-error">{error}</div>}

      {currentBoard && voiceAvailable && (
        <div className="voice-toggle-wrap">
          <button className="btn ghost sm" onClick={() => setVoiceOpen((v) => !v)}>
            {voiceOpen ? "▾" : "▸"} Add tasks via voice/text
          </button>
          {voiceOpen && (
            <VoiceInbox
              key={currentBoard.id}
              boardId={currentBoard.id}
              onApplied={reload}
            />
          )}
        </div>
      )}

      {!currentBoard ? (
        <div className="empty-block">
          No boards yet. Create your first board to get started.
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={columns.map((c) => columnSortId(c.id))}
            strategy={horizontalListSortingStrategy}
          >
          <div className="columns">
            {columns.map((column) => (
              <ColumnView
                key={column.id}
                column={column}
                nowMs={nowMs}
                busy={busy}
                onAddTask={(columnId) => setModal({ mode: "create", columnId })}
                onRenameColumn={onRenameColumn}
                onDeleteColumn={onDeleteColumn}
                onStart={onStart}
                onStop={onStop}
                onEdit={(task) => setModal({ mode: "edit", task })}
                onDelete={onDeleteTask}
                onHistory={(task) => setHistoryTask(task)}
                onNavigateToTask={onNavigateToTask}
              />
            ))}
            <button className="add-column" onClick={onAddColumn}>
              + Add column
            </button>
          </div>
          </SortableContext>

          <DragOverlay>
            {activeTask ? (
              <div className="card drag-overlay">
                <div className="card-title">{activeTask.title}</div>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      {modal && (
        <TaskModal
          mode={modal.mode}
          initial={modal.mode === "edit" ? modal.task : undefined}
          onCancel={() => setModal(null)}
          onSubmit={submitTask}
        />
      )}
      {historyTask && (
        <TimeLogModal
          task={historyTask}
          onClose={() => setHistoryTask(null)}
          onChange={reload}
        />
      )}
      {inputModal && (
        <InputModal
          title={inputModal.title}
          label={inputModal.label}
          submitLabel={inputModal.submitLabel}
          initial={inputModal.initial}
          onCancel={() => setInputModal(null)}
          onSubmit={inputModal.onSubmit}
        />
      )}
      {confirmModal && (
        <ConfirmModal
          title={confirmModal.title}
          message={confirmModal.message}
          onCancel={closeConfirm}
          onConfirm={confirmModal.onConfirm}
        />
      )}
    </div>
  );
}
