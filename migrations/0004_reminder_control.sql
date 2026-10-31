CREATE TABLE reminder_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 0,
  changed_at INTEGER,
  tick_id TEXT,
  last_tick_started_at INTEGER,
  last_tick_finished_at INTEGER,
  last_tick_status TEXT CHECK (last_tick_status IN ('running', 'completed', 'error'))
);
INSERT INTO reminder_control (id) VALUES (1);
