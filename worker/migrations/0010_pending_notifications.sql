CREATE TABLE pending_notifications (
  note_id TEXT PRIMARY KEY,
  kinds INTEGER NOT NULL,
  actor TEXT,
  actor_endpoint TEXT,
  title_hint TEXT,
  editing_until INTEGER NOT NULL DEFAULT 0,
  editing_client_id TEXT,
  last_change_at INTEGER NOT NULL
);
CREATE INDEX idx_pending_due ON pending_notifications(editing_until);
