-- Audit log of MCP tool calls (no arguments are stored).
CREATE TABLE IF NOT EXISTS mcp_audit_log (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source     TEXT NOT NULL CHECK (source IN ('api_key', 'oauth')),
  credential TEXT NOT NULL, -- API key name or OAuth client name
  tool       TEXT NOT NULL,
  ok         INTEGER NOT NULL DEFAULT 1,
  error      TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_user_time ON mcp_audit_log(user_id, created_at DESC);
