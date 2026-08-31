-- Voice-note-to-task structuring + task links (Cloudflare D1 / SQLite)

PRAGMA foreign_keys = ON;

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

ALTER TABLE tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai_voice'));
ALTER TABLE tasks ADD COLUMN origin_voice_note_id TEXT REFERENCES voice_notes(id) ON DELETE SET NULL;

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
