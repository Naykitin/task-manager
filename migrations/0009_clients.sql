-- Clients: group boards per customer (or "personal") for separate time and
-- money reporting. Boards without a client keep working exactly as before.

CREATE TABLE IF NOT EXISTS clients (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT,
  is_personal INTEGER NOT NULL DEFAULT 0 CHECK (is_personal IN (0, 1)),
  -- Hourly rate in minor units (cents/kopeks); NULL = not billed.
  rate_minor  INTEGER CHECK (rate_minor IS NULL OR rate_minor >= 0),
  currency    TEXT NOT NULL DEFAULT 'USD',
  archived_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_clients_user ON clients(user_id);

ALTER TABLE boards ADD COLUMN client_id TEXT REFERENCES clients(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_boards_client ON boards(client_id) WHERE client_id IS NOT NULL;

-- Rate in force when the entry was started, so changing a client's rate never
-- rewrites past periods. NULL = fall back to the client's current rate.
ALTER TABLE time_entries ADD COLUMN rate_minor INTEGER;
ALTER TABLE time_entries ADD COLUMN currency TEXT;
