ALTER TABLE devices ADD COLUMN public_origin TEXT NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN app_scheme TEXT NOT NULL DEFAULT 'autocrm-showcase';
ALTER TABLE devices ADD COLUMN morning INTEGER NOT NULL DEFAULT 9;
ALTER TABLE devices ADD COLUMN evening INTEGER NOT NULL DEFAULT 19;
ALTER TABLE devices ADD COLUMN overdue INTEGER NOT NULL DEFAULT 1;
ALTER TABLE devices ADD COLUMN cold_days INTEGER NOT NULL DEFAULT 7;
ALTER TABLE devices ADD COLUMN archive_days INTEGER NOT NULL DEFAULT 14;
ALTER TABLE devices ADD COLUMN last_sync INTEGER;
ALTER TABLE devices ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX one_device_per_chat ON devices(chat_id) WHERE chat_id IS NOT NULL AND revoked=0;

ALTER TABLE remote_tasks ADD COLUMN vehicle_id TEXT;
ALTER TABLE remote_tasks ADD COLUMN vehicle TEXT;
ALTER TABLE remote_tasks ADD COLUMN stage TEXT;
ALTER TABLE remote_tasks ADD COLUMN call INTEGER NOT NULL DEFAULT 0;
ALTER TABLE remote_tasks ADD COLUMN since INTEGER;
ALTER TABLE remote_tasks ADD COLUMN promotable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE remote_tasks ADD COLUMN sent_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE remote_tasks ADD COLUMN callback_expires INTEGER NOT NULL DEFAULT 0;
ALTER TABLE remote_actions ADD COLUMN value TEXT;
ALTER TABLE remote_actions ADD COLUMN outcome TEXT;
ALTER TABLE remote_actions ADD COLUMN message_id INTEGER;
ALTER TABLE remote_actions ADD COLUMN notice_at INTEGER;
ALTER TABLE remote_actions ADD COLUMN source_update INTEGER;
CREATE UNIQUE INDEX one_action_per_update ON remote_actions(source_update) WHERE source_update IS NOT NULL;
CREATE INDEX pending_action_notices ON remote_actions(notice_at) WHERE notice_at IS NOT NULL;

CREATE TABLE bot_dialogs (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL, revision INTEGER NOT NULL,
  kind TEXT NOT NULL, expires INTEGER NOT NULL, due_at INTEGER, value TEXT, prompt_id INTEGER, offer_at INTEGER
);
CREATE TABLE bot_digests (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  slot TEXT NOT NULL, retry_at INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(device_id,slot)
);
CREATE TABLE bot_limits (scope TEXT PRIMARY KEY, window INTEGER NOT NULL, attempts INTEGER NOT NULL);
