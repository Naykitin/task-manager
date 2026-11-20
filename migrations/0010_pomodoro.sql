-- Pomodoro: a schedule layered on the normal timer. Focus intervals are
-- ordinary time_entries; breaks record nothing.

-- Pomodoro is opt-in per board (the button is hidden everywhere else).
ALTER TABLE boards ADD COLUMN pomodoro_enabled INTEGER NOT NULL DEFAULT 0 CHECK (pomodoro_enabled IN (0, 1));

ALTER TABLE user_settings ADD COLUMN pomo_focus_min  INTEGER NOT NULL DEFAULT 25 CHECK (pomo_focus_min  BETWEEN 1 AND 180);
ALTER TABLE user_settings ADD COLUMN pomo_short_min  INTEGER NOT NULL DEFAULT 5  CHECK (pomo_short_min  BETWEEN 1 AND 60);
ALTER TABLE user_settings ADD COLUMN pomo_long_min   INTEGER NOT NULL DEFAULT 15 CHECK (pomo_long_min   BETWEEN 1 AND 120);
ALTER TABLE user_settings ADD COLUMN pomo_long_every INTEGER NOT NULL DEFAULT 4  CHECK (pomo_long_every BETWEEN 2 AND 12);
ALTER TABLE user_settings ADD COLUMN pomo_auto_start INTEGER NOT NULL DEFAULT 0  CHECK (pomo_auto_start IN (0, 1));

-- The user's single active Pomodoro session. Times are absolute timestamps:
-- clients compute the remaining time themselves, nothing ticks on the server.
CREATE TABLE IF NOT EXISTS pomodoro_sessions (
  user_id          TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  task_id          TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  phase            TEXT NOT NULL CHECK (phase IN ('focus', 'short_break', 'long_break')),
  -- running: phase_ends_at set | paused / waiting: remaining_ms set
  status           TEXT NOT NULL CHECK (status IN ('running', 'paused', 'waiting')),
  phase_started_at TEXT,
  phase_ends_at    TEXT,
  remaining_ms     INTEGER,
  cycle            INTEGER NOT NULL DEFAULT 0, -- focus intervals completed in this session
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_pomodoro_sessions_task ON pomodoro_sessions(task_id);

-- One row per focus interval that ran to completion (the tomato count).
CREATE TABLE IF NOT EXISTS pomodoro_done (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  completed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pomodoro_done_task ON pomodoro_done(task_id);
CREATE INDEX IF NOT EXISTS idx_pomodoro_done_user ON pomodoro_done(user_id, completed_at);
