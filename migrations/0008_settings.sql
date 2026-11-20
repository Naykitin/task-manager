-- Per-user settings (Settings page) and "sign out everywhere".

-- Sessions (JWTs) issued before this instant are rejected.
ALTER TABLE users ADD COLUMN sessions_valid_after TEXT;

CREATE TABLE IF NOT EXISTS user_settings (
  user_id             TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- Voice/text task generation (Voice Inbox) is opt-in.
  voice_enabled       INTEGER NOT NULL DEFAULT 0 CHECK (voice_enabled IN (0, 1)),
  -- Stop a forgotten timer after this many hours (0 = never).
  auto_stop_hours     INTEGER NOT NULL DEFAULT 0 CHECK (auto_stop_hours BETWEEN 0 AND 72),
  -- Anthropic API key, AES-GCM encrypted with the SETTINGS_ENCRYPTION_KEY secret.
  anthropic_key_enc   TEXT,
  anthropic_key_last4 TEXT,
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
