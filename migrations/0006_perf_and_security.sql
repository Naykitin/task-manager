-- Migration 0006: Performance, Cleanup, and Foreign Key Indexes

-- 1. Index for oauth_tokens cleanup and grant listing
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_cleanup
  ON oauth_tokens(refresh_expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user_client
  ON oauth_tokens(user_id, client_id, created_at DESC);

-- 2. Index for oauth_codes cleanup and foreign keys
CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires
  ON oauth_codes(expires_at);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_client
  ON oauth_codes(client_id);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_user
  ON oauth_codes(user_id);

-- 3. Index for global mcp_audit_log cleanup
CREATE INDEX IF NOT EXISTS idx_mcp_audit_created
  ON mcp_audit_log(created_at);

-- 4. Composite index for api_keys list query (user_id + created_at)
CREATE INDEX IF NOT EXISTS idx_api_keys_user_created
  ON api_keys(user_id, created_at DESC);

-- 5. Foreign key index on tasks.origin_voice_note_id
CREATE INDEX IF NOT EXISTS idx_tasks_origin_voice_note
  ON tasks(origin_voice_note_id)
  WHERE origin_voice_note_id IS NOT NULL;

-- 6. Index on tasks.updated_at for search ordering
CREATE INDEX IF NOT EXISTS idx_tasks_updated_at
  ON tasks(updated_at DESC);
