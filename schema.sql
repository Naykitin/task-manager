-- Task Manager schema (Cloudflare D1 / SQLite)
-- Applied with:  wrangler d1 execute task-manager-db --local  --file=./schema.sql
--            or  wrangler d1 execute task-manager-db --remote --file=./schema.sql
--
-- This file is idempotent (CREATE TABLE IF NOT EXISTS) so it doubles as the
-- combined migrations/0001_init.sql + migrations/0002_voice_and_links.sql for
-- a fresh database. If you're upgrading an existing database instead, use
-- `wrangler d1 migrations apply` with the migrations/ folder — this file
-- defines the `tasks` columns inline rather than via ALTER TABLE, so it is
-- NOT safe to re-run against a database that already has the 0002 migration
-- applied.

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

-- Raw voice/text notes submitted for AI structuring, referenced by tasks.
-- Defined before `tasks` since tasks.origin_voice_note_id references it.
CREATE TABLE IF NOT EXISTS voice_notes (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  audio_url    TEXT,
  transcript   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'discarded')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  reviewed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_voice_notes_user_status ON voice_notes(user_id, status);

CREATE TABLE IF NOT EXISTS tasks (
  id                   TEXT PRIMARY KEY,
  column_id            TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
  title                TEXT NOT NULL,
  description          TEXT,
  position             INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  source               TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai_voice')),
  origin_voice_note_id TEXT REFERENCES voice_notes(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_column ON tasks(column_id);

-- Relations between tasks (blocks / related / duplicate), surfaced on task
-- cards. Populated manually or via the voice-note apply step.
CREATE TABLE IF NOT EXISTS task_links (
  id            TEXT PRIMARY KEY,
  from_task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  to_task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('blocks', 'related', 'duplicate')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (from_task_id, to_task_id, relation_type)
);
CREATE INDEX IF NOT EXISTS idx_task_links_from ON task_links(from_task_id);
CREATE INDEX IF NOT EXISTS idx_task_links_to ON task_links(to_task_id);

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
