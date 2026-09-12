CREATE TABLE reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_key TEXT NOT NULL,
  source_message_id TEXT NOT NULL UNIQUE,
  destination TEXT NOT NULL,
  text TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'accepted', 'cancelled', 'failed', 'expired', 'unknown')),
  retry_key TEXT NOT NULL UNIQUE,
  push_body TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  last_error TEXT,
  uncertain INTEGER NOT NULL DEFAULT 0,
  finished_at INTEGER
);
CREATE INDEX reminders_due ON reminders (status, due_at, lease_until);
CREATE INDEX reminders_workspace ON reminders (workspace_key, status, due_at, id);
CREATE INDEX reminders_finished ON reminders (finished_at);
