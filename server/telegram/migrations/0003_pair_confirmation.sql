ALTER TABLE devices ADD COLUMN pairing_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE devices ADD COLUMN pair_request_id TEXT;
ALTER TABLE devices ADD COLUMN pair_chat_id TEXT;
ALTER TABLE devices ADD COLUMN pair_display_name TEXT;
ALTER TABLE devices ADD COLUMN pair_username TEXT;

-- Invalidate outstanding legacy links, including during the deployment gap.
-- Keep their expiry for the existing Cron cleanup and leave bound devices untouched.
UPDATE devices SET pair_hash=NULL WHERE chat_id IS NULL;
