-- Add a per-user clock-display preference. Defaults to 0 (12-hour); existing
-- rows keep the default until the client writes an explicit choice.
ALTER TABLE user_settings ADD COLUMN use_24_hour INTEGER NOT NULL DEFAULT 0;
