-- OAuth 2.1 (authorization code + PKCE) for remote MCP connectors.
-- Codes and tokens are stored only as SHA-256 hashes.

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT PRIMARY KEY,
  client_name   TEXT NOT NULL,
  redirect_uris TEXT NOT NULL, -- JSON array
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scopes         TEXT NOT NULL,
  expires_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id                 TEXT PRIMARY KEY,
  access_hash        TEXT NOT NULL UNIQUE,
  refresh_hash       TEXT NOT NULL UNIQUE,
  client_id          TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes             TEXT NOT NULL,
  access_expires_at  TEXT NOT NULL,
  refresh_expires_at TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at       TEXT,
  revoked_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_tokens(user_id);
