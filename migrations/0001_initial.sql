CREATE TABLE snapshots (
  message_id TEXT PRIMARY KEY,
  workspace_key TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_user_id TEXT,
  event_key TEXT NOT NULL,
  media_key TEXT,
  media_content_type TEXT,
  file_name TEXT,
  received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX snapshots_workspace_received
  ON snapshots (workspace_key, received_at DESC);

CREATE INDEX snapshots_expires
  ON snapshots (expires_at);

CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('message', 'text', 'conversation')),
  created_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX notes_workspace_created
  ON notes (workspace_key, created_at DESC);

CREATE TABLE note_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  source_message_id TEXT NOT NULL,
  source_user_id TEXT,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT,
  snapshot_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (note_id, source_message_id)
);

CREATE TABLE attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_item_id INTEGER NOT NULL REFERENCES note_items(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  content_type TEXT,
  file_name TEXT
);

PRAGMA foreign_keys = ON;
