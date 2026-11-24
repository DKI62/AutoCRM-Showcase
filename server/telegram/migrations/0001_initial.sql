-- Run only against a new, dedicated server database after deployment approval.
CREATE TABLE devices (
  id TEXT PRIMARY KEY NOT NULL, token_hash TEXT UNIQUE NOT NULL,
  pair_hash TEXT UNIQUE, pair_expires INTEGER, chat_id TEXT, revoked INTEGER NOT NULL DEFAULT 0,
  timezone TEXT NOT NULL DEFAULT 'Europe/Moscow', quiet_start INTEGER NOT NULL DEFAULT 22, quiet_end INTEGER NOT NULL DEFAULT 8
);
CREATE TABLE remote_tasks (
  device_id TEXT NOT NULL REFERENCES devices(id), id TEXT NOT NULL, title TEXT NOT NULL,
  due_at INTEGER NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','done')),
  next_send INTEGER NOT NULL, pending_action TEXT, callback_token TEXT NOT NULL UNIQUE,
  PRIMARY KEY(device_id,id)
);
CREATE INDEX due_reminders ON remote_tasks(status,next_send);
CREATE TABLE remote_actions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL REFERENCES devices(id),
  task_id TEXT NOT NULL, action TEXT NOT NULL, due_at INTEGER, revision INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX actions_device ON remote_actions(device_id,seq);
CREATE TABLE webhook_updates(id INTEGER PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE pairing_limits(ip_hash TEXT PRIMARY KEY NOT NULL, window INTEGER NOT NULL, attempts INTEGER NOT NULL);
