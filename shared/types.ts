// Types shared between the Worker API and the React client.
// The API returns exactly these shapes as JSON.

export interface User {
  id: string;
  email: string;
  created_at: string;
}

export interface Board {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
}

export interface Column {
  id: string;
  board_id: string;
  name: string;
  position: number;
}

export interface Task {
  id: string;
  column_id: string;
  title: string;
  description: string | null;
  position: number;
  created_at: string;
  updated_at: string;
  source: "manual" | "ai_voice";
  origin_voice_note_id: string | null;
  // Aggregates joined in by the board/task endpoints:
  total_seconds: number; // sum of completed time entries
  running_entry: TimeEntry | null; // the active (unstopped) entry, if any
  links: TaskLinkView[]; // this task's relations to other tasks
}

export interface TimeEntry {
  id: string;
  task_id: string;
  user_id: string;
  started_at: string; // ISO-8601 UTC
  ended_at: string | null; // null while running
  duration_seconds: number | null; // computed on stop
}

export interface ColumnWithTasks extends Column {
  tasks: Task[];
}

export interface BoardDetail extends Board {
  columns: ColumnWithTasks[];
}

// ---- Timesheet reporting shapes ----

export interface TimesheetTaskRow {
  task_id: string;
  task_title: string;
  board_id: string;
  board_name: string;
  duration_seconds: number;
}

export interface TimesheetDay {
  date: string; // YYYY-MM-DD (local timezone of report)
  total_seconds: number;
  tasks: TimesheetTaskRow[];
}

export interface TimesheetBoardTotal {
  board_id: string;
  board_name: string;
  duration_seconds: number;
}

export interface TimesheetTaskTotal {
  task_id: string;
  task_title: string;
  board_id: string;
  board_name: string;
  duration_seconds: number;
}

export interface TimesheetResponse {
  start: string; // YYYY-MM-DD inclusive
  end: string; // YYYY-MM-DD inclusive
  total_seconds: number;
  in_progress_seconds: number; // running timer, shown separately, NOT in total
  days: TimesheetDay[];
  by_board: TimesheetBoardTotal[];
  by_task: TimesheetTaskTotal[];
}

// ---- Voice-note structuring ----

export type RelationType = "blocks" | "related" | "duplicate";

export interface VoiceNote {
  id: string;
  user_id: string;
  audio_url: string | null;
  transcript: string;
  status: "pending" | "reviewed" | "discarded";
  created_at: string;
  reviewed_at: string | null;
}

export interface TaskLink {
  id: string;
  from_task_id: string;
  to_task_id: string;
  relation_type: RelationType;
  created_at: string;
}

/** A task's relation to one other task, from that task's own point of view. */
export interface TaskLinkView {
  task_id: string; // the OTHER task's id
  title: string; // the OTHER task's title
  relation_type: RelationType;
  // outgoing: this task is from_task_id (e.g. "this blocks that").
  // incoming: this task is to_task_id (e.g. "this is blocked by that").
  direction: "outgoing" | "incoming";
}

// ---- Project snapshot (context fed to the AI structuring prompt) ----

export interface ProjectSnapshotTask {
  id: string;
  title: string;
  description: string | null;
  source: Task["source"];
}

export interface ProjectSnapshotColumn {
  id: string;
  name: string;
  tasks: ProjectSnapshotTask[];
}

export interface ProjectSnapshotBoard {
  id: string;
  name: string;
  columns: ProjectSnapshotColumn[];
}

export interface ProjectSnapshot {
  boards: ProjectSnapshotBoard[];
  links: TaskLink[];
}

// ---- AI structuring result (response of POST /api/voice-notes/:id/structure) ----

export type VoiceLinkDirection = "this_blocks_that" | "that_blocks_this";

export interface StructuredLink {
  task_id: string;
  relation_type: RelationType;
  direction: VoiceLinkDirection;
}

export interface StructuredNewTask {
  title: string;
  description: string;
  suggested_board: string;
  suggested_column: string;
  links: StructuredLink[];
  confidence: "high" | "medium" | "low";
}

export interface StructuredOpenQuestion {
  question: string;
  context: string;
}

export interface StructuringResult {
  new_tasks: StructuredNewTask[];
  open_questions: StructuredOpenQuestion[];
}

// ---- Applying reviewed voice-note suggestions (request of POST /api/voice-notes/:id/apply) ----

export type ApplyLinkInput = StructuredLink;

export interface ApplyNewTaskInput {
  title: string;
  description?: string;
  column_id: string;
  links?: ApplyLinkInput[];
}

export interface ApiError {
  error: string;
}
