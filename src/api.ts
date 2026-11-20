import type {
  ApplyNewTaskInput,
  Board,
  BoardDetail,
  ChecklistItem,
  Client,
  Column,
  StructuringResult,
  Task,
  TimeEntry,
  TimesheetResponse,
  User,
  VoiceNote,
} from "../shared/types.ts";

export interface ImportResult {
  dry_run: boolean;
  format: "full" | "timesheet";
  rows: number;
  imported: number;
  skipped_duplicates: number;
  created_boards: number;
  created_tasks: number;
  invalid: number;
  problems: { line: number; reason: string }[];
}

import { clientId } from "./live.ts";

export interface AppSettings {
  voice_enabled: boolean;
  auto_stop_hours: number;
  anthropic: { configured: boolean; source: "user" | "server" | null; last4: string | null };
  encryption_available: boolean;
}

export interface ClientInput {
  name: string;
  color?: string | null;
  is_personal?: boolean;
  rate_minor?: number | null;
  currency?: string;
}

/** "" = all clients, "none" = boards without a client, else a client id. */
const clientQuery = (id: string) => (id ? `&client_id=${encodeURIComponent(id)}` : "");

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
  // x-client-id lets the server skip echoing our own change back to this tab.
  const headers: Record<string, string> = {
    "x-client-id": clientId,
    ...(options.body != null ? { "content-type": "application/json" } : {}),
    ...((options.headers as Record<string, string> | undefined) ?? {}),
  };
  const res = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers,
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
  createBoard: (name: string, client_id?: string | null) =>
    request<{ board: Board }>("/api/boards", {
      method: "POST",
      body: JSON.stringify({ name, client_id }),
    }),
  getBoard: (id: string) => request<{ board: BoardDetail }>(`/api/boards/${id}`),
  updateBoard: (id: string, patch: { name?: string; client_id?: string | null }) =>
    request<{ board: Board }>(`/api/boards/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
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
  reorderColumns: (boardId: string, column_ids: string[]) =>
    request<{ columns: Column[] }>(`/api/boards/${boardId}/columns/order`, {
      method: "PUT",
      body: JSON.stringify({ column_ids }),
    }),
  deleteColumn: (id: string) =>
    request<{ ok: true }>(`/api/columns/${id}`, { method: "DELETE" }),

  // ---- Clients ----
  listClients: () => request<{ clients: Client[] }>("/api/clients"),
  createClient: (body: ClientInput) =>
    request<{ client: Client }>("/api/clients", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateClient: (id: string, patch: Partial<ClientInput> & { archived?: boolean }) =>
    request<{ client: Client }>(`/api/clients/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteClient: (id: string) =>
    request<{ ok: true }>(`/api/clients/${id}`, { method: "DELETE" }),

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
  addChecklistItems: (taskId: string, items: string[]) =>
    request<{ items: ChecklistItem[] }>(`/api/tasks/${taskId}/checklist`, {
      method: "POST",
      body: JSON.stringify({ items }),
    }),
  updateChecklistItem: (id: string, patch: { text?: string; done?: boolean }) =>
    request<{ item: ChecklistItem }>(`/api/checklist/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteChecklistItem: (id: string) =>
    request<{ ok: true }>(`/api/checklist/${id}`, { method: "DELETE" }),
  reorderChecklist: (taskId: string, item_ids: string[]) =>
    request<{ items: ChecklistItem[] }>(`/api/tasks/${taskId}/checklist/order`, {
      method: "PUT",
      body: JSON.stringify({ item_ids }),
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
  getVoiceAvailability: () =>
    request<{ available: boolean }>("/api/voice-notes/availability"),
  listVoiceNotes: (status?: VoiceNote["status"]) =>
    request<{ notes: VoiceNote[] }>(
      status ? `/api/voice-notes?status=${status}` : "/api/voice-notes",
    ),
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
  discardVoiceNote: (id: string) =>
    request<{ ok: true }>(`/api/voice-notes/${id}/discard`, { method: "POST" }),

  // ---- Settings & account ----
  getSettings: () => request<AppSettings>("/api/settings"),
  updateSettings: (patch: { voice_enabled?: boolean; auto_stop_hours?: number }) =>
    request<AppSettings>("/api/settings", { method: "PATCH", body: JSON.stringify(patch) }),
  saveAnthropicKey: (key: string) =>
    request<AppSettings>("/api/settings/anthropic-key", {
      method: "PUT",
      body: JSON.stringify({ key }),
    }),
  deleteAnthropicKey: () =>
    request<AppSettings>("/api/settings/anthropic-key", { method: "DELETE" }),
  changePassword: (current_password: string, new_password: string) =>
    request<{ ok: true }>("/api/account/password", {
      method: "POST",
      body: JSON.stringify({ current_password, new_password }),
    }),
  signOutEverywhere: () =>
    request<{ ok: true }>("/api/account/sign-out-everywhere", { method: "POST" }),

  // ---- Time entry backup ----
  timeEntriesExportUrl: "/api/time-entries/export",
  importTimeEntries: (csv: string, dry_run: boolean) =>
    request<ImportResult>("/api/time-entries/import", {
      method: "POST",
      body: JSON.stringify({
        csv,
        dry_run,
        tz_offset_minutes: -new Date().getTimezoneOffset(),
      }),
    }),

  // ---- Timesheet ----
  timesheet: (start: string, end: string, clientId = "") => {
    const tzOffset = -new Date().getTimezoneOffset();
    return request<TimesheetResponse>(
      `/api/timesheet?start=${start}&end=${end}&tzOffset=${tzOffset}${clientQuery(clientId)}`,
    );
  },
  timesheetExportUrl: (start: string, end: string, clientId = "") => {
    const tzOffset = -new Date().getTimezoneOffset();
    return `/api/timesheet/export?start=${start}&end=${end}&tzOffset=${tzOffset}${clientQuery(clientId)}`;
  },

  // ---- Integrations (MCP) ----
  listApiKeys: () => request<{ keys: ApiKeyInfo[] }>("/api/api-keys"),
  createApiKey: (name: string, scopes: McpScope[]) =>
    request<{ id: string; name: string; scopes: McpScope[]; key: string }>(
      "/api/api-keys",
      { method: "POST", body: JSON.stringify({ name, scopes }) },
    ),
  revokeApiKey: (id: string) =>
    request<{ ok: true }>(`/api/api-keys/${id}`, { method: "DELETE" }),
  listGrants: () => request<{ grants: OAuthGrant[] }>("/api/oauth/grants"),
  revokeGrant: (clientId: string) =>
    request<{ ok: true }>(`/api/oauth/grants/${clientId}`, { method: "DELETE" }),
  mcpActivity: (limit = 100) =>
    request<{ activity: McpActivity[] }>(`/api/mcp/activity?limit=${limit}`),
};

export type McpScope = "read" | "write" | "delete";

export interface ApiKeyInfo {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface OAuthGrant {
  client_id: string;
  client_name: string;
  scopes: string | null;
  connected_at: string;
  last_used_at: string | null;
}

export interface McpActivity {
  id: string;
  source: "api_key" | "oauth";
  credential: string;
  tool: string;
  ok: number;
  error: string | null;
  created_at: string;
}
