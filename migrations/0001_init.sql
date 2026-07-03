-- Task Manager schema (Cloudflare D1 / SQLite)
-- Applied with:  wrangler d1 execute task-manager-db --local  --file=./schema.sql
--            or  wrangler d1 execute task-manager-db --remote --file=./schema.sql
--
-- This file is idempotent (CREATE TABLE IF NOT EXISTS) so it doubles as the
-- migration in migrations/0001_init.sql.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS boards (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_boards_user ON boards(user_id);

CREATE TABLE IF NOT EXISTS columns (
  id       TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_columns_board ON columns(board_id);

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  column_id   TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_column ON tasks(column_id);

CREATE TABLE IF NOT EXISTS time_entries (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at       TEXT NOT NULL,
  ended_at         TEXT,
  duration_seconds INTEGER
);
CREATE INDEX IF NOT EXISTS idx_time_entries_task ON time_entries(task_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_user ON time_entries(user_id);
-- Fast lookup of the single running timer for a user (ended_at IS NULL).
CREATE INDEX IF NOT EXISTS idx_time_entries_running
  ON time_entries(user_id) WHERE ended_at IS NULL;
-- Timesheet queries scan completed entries by user + start time.
CREATE INDEX IF NOT EXISTS idx_time_entries_user_started
  ON time_entries(user_id, started_at) WHERE ended_at IS NOT NULL;
