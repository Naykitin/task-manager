import type {
  ApplyNewTaskInput,
  Board,
  BoardDetail,
  Column,
  StructuringResult,
  Task,
  TimeEntry,
  TimesheetResponse,
  User,
  VoiceNote,
} from "../shared/types.ts";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers:
      options.body != null
        ? { "content-type": "application/json", ...(options.headers ?? {}) }
        : options.headers,
    ...options,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) message = data.error;
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  // ---- Auth ----
  register: (email: string, password: string, inviteCode: string) =>
    request<{ user: User }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, inviteCode }),
    }),
  login: (email: string, password: string) =>
    request<{ user: User }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  me: () => request<{ user: User }>("/api/auth/me"),

  // ---- Boards / columns ----
  listBoards: () => request<{ boards: Board[] }>("/api/boards"),
  createBoard: (name: string) =>
    request<{ board: Board }>("/api/boards", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  getBoard: (id: string) => request<{ board: BoardDetail }>(`/api/boards/${id}`),
  deleteBoard: (id: string) =>
    request<{ ok: true }>(`/api/boards/${id}`, { method: "DELETE" }),
  createColumn: (board_id: string, name: string) =>
    request<{ column: Column }>("/api/columns", {
      method: "POST",
      body: JSON.stringify({ board_id, name }),
    }),
  updateColumn: (id: string, patch: { name?: string; position?: number }) =>
    request<{ column: Column }>(`/api/columns/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteColumn: (id: string) =>
    request<{ ok: true }>(`/api/columns/${id}`, { method: "DELETE" }),

  // ---- Tasks ----
  createTask: (column_id: string, title: string, description?: string) =>
    request<{ task: Task }>("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ column_id, title, description }),
    }),
  updateTask: (id: string, patch: { title?: string; description?: string }) =>
    request<{ task: Task }>(`/api/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteTask: (id: string) =>
    request<{ ok: true }>(`/api/tasks/${id}`, { method: "DELETE" }),
  moveTask: (id: string, column_id: string, position: number) =>
    request<{ task: Task }>(`/api/tasks/${id}/move`, {
      method: "PATCH",
      body: JSON.stringify({ column_id, position }),
    }),

  // ---- Timer ----
  startTimer: (taskId: string) =>
    request<{ entry: TimeEntry; stopped: TimeEntry | null }>(
      `/api/tasks/${taskId}/timer/start`,
      { method: "POST" },
    ),
  stopTimer: (taskId: string) =>
    request<{ entry: TimeEntry }>(`/api/tasks/${taskId}/timer/stop`, {
      method: "POST",
    }),
  timeEntries: (taskId: string) =>
    request<{ entries: TimeEntry[] }>(`/api/tasks/${taskId}/time-entries`),
  addTimeEntry: (taskId: string, started_at: string, ended_at: string) =>
    request<{ entry: TimeEntry }>(`/api/tasks/${taskId}/time-entries`, {
      method: "POST",
      body: JSON.stringify({ started_at, ended_at }),
    }),
  updateTimeEntry: (
    id: string,
    patch: { started_at?: string; ended_at?: string },
  ) =>
    request<{ entry: TimeEntry }>(`/api/time-entries/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteTimeEntry: (id: string) =>
    request<{ ok: true }>(`/api/time-entries/${id}`, { method: "DELETE" }),

  // ---- Voice notes / AI structuring ----
  createVoiceNote: (transcript: string) =>
    request<{ note: VoiceNote }>("/api/voice-notes", {
      method: "POST",
      body: JSON.stringify({ transcript }),
    }),
  structureVoiceNote: (id: string, boardId: string) =>
    request<StructuringResult>(`/api/voice-notes/${id}/structure`, {
      method: "POST",
      body: JSON.stringify({ board_id: boardId }),
    }),
  applyVoiceNote: (id: string, new_tasks: ApplyNewTaskInput[]) =>
    request<{ tasks: Task[] }>(`/api/voice-notes/${id}/apply`, {
      method: "POST",
      body: JSON.stringify({ new_tasks }),
    }),

  // ---- Timesheet ----
  timesheet: (start: string, end: string) => {
    const tzOffset = -new Date().getTimezoneOffset();
    return request<TimesheetResponse>(
      `/api/timesheet?start=${start}&end=${end}&tzOffset=${tzOffset}`,
    );
  },
  timesheetExportUrl: (start: string, end: string) => {
    const tzOffset = -new Date().getTimezoneOffset();
    return `/api/timesheet/export?start=${start}&end=${end}&tzOffset=${tzOffset}`;
  },
};
