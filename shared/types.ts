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
  // Aggregates joined in by the board/task endpoints:
  total_seconds: number; // sum of completed time entries
  running_entry: TimeEntry | null; // the active (unstopped) entry, if any
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

export interface ApiError {
  error: string;
}
